// netlify/functions/stats.js
// Feeds dashboard.html. GET /.netlify/functions/stats?key=<DASHBOARD_KEY>&days=7|14|30|all
// Calls the Postgres functions quiz_stats() and, since 28 Oct 2026, quiz_stats_extra() in
// Supabase with the service key, and returns both: the quiz_stats JSON as before, with the
// quiz_stats_extra JSON added under "extra". If quiz_stats_extra does not exist yet, the
// dashboard still gets the old numbers and "extra" is null.
// Env vars (Netlify -> Site configuration -> Environment variables):
//   DASHBOARD_KEY         any long random string; the same one goes in the dashboard link
//   SUPABASE_SERVICE_KEY  already set for lead.js

const SUPABASE_URL = "https://amrvuxvlsebrznwcqhij.supabase.co";

async function rpc(name, days) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + process.env.SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_days: days }),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(text);
    err.status = r.status;
    throw err;
  }
  return JSON.parse(text);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, body: "Method not allowed" };

  const q = event.queryStringParameters || {};
  const expected = process.env.DASHBOARD_KEY || "";
  if (!expected || !q.key || q.key !== expected) {
    return { statusCode: 401, headers: { "Cache-Control": "no-store" }, body: "Unauthorized" };
  }

  // 7 / 14 / 30 / all  -> days or null (all time)
  let days = null;
  if (q.days && q.days !== "all") {
    days = parseInt(q.days, 10);
    if (!Number.isFinite(days) || days < 1) days = 7;
    if (days > 3650) days = 3650;
  }

  try {
    const [stats, extra] = await Promise.all([
      rpc("quiz_stats", days),
      rpc("quiz_stats_extra", days).catch((e) => {
        console.error("quiz_stats_extra failed (dashboard shows the old blocks only):", e.status, e.message);
        return null;
      }),
    ]);
    stats.extra = extra;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(stats),
    };
  } catch (e) {
    console.error("quiz_stats failed:", e.status, e.message);
    const code = e.status ? 502 : 500;
    return { statusCode: code, headers: { "Cache-Control": "no-store" }, body: (e.status ? "Supabase error: " : "Error: ") + e.message };
  }
};
