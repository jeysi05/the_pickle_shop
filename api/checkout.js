const START_DATE = "2026-11-23";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://wxegmiohtbdlnnsjslxu.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4ZWdtaW9odGJkbG5uc2pzbHh1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODMwOTg1NywiZXhwIjoyMTAzODg1ODU3fQ.QpvvMA1mIaiXt-ukIxcmoIK-znQ_1FzUA7ssVKG57p4";

function sbHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

function sanitizePublicBooking(row) {
  if (!row) return null;
  const copy = { ...row };
  delete copy.receiptImage;
  delete copy.receipt_image;
  return copy;
}

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
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateKey;
}

function getHoursForDate(dateKey) {
  if (!isValidDateKey(dateKey)) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;
  return { open: 8, close: isWeekend ? 26 : 24 };
}

function validateAndSortHours(dateKey, hours) {
  if (!isValidDateKey(dateKey)) return { error: "Invalid booking date." };
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
  if (!apiKey || !dataUrl || !dataUrl.startsWith("data:image/")) return null;

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

  // GET /api/checkout?ref=PS-XXXX or ?lookup=PS-XXXX / 0917...
  if (req.method === "GET") {
    const rawRef = typeof req.query?.ref === "string" ? req.query.ref.trim() : "";
    const rawLookup = typeof req.query?.lookup === "string" ? req.query.lookup.trim() : "";
    const target = rawRef || rawLookup;

    if (!target) {
      return res.status(400).json({ error: "Missing booking reference." });
    }

    try {
      const compact = target.replace(/\s+/g, "").toUpperCase();
      let queryUrl = "";

      // 1. If it starts with PS (e.g. PS-EB5368 or PSEB5368), search by ref
      if (/^PS-?[A-Z0-9]+$/.test(compact)) {
        const normalizedRef = compact.startsWith("PS-")
          ? compact
          : `PS-${compact.slice(2)}`;
        queryUrl = `${SUPABASE_URL}/rest/v1/bookings?ref=ilike.${encodeURIComponent(normalizedRef)}&select=*`;
      } else {
        // 2. Otherwise treat as phone number (support both 09... and +639... formats)
        const digitsOnly = compact.replace(/\D/g, "");
        const last9 = digitsOnly.slice(-9); // e.g. 9761479617 -> 761479617
        if (last9.length >= 9) {
          const localFormat = `09${last9}`;
          const intlFormat = `+639${last9}`;
          queryUrl = `${SUPABASE_URL}/rest/v1/bookings?phone=in.(${encodeURIComponent(localFormat)},${encodeURIComponent(intlFormat)},${encodeURIComponent(compact)})&status=neq.rejected&order=at.desc&limit=1&select=*`;
        } else {
          queryUrl = `${SUPABASE_URL}/rest/v1/bookings?phone=eq.${encodeURIComponent(compact)}&status=neq.rejected&order=at.desc&limit=1&select=*`;
        }
      }

      const r = await fetch(queryUrl, { headers: sbHeaders() });
      const rows = await r.json();
      const found = Array.isArray(rows) && rows.length ? sanitizePublicBooking(rows[0]) : null;

      if (!found) {
        return res.status(404).json({ status: "not_found" });
      }

      return res.status(200).json({
        status: found.status || "payment_review",
        booking: found,
      });
    } catch (e) {
      return res.status(500).json({ error: "Error checking booking status." });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = req.body || {};

  if (body.action === "scan_receipt") {
    const scan = await analyzeReceiptWithGemini(body.receiptImage, body.expectedAmount);
    return res.status(200).json({ scan });
  }

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
      return res.status(400).json({ error: "Please attach your GCash payment receipt screenshot." });
    }

    const validation = validateAndSortHours(date, hours);
    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }
    const sortedHours = validation.sortedHours;

    const [dupResp, dateBookingsResp, dateBlocksResp] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/bookings?gcashRefNumber=eq.${encodeURIComponent(cleanRef)}&status=neq.rejected&select=ref`,
        { headers: sbHeaders() }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/bookings?date=eq.${encodeURIComponent(date)}&status=in.(confirmed,payment_review)&select=hours`,
        { headers: sbHeaders() }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/blocked_slots?date_key=eq.${encodeURIComponent(date)}&select=hour_num`,
        { headers: sbHeaders() }
      ),
    ]);

    const dupRows = await dupResp.json();
    if (Array.isArray(dupRows) && dupRows.length > 0) {
      return res.status(409).json({
        error: "This GCash Reference Number has already been submitted.",
      });
    }

    const existingBookings = await dateBookingsResp.json();
    const existingBlocks = await dateBlocksResp.json();
    const takenHours = new Set();

    if (Array.isArray(existingBookings)) {
      existingBookings.forEach((b) => {
        const hrs = Array.isArray(b.hours) ? b.hours : [];
        hrs.forEach((h) => takenHours.add(Number(h)));
      });
    }
    if (Array.isArray(existingBlocks)) {
      existingBlocks.forEach((bl) => takenHours.add(Number(bl.hour_num)));
    }

    if (sortedHours.some((h) => takenHours.has(h))) {
      return res.status(409).json({
        error: "One or more selected hours were just taken. Please pick another time.",
      });
    }

    const subtotal = sortedHours.reduce((sum, hour) => sum + priceForHour(hour), 0);
    const hasAfterMidnight = sortedHours.some((h) => h >= 24);
    const timeRange = `${hLabel(sortedHours[0])}–${hLabel(
      sortedHours[sortedHours.length - 1] + 1
    )}${hasAfterMidnight ? " (After MN)" : ""}`;

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

    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/bookings`, {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify(booking),
    });

    if (!insertResp.ok) {
      const errText = await insertResp.text();
      console.error("Supabase insert error:", errText);
      return res.status(500).json({ error: "Database error while saving booking." });
    }

    const insertedRows = await insertResp.json();
    const savedBooking = Array.isArray(insertedRows) && insertedRows[0] ? insertedRows[0] : booking;

    return res.status(200).json({ ok: true, booking: sanitizePublicBooking(savedBooking) });
  } catch (error) {
    console.error("Direct GCash checkout error:", error);
    return res.status(500).json({ error: "Server error while saving your booking." });
  }
}