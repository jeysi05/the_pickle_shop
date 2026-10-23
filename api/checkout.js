const FEE_RATES = {
  gcash: {
    label: "GCash / QR Ph (2.23%)",
    pct: 0.0223,
    fixed: 0,
    pmTypes: ["gcash", "qrph"],
  },
  maya: {
    label: "Maya / QR Ph (1.79%)",
    pct: 0.0179,
    fixed: 0,
    pmTypes: ["paymaya", "qrph"],
  },
  card: {
    label: "Card (3.125% + ₱13.39)",
    pct: 0.03125,
    fixed: 13.39,
    pmTypes: ["card", "qrph"],
  },
};

const START_DATE = "2026-10-26";

// This store is temporary. The frontend also passes the session ID back
// during payment verification because serverless instances may be recycled.
const sessionStore =
  globalThis.__tpsSessionStore ||
  (globalThis.__tpsSessionStore = new Map());

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

  // UTC is used only to calculate the weekday from the YYYY-MM-DD date key,
  // so the Vercel server's timezone cannot change the operating-hours rules.
  const [year, month, day] = dateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;

  // Hour values are slot start times. 24 = midnight; 25 = 1:00 AM next day.
  return { open: 8, close: isWeekend ? 26 : 24 };
}

function validateAndSortHours(dateKey, hours) {
  if (!isValidDateKey(dateKey)) {
    return { error: "Invalid booking date." };
  }

  if (dateKey < START_DATE) {
    return { error: `Online bookings start on ${START_DATE}.` };
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

  // Intentionally no MAX_HOURS check: bookings can span any number of
  // consecutive open hours, up to the court's closing time.
  for (let i = 1; i < sortedHours.length; i += 1) {
    if (sortedHours[i] !== sortedHours[i - 1] + 1) {
      return { error: "Please select consecutive booking hours." };
    }
  }

  return { sortedHours };
}

function calculateFee(subtotal, method) {
  const config = FEE_RATES[method] || FEE_RATES.gcash;
  const gross = (subtotal + config.fixed) / (1 - config.pct);
  const fee = Math.ceil((gross - subtotal) * 100) / 100;

  return {
    fee,
    total: Number((subtotal + fee).toFixed(2)),
    config,
  };
}

export default async function handler(req, res) {
  const secretKey = process.env.PAYMONGO_SECRET_KEY;

  if (!secretKey) {
    return res.status(500).json({
      error: "PAYMONGO_SECRET_KEY is not configured in Vercel.",
    });
  }

  const authHeader =
    "Basic " + Buffer.from(`${secretKey}:`).toString("base64");

  // POST /api/checkout — create a PayMongo Checkout Session.
  if (req.method === "POST") {
    try {
      const {
        date,
        hours,
        method = "gcash",
        name,
        email,
        phone,
        vehicle = "None",
      } = req.body || {};

      if (
        !date ||
        !Array.isArray(hours) ||
        !hours.length ||
        !name ||
        !email ||
        !phone
      ) {
        return res.status(400).json({
          error: "Missing required booking details.",
        });
      }

      const validation = validateAndSortHours(date, hours);
      if (validation.error) {
        return res.status(400).json({ error: validation.error });
      }

      const sortedHours = validation.sortedHours;
      const timeRange = `${hLabel(sortedHours[0])}–${hLabel(
        sortedHours[sortedHours.length - 1] + 1
      )}`;

      // Price every selected hour, so longer bookings are charged correctly.
      const subtotal = sortedHours.reduce(
        (sum, hour) => sum + priceForHour(hour),
        0
      );
      const { fee, total, config } = calculateFee(subtotal, method);

      const ref =
        "PS-" +
        Math.random().toString(36).slice(2, 6).toUpperCase() +
        Math.floor(10 + Math.random() * 89);

      const protocol = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers["x-forwarded-host"] || req.headers.host;

      if (!host) {
        return res.status(500).json({ error: "Unable to determine website URL." });
      }

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
            payment_method_types: config.pmTypes,
            line_items: [
              {
                currency: "PHP",
                amount: Math.round(subtotal * 100),
                name: `Pickleball Court (${date} · ${timeRange})`,
                quantity: 1,
              },
              {
                currency: "PHP",
                amount: Math.round(fee * 100),
                name: `Payment Processing Fee (${config.label})`,
                quantity: 1,
              },
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
              amount: String(total),
            },
          },
        },
      };

      const payMongoResponse = await fetch(
        "https://api.paymongo.com/v1/checkout_sessions",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify(payload),
        }
      );

      const payMongoData = await payMongoResponse.json();

      if (!payMongoResponse.ok) {
        const message =
          payMongoData?.errors?.[0]?.detail ||
          "PayMongo checkout creation failed.";
        return res.status(400).json({ error: message });
      }

      const sessionId = payMongoData?.data?.id;
      const checkoutUrl = payMongoData?.data?.attributes?.checkout_url;

      if (!sessionId || !checkoutUrl) {
        return res.status(502).json({
          error: "PayMongo did not return a valid checkout session.",
        });
      }

      sessionStore.set(ref, sessionId);

      return res.status(200).json({ ref, sessionId, checkoutUrl });
    } catch (error) {
      console.error("PayMongo checkout creation error:", error);
      return res.status(500).json({
        error: "Server error while creating PayMongo checkout.",
      });
    }
  }

  // GET /api/checkout?ref=...&cs=... — verify payment after checkout return.
  if (req.method === "GET") {
    try {
      const ref = typeof req.query?.ref === "string" ? req.query.ref : "";
      const clientSessionId =
        typeof req.query?.cs === "string" ? req.query.cs : "";
      const sessionId = clientSessionId || sessionStore.get(ref);

      if (!sessionId) {
        return res.status(400).json({
          error: "Missing session ID for verification.",
        });
      }

      const payMongoResponse = await fetch(
        `https://api.paymongo.com/v1/checkout_sessions/${encodeURIComponent(
          sessionId
        )}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: authHeader,
          },
        }
      );

      const payMongoData = await payMongoResponse.json();

      if (!payMongoResponse.ok || !payMongoData?.data) {
        return res.status(400).json({
          error: "Unable to retrieve payment status from PayMongo.",
        });
      }

      const attributes = payMongoData.data.attributes || {};
      const payments = attributes.payments || [];
      const isPaid =
        attributes.payment_intent?.attributes?.status === "succeeded" ||
        payments.some((payment) => payment?.attributes?.status === "paid");

      if (!isPaid) {
        return res.status(400).json({
          verified: false,
          error: "Payment is not yet completed.",
        });
      }

      const metadata = attributes.metadata || {};
      let bookedHours = [];

      try {
        bookedHours = metadata.hours ? JSON.parse(metadata.hours) : [];
      } catch {
        return res.status(500).json({
          error: "Booking hours in the payment metadata are invalid.",
        });
      }

      const booking = {
        ref: metadata.ref || attributes.reference_number || ref,
        date: metadata.date,
        hours: bookedHours,
        timeRange: metadata.timeRange || "",
        name: metadata.name || attributes.billing?.name || "Player",
        email: metadata.email || attributes.billing?.email || "",
        phone: metadata.phone || attributes.billing?.phone || "",
        vehicle: metadata.vehicle || "None",
        method: metadata.method || "gcash",
        subtotal: Number(metadata.subtotal || 0),
        fee: Number(metadata.fee || 0),
        amount: Number(metadata.amount || 0),
        status: "confirmed",
        at: Date.now(),
      };

      return res.status(200).json({ verified: true, booking });
    } catch (error) {
      console.error("PayMongo payment verification error:", error);
      return res.status(500).json({
        error: "Error verifying payment.",
      });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed." });
}