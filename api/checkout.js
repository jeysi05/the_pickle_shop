// api/checkout.js
const FEE_RATES = {
  gcash: { label: "GCash (2.23%)", pct: 0.0223, fixed: 0, pmTypes: ["gcash"] },
  maya:  { label: "Maya / QR Ph (1.79%)", pct: 0.0179, fixed: 0, pmTypes: ["paymaya", "qrph"] },
  card:  { label: "Card (3.125% + ₱13.39)", pct: 0.03125, fixed: 13.39, pmTypes: ["card"] }
};

function hLabel(h) {
  const norm = ((h % 24) + 24) % 24;
  const s = norm >= 12 ? "PM" : "AM";
  const x = norm % 12 || 12;
  return `${x}:00${s}`;
}

function priceForHour(h) {
  return h >= 17 ? 500 : 450;
}

// Temporary memory cache for warm serverless instances
const sessionStore = globalThis.__tpsSessionStore || (globalThis.__tpsSessionStore = new Map());

export default async function handler(req, res) {
  const secretKey = process.env.PAYMONGO_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: "PAYMONGO_SECRET_KEY is not configured in Vercel." });
  }

  const authHeader = "Basic " + Buffer.from(secretKey + ":").toString("base64");

  // =========================================================================
  // 1. POST /api/checkout — Create a Live PayMongo Checkout Session
  // =========================================================================
  if (req.method === "POST") {
    try {
      const { date, hours, method = "gcash", name, email, phone, vehicle = "None" } = req.body || {};

      if (!date || !Array.isArray(hours) || !hours.length || !name || !email || !phone) {
        return res.status(400).json({ error: "Missing required booking details." });
      }

      const sortedHours = [...hours].map(Number).sort((a, b) => a - b);
      const timeRange = `${hLabel(sortedHours[0])}–${hLabel(sortedHours[sortedHours.length - 1] + 1)}`;

      // Calculate exact court subtotal & customer-passed PayMongo fee
      const subtotal = sortedHours.reduce((sum, h) => sum + priceForHour(h), 0);
      const cfg = FEE_RATES[method] || FEE_RATES.gcash;
      const gross = (subtotal + cfg.fixed) / (1 - cfg.pct);
      const fee = Math.ceil((gross - subtotal) * 100) / 100;
      const total = +(subtotal + fee).toFixed(2);

      const ref = "PS-" + Math.random().toString(36).slice(2, 6).toUpperCase() + Math.floor(10 + Math.random() * 89);

      const protocol = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const origin = `${protocol}://${host}`;

      const payload = {
        data: {
          attributes: {
            billing: { name, email, phone },
            send_email_receipt: true,
            show_description: true,
            show_line_items: true,
            reference_number: ref,
            description: `The Pickle Shop Court Booking (${date} · ${timeRange})`,
            payment_method_types: cfg.pmTypes,
            line_items: [
              {
                currency: "PHP",
                amount: Math.round(subtotal * 100),
                name: `Pickleball Court (${date} · ${timeRange})`,
                quantity: 1
              },
              {
                currency: "PHP",
                amount: Math.round(fee * 100),
                name: `Payment Processing Fee (${cfg.label})`,
                quantity: 1
              }
            ],
            success_url: `${origin}/?ref=${encodeURIComponent(ref)}`,
            cancel_url: `${origin}/?cancelled=1`,
            metadata: {
              ref,
              date,
              hours: JSON.stringify(sortedHours),
              timeRange,
              name,
              email,
              phone,
              vehicle,
              method,
              subtotal: String(subtotal),
              fee: String(fee),
              amount: String(total)
            }
          }
        }
      };

      const pmRes = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": authHeader
        },
        body: JSON.stringify(payload)
      });

      const pmData = await pmRes.json();
      if (!pmRes.ok) {
        const msg = pmData?.errors?.[0]?.detail || "PayMongo checkout creation failed.";
        return res.status(400).json({ error: msg });
      }

      const sessionId = pmData.data.id;
      const checkoutUrl = pmData.data.attributes.checkout_url;

      sessionStore.set(ref, sessionId);

      return res.status(200).json({
        ref,
        sessionId,
        checkoutUrl
      });
    } catch (err) {
      return res.status(500).json({ error: "Server error while creating PayMongo session." });
    }
  }

  // =========================================================================
  // 2. GET /api/checkout?ref=...&cs=... — Verify Payment on Return
  // =========================================================================
  if (req.method === "GET") {
    try {
      const { ref, cs } = req.query;
      const sessionId = cs || sessionStore.get(ref);

      if (!sessionId) {
        return res.status(400).json({ error: "Missing session ID for verification." });
      }

      const pmRes = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "Authorization": authHeader
        }
      });

      const pmData = await pmRes.json();
      if (!pmRes.ok || !pmData?.data) {
        return res.status(400).json({ error: "Unable to retrieve payment status from PayMongo." });
      }

      const attrs = pmData.data.attributes;
      const payments = attrs.payments || [];
      const isPaid =
        attrs.payment_intent?.attributes?.status === "succeeded" ||
        payments.some(p => p?.attributes?.status === "paid");

      if (!isPaid) {
        return res.status(400).json({ verified: false, error: "Payment is not yet completed." });
      }

      const meta = attrs.metadata || {};
      const booking = {
        ref: meta.ref || attrs.reference_number || ref,
        date: meta.date,
        hours: meta.hours ? JSON.parse(meta.hours) : [],
        timeRange: meta.timeRange || "",
        name: meta.name || attrs.billing?.name || "Player",
        email: meta.email || attrs.billing?.email || "",
        phone: meta.phone || attrs.billing?.phone || "",
        vehicle: meta.vehicle || "None",
        method: meta.method || "gcash",
        subtotal: Number(meta.subtotal || 0),
        fee: Number(meta.fee || 0),
        amount: Number(meta.amount || 0),
        status: "confirmed",
        at: Date.now()
      };

      return res.status(200).json({ verified: true, booking });
    } catch (err) {
      return res.status(500).json({ error: "Error verifying payment." });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}