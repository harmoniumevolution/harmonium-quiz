// netlify/functions/stats.js
// Feeds dashboard.html. GET /.netlify/functions/stats?key=<DASHBOARD_KEY>&days=7|14|30|all
// Calls the Postgres function quiz_stats() in Supabase with the service key.
// Env vars (Netlify -> Site configuration -> Environment variables):
//   DASHBOARD_KEY         any long random string; the same one goes in the dashboard link
//   SUPABASE_SERVICE_KEY  already set for lead.js

const SUPABASE_URL = "https://amrvuxvlsebrznwcqhij.supabase.co";

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
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/quiz_stats", {
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
      console.error("quiz_stats failed:", r.status, text);
      return { statusCode: 502, headers: { "Cache-Control": "no-store" }, body: "Supabase error: " + text };
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: text,
    };
  } catch (e) {
    console.error("stats error:", e);
    return { statusCode: 500, headers: { "Cache-Control": "no-store" }, body: "Error: " + e.message };
  }
};
