const SUPABASE_URL = process.env.SUPABASE_URL || "https://wxegmiohtbdlnnsjslxu.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4ZWdtaW9odGJkbG5uc2pzbHh1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODMwOTg1NywiZXhwIjoyMTAzODg1ODU3fQ.QpvvMA1mIaiXt-ukIxcmoIK-znQ_1FzUA7ssVKG57p4";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    const [bResp, blResp] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/bookings?date=eq.${encodeURIComponent(date)}&status=in.(confirmed,payment_review)&select=hours`,
        { headers }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/blocked_slots?date_key=eq.${encodeURIComponent(date)}&select=hour_num`,
        { headers }
      ),
    ]);

    const bookings = await bResp.json();
    const blocked = await blResp.json();
    const taken = new Set();

    if (Array.isArray(bookings)) {
      bookings.forEach((b) => {
        const hrs = Array.isArray(b.hours) ? b.hours : [];
        hrs.forEach((h) => taken.add(Number(h)));
      });
    }

    if (Array.isArray(blocked)) {
      blocked.forEach((bl) => taken.add(Number(bl.hour_num)));
    }

    return res.status(200).json({ taken: [...taken] });
  } catch (err) {
    console.error("Schedule fetch error:", err);
    return res.status(500).json({ error: "Failed to load schedule" });
  }
}