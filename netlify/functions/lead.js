// netlify/functions/lead.js
// Receives the quiz payload, stores it in Supabase, then creates or updates
// the contact in Systeme with custom fields and the route tag.
// Secrets live in Netlify environment variables, never in the repo:
//   SYSTEME_API_KEY        (Systeme public API key)
//   SUPABASE_SERVICE_KEY   (Supabase service_role key)

const SYSTEME_BASE = "https://api.systeme.io/api";
const SUPABASE_URL = "https://amrvuxvlsebrznwcqhij.supabase.co";

// Answer code -> readable English label, per quiz question id.
const LABELS = {
  place: {
    home: "At home, for myself, family and close friends",
    kirtan: "Together with others: kirtan, bhajans",
    lead: "Lead kirtan or singing circles",
    teach: "Yoga classes or sound healing",
  },
  level: {
    none: "Haven't started yet",
    under1: "Less than a year",
    "1to5": "1-5 years",
    over5: "More than 5 years",
  },
  blocker: {
    start: "Doesn't know where to start",
    stuck: "Learned a bit alone, now stuck",
    flat: "Playing sounds flat, chords and rhythm don't flow",
    freedom: "Wants to play more freely: melody, improvisation, leading",
  },
  sixmonths: {
    firstsongs: "Play first chants, kirtans, bhajans",
    confident: "Play confidently with others",
    everysong: "Figure out every song, with confidence",
    refinement: "Play with more refinement and creativity",
    teaching: "Teach harmonium",
  },
  time: {
    under1: "Under 1 hour per week",
    "1to3": "1-3 hours per week",
    "3to5": "3-5 hours per week",
    "5plus": "5+ hours per week",
  },
  harmonium: { yes: "Yes", onway: "On its way", notyet: "Not yet" },
};

function label(group, val) {
  const map = LABELS[group] || {};
  if (Array.isArray(val)) return val.map((v) => map[v] || v).join(", ");
  return map[val] || val || "";
}

function sameEmail(a, b) {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

// In-memory cache for tag name -> id, survives warm invocations.
let TAG_CACHE = null;

async function systeme(path, opts = {}) {
  return fetch(SYSTEME_BASE + path, {
    method: opts.method || "GET",
    headers: {
      "X-API-Key": process.env.SYSTEME_API_KEY,
      "Content-Type": opts.contentType || "application/json",
    },
    body: opts.body,
  });
}

async function getTagMap() {
  if (TAG_CACHE) return TAG_CACHE;
  const res = await systeme("/tags?limit=100");
  const data = await res.json();
  const items = Array.isArray(data) ? data : data.items || [];
  const map = {};
  for (const t of items) map[(t.name || "").toLowerCase()] = t.id;
  TAG_CACHE = map;
  return map;
}

async function findContactByEmail(email) {
  const res = await systeme("/contacts?email=" + encodeURIComponent(email));
  if (!res.ok) return null;
  const data = await res.json();
  const items = Array.isArray(data) ? data : data.items || [];
  // Guard: only treat as a match if the email really matches, in case the
  // filter is ignored and the list returns unrelated contacts.
  return items.find((c) => sameEmail(c.email, email)) || null;
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: cors, body: "Method not allowed" };

  let p;
  try {
    p = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: cors, body: "Bad JSON" };
  }

  // 1) Supabase is the source of truth. Store first, best effort.
  let supabaseOk = false;
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/quiz_leads", {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(p),
    });
    supabaseOk = r.ok;
    if (!r.ok) console.error("Supabase insert failed:", r.status, await r.text());
  } catch (e) {
    console.error("Supabase insert error:", e);
  }

  // 2) Create or update the Systeme contact, best effort.
  let systemeOk = false;
  try {
    const a = p.answers || {};
    const fields = [
      { slug: "level", value: label("level", a.level) },
      { slug: "role", value: label("place", a.place) },
      { slug: "frustration", value: label("blocker", a.blocker) },
      { slug: "goal", value: label("sixmonths", a.sixmonths) },
      { slug: "practice_time", value: label("time", a.time) },
      { slug: "harmonium", value: label("harmonium", a.harmonium) },
      { slug: "route", value: p.route || "" },
      { slug: "qualified", value: p.qualified ? "yes" : "no" },
    ];

    let contactId = null;
    const existing = await findContactByEmail(p.email);
    if (existing) {
      contactId = existing.id;
      await systeme("/contacts/" + contactId, {
        method: "PATCH",
        contentType: "application/merge-patch+json",
        body: JSON.stringify({ fields }),
      });
    } else {
      const body = { email: p.email, firstName: p.first_name || "", fields };
      if (p.whatsapp) body.phoneNumber = p.whatsapp;
      const res = await systeme("/contacts", { method: "POST", body: JSON.stringify(body) });
      if (res.ok) {
        const created = await res.json();
        contactId = created && created.id;
      } else {
        console.error("Create failed:", res.status, await res.text());
        const again = await findContactByEmail(p.email);
        if (again) {
          contactId = again.id;
          await systeme("/contacts/" + contactId, {
            method: "PATCH",
            contentType: "application/merge-patch+json",
            body: JSON.stringify({ fields }),
          });
        }
      }
    }

    // Tags: the route tag always, plus qualified and advanced where relevant.
    if (contactId) {
      const tags = ["route-" + String(p.route || "").toLowerCase()];
      if (p.qualified) tags.push("qualified");
      if (p.advanced) tags.push("advanced");
      const tagMap = await getTagMap();
      for (const name of tags) {
        const tagId = tagMap[name];
        if (!tagId) {
          console.error("Tag not found in Systeme:", name);
          continue;
        }
        await systeme("/contacts/" + contactId + "/tags", {
          method: "POST",
          body: JSON.stringify({ tagId }),
        });
      }
      systemeOk = true;
    }
  } catch (e) {
    console.error("Systeme sync error:", e);
  }

  // Always 200 so the quiz can redirect. The flags help you debug the test.
  return {
    statusCode: 200,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, supabase: supabaseOk, systeme: systemeOk }),
  };
};
