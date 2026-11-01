// api/checkout.js
const START_DATE = "2026-11-23";

const memoryStore =
  globalThis.__tpsDirectStore ||
  (globalThis.__tpsDirectStore = {
    bookings: [],
    usedRefs: new Set(),
  });

function hLabel(hour) {
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized >= 12 ? "PM" : "AM";
  const hour12 = normalized % 12 || 12;
  return `${hour12}:00 ${suffix}`;
}

function priceForHour(hour) {
  return hour >= 17 ? 500 : 450;
}

function isValidDateKey(dateKey) {
  if (typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return false;
  }
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === dateKey
  );
}

function getHoursForDate(dateKey) {
  if (!isValidDateKey(dateKey)) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;
  return { open: 8, close: isWeekend ? 26 : 24 };
}

function validateAndSortHours(dateKey, hours) {
  if (!isValidDateKey(dateKey)) {
    return { error: "Invalid booking date." };
  }
  if (dateKey < START_DATE) {
    return { error: `Online bookings start on November 23, 2026 (${START_DATE}).` };
  }
  if (!Array.isArray(hours) || hours.length === 0) {
    return { error: "Select at least one booking hour." };
  }

  const sortedHours = hours.map(Number).sort((a, b) => a - b);
  if (!sortedHours.every(Number.isInteger)) {
    return { error: "The selected booking hours are invalid." };
  }
  if (new Set(sortedHours).size !== sortedHours.length) {
    return { error: "A booking cannot contain duplicate hours." };
  }

  const operatingHours = getHoursForDate(dateKey);
  const outsideHours = sortedHours.some(
    (hour) => hour < operatingHours.open || hour >= operatingHours.close
  );
  if (outsideHours) {
    return { error: "The selected hours fall outside the court's operating hours." };
  }

  for (let i = 1; i < sortedHours.length; i += 1) {
    if (sortedHours[i] !== sortedHours[i - 1] + 1) {
      return { error: "Please select consecutive booking hours." };
    }
  }

  return { sortedHours };
}

async function analyzeReceiptWithGemini(dataUrl, expectedAmount) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !dataUrl || !dataUrl.startsWith("data:image/")) {
    return null;
  }

  try {
    const [meta, base64Data] = dataUrl.split(",");
    const mimeMatch = meta.match(/data:(image\/[a-zA-Z0-9+.-]+);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

    const prompt = `Analyze this Philippine GCash or InstaPay payment receipt image. Return strictly valid JSON with keys:
{
  "isValidReceipt": boolean,
  "extractedAmount": number,
  "referenceNumber": string,
  "recipientText": string
}`;

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType, data: base64Data } },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    if (!resp.ok) return null;
    const json = await resp.json();
    const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(rawText);
    const extractedAmount = Number(parsed.extractedAmount || 0);
    return {
      isValidReceipt: !!parsed.isValidReceipt,
      extractedAmount,
      referenceNumber: String(parsed.referenceNumber || "").replace(/\D/g, ""),
      recipientText: String(parsed.recipientText || ""),
      amountMatches: Math.abs(extractedAmount - Number(expectedAmount)) < 1,
    };
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  const scriptSecret = process.env.APPS_SCRIPT_SECRET || "tps_secret_2026";
  const ownerEmail = process.env.OWNER_EMAIL || "erikacalimlim08029324@gmail.com";

  // GET /api/checkout?ref=PS-XXXX — Customer live status polling for instant confirmation notification
  if (req.method === "GET") {
    const ref = typeof req.query?.ref === "string" ? req.query.ref.trim() : "";
    if (!ref) {
      return res.status(400).json({ error: "Missing booking reference." });
    }

    let found = memoryStore.bookings.find((b) => b.ref === ref) || null;

    if ((!found || found.status !== "confirmed") && scriptUrl) {
      try {
        const r = await fetch(
          `${scriptUrl}?action=booking_status&ref=${encodeURIComponent(ref)}&secret=${encodeURIComponent(scriptSecret)}`
        );
        const data = await r.json();
        if (data && data.booking) {
          found = data.booking;
        }
      } catch (e) {}
    }

    if (!found) {
      return res.status(404).json({ status: "not_found" });
    }

    return res.status(200).json({
      status: found.status || "payment_review",
      booking: found,
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = req.body || {};

  // 1. Pre-scan receipt image with Gemini AI
  if (body.action === "scan_receipt") {
    const scan = await analyzeReceiptWithGemini(body.receiptImage, body.expectedAmount);
    return res.status(200).json({ scan });
  }

  // 2. Submit Direct GCash Booking -> Hold Slot & Notify Staff
  try {
    const {
      date,
      hours,
      name,
      email = "",
      phone,
      vehicle = "None",
      gcashRefNumber = "",
      receiptImage = "",
    } = body;

    const cleanRef = String(gcashRefNumber).replace(/\D/g, "");
    if (!date || !Array.isArray(hours) || !hours.length || !name || !phone) {
      return res.status(400).json({ error: "Missing required player details." });
    }
    if (!cleanRef || cleanRef.length < 8) {
      return res.status(400).json({ error: "Please enter a valid GCash Reference Number." });
    }
    if (!receiptImage) {
      return res.status(400).json({ error: "Please upload your GCash payment receipt screenshot." });
    }

    if (memoryStore.usedRefs.has(cleanRef)) {
      return res.status(409).json({
        error: "This GCash Reference Number has already been submitted.",
      });
    }

    const validation = validateAndSortHours(date, hours);
    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const sortedHours = validation.sortedHours;

    const conflict = memoryStore.bookings.some(
      (b) =>
        b.date === date &&
        (b.status === "confirmed" || b.status === "payment_review") &&
        Array.isArray(b.hours) &&
        b.hours.some((h) => sortedHours.includes(h))
    );
    if (conflict) {
      return res.status(409).json({
        error: "One or more selected hours were just taken. Please pick another time.",
      });
    }

    const subtotal = sortedHours.reduce((sum, hour) => sum + priceForHour(hour), 0);
    const timeRange = `${hLabel(sortedHours[0])}–${hLabel(
      sortedHours[sortedHours.length - 1] + 1
    )}`;

    const aiScan = await analyzeReceiptWithGemini(receiptImage, subtotal);
    const ref =
      "PS-" +
      Math.random().toString(36).slice(2, 6).toUpperCase() +
      Math.floor(10 + Math.random() * 89);

    const booking = {
      ref,
      date,
      hours: sortedHours,
      timeRange,
      name: String(name).trim(),
      email: String(email).trim(),
      phone: String(phone).trim(),
      vehicle,
      method: "gcash_qr",
      gcashRefNumber: cleanRef,
      receiptImage,
      aiPassed: aiScan ? !!(aiScan.isValidReceipt && aiScan.amountMatches) : true,
      subtotal,
      fee: 0,
      amount: subtotal,
      status: "payment_review",
      at: Date.now(),
    };

    memoryStore.usedRefs.add(cleanRef);
    memoryStore.bookings.push(booking);

    // Sync to Google Sheet Apps Script & trigger Staff Email Notification
    if (scriptUrl) {
      try {
        await fetch(scriptUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: scriptSecret,
            action: "record_booking",
            notifyOwner: true,
            ownerEmail,
            booking,
          }),
        });
      } catch (e) {
        console.error("Apps Script sync warning:", e);
      }
    }

    return res.status(200).json({ ok: true, booking });
  } catch (error) {
    console.error("Direct GCash checkout error:", error);
    return res.status(500).json({ error: "Server error while saving your booking." });
  }
}