// api/staff.js
import crypto from "crypto";

function signToken(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyToken(token, secret) {
  try {
    if (!token || typeof token !== "string" || !token.includes(".")) return null;
    const [data, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const fallbackPin = process.env.STAFF_PIN || "2626";
  const sessionSecret = process.env.ADMIN_SESSION_SECRET || "pickle_shop_admin_jwt_secret_2026";
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  const scriptSecret = process.env.APPS_SCRIPT_SECRET || "tps_secret_2026";

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, pin, oldPin, newPin, date, hour } = req.body || {};

  // 1. Staff Login (Verifies against Google Sheet 'Settings' tab so owner password changes work everywhere)
  if (action === "login") {
    let isValid = false;
    if (scriptUrl) {
      try {
        const r = await fetch(scriptUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: scriptSecret, action: "verify_pin", pin: String(pin) })
        });
        const d = await r.json();
        isValid = !!d.valid;
      } catch (e) {
        isValid = String(pin) === String(fallbackPin);
      }
    } else {
      isValid = String(pin) === String(fallbackPin);
    }

    if (!isValid) {
      return res.status(401).json({ error: "Incorrect password. Please try again." });
    }

    const token = signToken({ role: "staff", exp: Date.now() + 12 * 3600 * 1000 }, sessionSecret);
    return res.status(200).json({ token });
  }

  // Verify Bearer Token for all protected staff actions below
  const auth = (req.headers.authorization || "").replace("Bearer ", "");
  if (!verifyToken(auth, sessionSecret)) {
    return res.status(401).json({ error: "Unauthorized or expired session. Please log in again." });
  }

  // 2. Load Staff Dashboard Data from Google Sheet
  if (action === "dashboard") {
    if (!scriptUrl) return res.status(200).json({ bookings: [], blocked: [] });
    try {
      const r = await fetch(
        `${scriptUrl}?action=staff_dashboard&date=${encodeURIComponent(date || "")}&secret=${encodeURIComponent(scriptSecret)}`
      );
      const data = await r.json();
      return res.status(200).json({
        bookings: Array.isArray(data.bookings) ? data.bookings : [],
        blocked: Array.isArray(data.blocked) ? data.blocked : []
      });
    } catch (err) {
      return res.status(500).json({ error: "Failed to load dashboard from Google Sheet." });
    }
  }

  // 3. Toggle Block/Unblock Slot Globally in Google Sheet
  if (action === "toggle_block") {
    if (!scriptUrl) return res.status(200).json({ ok: true });
    try {
      const r = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: scriptSecret, action: "toggle_block", date, hour: Number(hour) })
      });
      const data = await r.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: "Failed to update slot block." });
    }
  }

  // 4. Change Owner Password Globally in Google Sheet
  if (action === "change_pin") {
    if (!scriptUrl) return res.status(500).json({ error: "Database URL not configured." });
    try {
      const r = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: scriptSecret,
          action: "change_pin",
          oldPin: String(oldPin),
          newPin: String(newPin)
        })
      });
      const data = await r.json();
      if (!data.ok) {
        return res.status(400).json({ error: data.error || "Could not update password." });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: "Failed to update password." });
    }
  }

  // 5. Reset All Test Data Globally in Google Sheet
  if (action === "reset_all") {
    if (!scriptUrl) return res.status(200).json({ ok: true });
    try {
      const r = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: scriptSecret, action: "reset_all" })
      });
      const data = await r.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: "Failed to reset data." });
    }
  }

  return res.status(400).json({ error: "Unknown action" });
}