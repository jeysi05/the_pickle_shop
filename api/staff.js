import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://wxegmiohtbdlnnsjslxu.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4ZWdtaW9odGJkbG5uc2pzbHh1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODMwOTg1NywiZXhwIjoyMTAzODg1ODU3fQ.QpvvMA1mIaiXt-ukIxcmoIK-znQ_1FzUA7ssVKG57p4";

const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "pickle_shop_admin_jwt_secret_2026";
const DEFAULT_PIN = process.env.STAFF_PIN || "2626";

function sbHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

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

async function getCurrentPin() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.STAFF_PIN&select=value`, {
      headers: sbHeaders(),
    });
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
        return String(rows[0].value).trim();
      }
    }
  } catch (e) {}
  return String(DEFAULT_PIN).trim();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, pin, oldPin, newPin, date, hour, ref, decision } = req.body || {};

  try {
    // 1. Staff Login
    if (action === "login") {
      const currentPin = await getCurrentPin();
      const enteredPin = String(pin || "").trim();

      if (enteredPin !== currentPin) {
        return res.status(401).json({ error: "Incorrect password. Please try again." });
      }

      const token = signToken({ role: "staff", exp: Date.now() + 24 * 3600 * 1000 }, SESSION_SECRET);
      return res.status(200).json({ ok: true, token });
    }

    // Verify Bearer Token for all protected staff actions below
    const auth = (req.headers.authorization || "").replace("Bearer ", "");
    if (!verifyToken(auth, SESSION_SECRET)) {
      return res.status(401).json({ error: "Unauthorized or expired session. Please log in again." });
    }

    // 2. Load Staff Dashboard Data (Bookings + Blocked Slots)
    if (action === "dashboard") {
      const [bResp, blResp] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/bookings?status=neq.rejected&select=*&order=at.desc`, {
          headers: sbHeaders(),
        }),
        fetch(`${SUPABASE_URL}/rest/v1/blocked_slots?select=*`, {
          headers: sbHeaders(),
        }),
      ]);

      const bookings = await bResp.json();
      const blockedRows = await blResp.json();

      const blocked = Array.isArray(blockedRows)
        ? blockedRows.map((r) => `${r.date_key}|${r.hour_num}`)
        : [];

      return res.status(200).json({
        bookings: Array.isArray(bookings) ? bookings : [],
        blocked,
      });
    }

    // 3. Approve or Reject Pending GCash Booking
    if (action === "review_booking") {
      if (decision === "confirm") {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/bookings?ref=eq.${encodeURIComponent(ref)}`,
          {
            method: "PATCH",
            headers: sbHeaders(),
            body: JSON.stringify({ status: "confirmed", confirmedAt: Date.now() }),
          }
        );
        const updated = await r.json();
        return res.status(200).json({
          ok: true,
          booking: Array.isArray(updated) && updated[0] ? updated[0] : null,
        });
      } else {
        await fetch(
          `${SUPABASE_URL}/rest/v1/bookings?ref=eq.${encodeURIComponent(ref)}`,
          {
            method: "DELETE",
            headers: sbHeaders(),
          }
        );
        return res.status(200).json({ ok: true, booking: null });
      }
    }

    // 4. Remove / Cancel a Confirmed (or Pending) Booking & Reopen Slot
    if (action === "cancel_booking") {
      await fetch(
        `${SUPABASE_URL}/rest/v1/bookings?ref=eq.${encodeURIComponent(ref)}`,
        {
          method: "DELETE",
          headers: sbHeaders(),
        }
      );
      return res.status(200).json({ ok: true });
    }

    // 5. Toggle Block/Unblock Slot Globally
    if (action === "toggle_block") {
      const hourNum = Number(hour);
      const checkResp = await fetch(
        `${SUPABASE_URL}/rest/v1/blocked_slots?date_key=eq.${encodeURIComponent(date)}&hour_num=eq.${hourNum}&select=id`,
        { headers: sbHeaders() }
      );
      const existing = await checkResp.json();

      if (Array.isArray(existing) && existing.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/blocked_slots?id=eq.${existing[0].id}`, {
          method: "DELETE",
          headers: sbHeaders(),
        });
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/blocked_slots`, {
          method: "POST",
          headers: sbHeaders(),
          body: JSON.stringify({ date_key: date, hour_num: hourNum }),
        });
      }
      return res.status(200).json({ ok: true });
    }

    // 6. Change Owner Password Globally in Supabase
    if (action === "change_pin") {
      const currentPin = await getCurrentPin();
      if (String(oldPin || "").trim() !== currentPin) {
        return res.status(400).json({ error: "Current password is incorrect." });
      }

      const cleanNew = String(newPin || "").trim();
      if (cleanNew.length < 4) {
        return res.status(400).json({ error: "New password must be at least 4 characters." });
      }

      const upsertResp = await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
        method: "POST",
        headers: {
          ...sbHeaders(),
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({ key: "STAFF_PIN", value: cleanNew }),
      });

      if (!upsertResp.ok) {
        return res.status(500).json({ error: "Make sure you ran the settings table SQL in Supabase." });
      }

      return res.status(200).json({ ok: true });
    }

    // 7. Reset All Test Data Globally
    if (action === "reset_all") {
      await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/bookings?ref=neq.___none___`, {
          method: "DELETE",
          headers: sbHeaders(),
        }),
        fetch(`${SUPABASE_URL}/rest/v1/blocked_slots?id=gt.0`, {
          method: "DELETE",
          headers: sbHeaders(),
        }),
      ]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("Staff API error:", err);
    return res.status(500).json({ error: "Server error in staff endpoint." });
  }
}