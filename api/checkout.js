// api/checkout.js
const START_DATE = "2026-10-26";

const FEE_RATES = {
  gcash: { label: "GCash (2.23%)", pct: 0.0223, fixed: 0, pmTypes: ["gcash"] },
  maya:  { label: "Maya / QR Ph (1.79%)", pct: 0.0179, fixed: 0, pmTypes: ["paymaya", "qrph"] },
  card:  { label: "Card (3.125% + ₱13.39)", pct: 0.03125, fixed: 13.39, pmTypes: ["card"] }
};

function getRateForHour(h) {
  return h >= 17 ? 500 : 450;
}

function getOperatingBounds(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const isWeekend = dow === 0 || dow === 6;
  return { open: 8, close: isWeekend ? 26 : 24 };
}

function hLabel(h) {
  const norm = ((h % 24) + 24) % 24;
  const s = norm >= 12 ? "PM" : "AM";
  const x = norm % 12 || 12;
  return `${x}:00${s}`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const secretKey = process.env.PAYMONGO_SECRET_KEY;
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  const scriptSecret = process.env.APPS_SCRIPT_SECRET || "";

  if (!secretKey) {
    return res.status(500).json({ error: "Server payment configuration missing" });
  }

  const authHeader = "Basic " + Buffer.from(secretKey + ":").toString("base64");

  // ----------------------------------------------------------------
  // 1. POST /api/checkout -> Validate inputs, lock slot, create PayMongo Checkout Session
  // ----------------------------------------------------------------
  if (req.method === "POST") {
    try {
      const { date, hours, name, email, phone, vehicle, method } = req.body || {};

      // Strict input validation
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < START_DATE) {
        return res.status(400).json({ error: "Bookings start October 26, 2026." });
      }
      if (!Array.isArray(hours) || hours.length < 1 || hours.length > 4) {
        return res.status(400).json({ error: "Select 1 to 4 consecutive hours." });
      }

      const sortedHours = [...hours].map(Number).sort((a, b) => a - b);
      const { open, close } = getOperatingBounds(date);
      for (let i = 0; i < sortedHours.length; i++) {
        const h = sortedHours[i];
        if (!Number.isInteger(h) || h < open || h >= close) {
          return res.status(400).json({ error: "Selected hour is outside operating hours." });
        }
        if (i > 0 && h !== sortedHours[i - 1] + 1) {
          return res.status(400).json({ error: "Selected hours must be consecutive." });
        }
      }

      const cleanName = String(name || "").trim().slice(0, 80);
      const cleanEmail = String(email || "").trim().slice(0, 100);
      const cleanPhone = String(phone || "").replace(/[\s-]/g, "");
      const cleanVehicle = ["None", "Car", "Motorcycle"].includes(vehicle) ? vehicle : "None";
      const feeCfg = FEE_RATES[method] || FEE_RATES.gcash;

      if (cleanName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail) || !/^(09|\+639)\d{9}$/.test(cleanPhone)) {
        return res.status(400).json({ error: "Invalid contact information." });
      }

      // Check real-time availability from Google Sheet before creating checkout
      if (scriptUrl) {
        const availRes = await fetch(
          `${scriptUrl}?action=availability&date=${encodeURIComponent(date)}&secret=${encodeURIComponent(scriptSecret)}`
        );
        const availData = await availRes.json();
        const taken = Array.isArray(availData.taken) ? availData.taken : [];
        if (sortedHours.some(h => taken.includes(h))) {
          return res.status(409).json({ error: "Sorry, one of those hours was just taken. Please pick another slot." });
        }
      }

      // Server-side price calculation (tamper-proof)
      const subtotal = sortedHours.reduce((sum, h) => sum + getRateForHour(h), 0);
      const gross = (subtotal + feeCfg.fixed) / (1 - feeCfg.pct);
      const fee = Math.ceil((gross - subtotal) * 100) / 100;
      const totalAmount = +(subtotal + fee).toFixed(2);
      const timeRange = `${hLabel(sortedHours[0])} –${hLabel(sortedHours[sortedHours.length - 1] + 1)}`;
      const ref = "TPS-" + Math.random().toString(36).slice(2, 6).toUpperCase() + Math.floor(100 + Math.random() * 899);

      const origin = req.headers.origin || `https://${req.headers.host}`;

      // Create official PayMongo Checkout Session
      const pmRes = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": authHeader
        },
        body: JSON.stringify({
          data: {
            attributes: {
              billing: { name: cleanName, email: cleanEmail, phone: cleanPhone },
              send_email_receipt: true,
              show_description: true,
              show_line_items: true,
              description: `The Pickle Shop Court (${date} ·${timeRange})`,
              line_items: [
                {
                  currency: "PHP",
                  amount: Math.round(subtotal * 100),
                  name: `Pickleball Court (${date} ·${timeRange})`,
                  quantity: 1
                },
                {
                  currency: "PHP",
                  amount: Math.round(fee * 100),
                  name: `Payment Processing Fee (${feeCfg.label})`,
                  quantity: 1
                }
              ],
              payment_method_types: feeCfg.pmTypes,
              success_url: `${origin}/?ref=${encodeURIComponent(ref)}`,
              cancel_url: `${origin}/?cancelled=1`,
              metadata: {
                ref,
                date,
                hours: JSON.stringify(sortedHours),
                timeRange,
                name: cleanName,
                email: cleanEmail,
                phone: cleanPhone,
                vehicle: cleanVehicle,
                subtotal: String(subtotal),
                fee: String(fee),
                amount: String(totalAmount),
                method
              }
            }
          }
        })
      });

      const pmData = await pmRes.json();
      if (!pmRes.ok) {
        console.error("PayMongo error:", pmData);
        return res.status(502).json({ error: pmData?.errors?.[0]?.detail || "Payment gateway error" });
      }

      const sessionId = pmData.data.id;
      const checkoutUrl = pmData.data.attributes.checkout_url;

      // Save pending session in Google Sheet (holds the slot for 5 mins so no double booking happens during payment)
      if (scriptUrl) {
        await fetch(scriptUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: scriptSecret,
            action: "create_pending",
            ref,
            sessionId,
            date,
            hours: sortedHours,
            timeRange,
            name: cleanName,
            phone: cleanPhone,
            email: cleanEmail,
            vehicle: cleanVehicle,
            subtotal,
            amount: totalAmount,
            method
          })
        });
      }

      return res.status(200).json({ checkoutUrl, ref });
    } catch (err) {
      console.error("Checkout POST error:", err);
      return res.status(500).json({ error: "Could not start checkout." });
    }
  }

  // ----------------------------------------------------------------
  // 2. GET /api/checkout?ref=TPS-XXXX -> Verify payment directly with PayMongo API
  // ----------------------------------------------------------------
  if (req.method === "GET") {
    const { ref } = req.query;
    if (!ref || !scriptUrl) {
      return res.status(400).json({ error: "Missing booking reference" });
    }

    try {
      // Look up the session ID from Google Sheet
      const lookupRes = await fetch(
        `${scriptUrl}?action=get_booking&ref=${encodeURIComponent(ref)}&secret=${encodeURIComponent(scriptSecret)}`
      );
      const lookupData = await lookupRes.json();
      if (!lookupData || !lookupData.booking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      const bk = lookupData.booking;

      // If already confirmed, return immediately
      if (bk.status === "confirmed") {
        return res.status(200).json({ verified: true, booking: bk });
      }

      // Query PayMongo directly using sessionId to verify real payment status
      const pmRes = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(bk.sessionId)}`, {
        headers: { "Accept": "application/json", "Authorization": authHeader }
      });
      const pmData = await pmRes.json();
      const payments = pmData?.data?.attributes?.payments || [];
      const isPaid = payments.some(p => p?.attributes?.status === "paid") ||
                     pmData?.data?.attributes?.payment_intent?.attributes?.status === "succeeded";

      if (!isPaid) {
        return res.status(402).json({ verified: false, error: "Payment has not been completed yet." });
      }

      // Mark confirmed in Google Sheet + auto-create Google Calendar event
      const confirmRes = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: scriptSecret,
          action: "confirm_booking",
          ref
        })
      });
      const confirmData = await confirmRes.json();

      if (confirmData.conflict) {
        return res.status(409).json({ error: "Slot conflict detected. Please contact support with your reference number." });
      }

      bk.status = "confirmed";
      return res.status(200).json({ verified: true, booking: bk });
    } catch (err) {
      console.error("Verify GET error:", err);
      return res.status(500).json({ error: "Verification failed" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}