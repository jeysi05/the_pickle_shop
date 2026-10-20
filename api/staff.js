// api/staff.js
import crypto from "crypto";

function signToken(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  if (sig !== expected) return null;
  const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  if (Date.now() > payload.exp) return null;
  return payload;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const staffPin = process.env.STAFF_PIN || "2626";
  const sessionSecret = process.env.ADMIN_SESSION_SECRET || "default_change_me_in_vercel";
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  const scriptSecret = process.env.APPS_SCRIPT_SECRET || "";

  if (req.method === "POST") {
    const { action, pin, date, hour } = req.body || {};

    // 1. Staff Login
    if (action === "login") {
      if (String(pin) !== String(staffPin)) {
        return res.status(401).json({ error: "Invalid Staff PIN" });
      }
      const token = signToken({ role: "staff", exp: Date.now() + 12 * 3600 * 1000 }, sessionSecret);
      return res.status(200).json({ token });
    }

    // Verify Bearer Token for protected staff actions
    const auth = (req.headers.authorization || "").replace("Bearer ", "");
    if (!verifyToken(auth, sessionSecret)) {
      return res.status(401).json({ error: "Unauthorized or expired staff session" });
    }

    // 2. Toggle Block/Unblock Slot Globally
    if (action === "toggle_block") {
      if (!scriptUrl) return res.status(500).json({ error: "Database URL not configured" });
      const r = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: scriptSecret, action: "toggle_block", date, hour: Number(hour) })
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    // 3. Load Staff Dashboard Data
    if (action === "dashboard") {
      if (!scriptUrl) return res.status(200).json({ bookings: [], blocked: [] });
      const r = await fetch(
        `${scriptUrl}?action=staff_dashboard&date=${encodeURIComponent(date)}&secret=${encodeURIComponent(scriptSecret)}`
      );
      const data = await r.json();
      return res.status(200).json(data);
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}