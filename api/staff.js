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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  // Support both GET and POST for dashboard loading
  const action = req.method === "GET" ? "dashboard" : req.body?.action;
  const { date, hour, ref, decision } = req.body || {};

  try {
    // 1. Load Staff Dashboard Data (Bookings + Blocked Slots)
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

    // 2. Approve or Reject Pending GCash Booking
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
        // Delete rejected booking so the slot & GCash ref are freed immediately
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

    // 3. Toggle Block/Unblock Slot Globally
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

    // 4. Reset All Test Data Globally
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

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Staff API error:", err);
    return res.status(500).json({ error: "Server error in staff endpoint." });
  }
}