// api/schedule.js
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  try {
    const scriptUrl = process.env.APPS_SCRIPT_URL;
    if (!scriptUrl) {
      return res.status(200).json({ taken: [] });
    }

    const response = await fetch(
      `${scriptUrl}?action=availability&date=${encodeURIComponent(date)}&secret=${encodeURIComponent(process.env.APPS_SCRIPT_SECRET || "")}`
    );
    const data = await response.json();
    return res.status(200).json({ taken: Array.isArray(data.taken) ? data.taken : [] });
  } catch (err) {
    console.error("Schedule fetch error:", err);
    return res.status(500).json({ error: "Failed to load schedule" });
  }
}