// netlify/functions/lead.js
// Receives the quiz payload, stores it in Supabase, then creates or updates
// the contact in Systeme and sets custom fields and the route tag.
// Secrets live in Netlify environment variables, never in the repo:
//   SYSTEME_API_KEY        (Systeme public API key)
//   SUPABASE_SERVICE_KEY   (Supabase service_role key)

const SYSTEME_BASE = "https://api.systeme.io/api";
const SUPABASE_URL = "https://amrvuxvlsebrznwcqhij.supabase.co";
const crypto = require("crypto");

// SHA-256 for Conversions API user data (email, first name). Normalized: trimmed + lowercased.
function sha256(s) {
  return crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex");
}

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

  // Marketing consent, set by the quiz cookie banner. true for non-EU and
  // EU/UK visitors who accepted; false ONLY when an EU/UK visitor declined
  // marketing cookies. Undefined on older quiz builds -> treated as allowed.
  const marketingOk = p.marketing_consent !== false;

  // 1) Supabase is the source of truth. Store first, best effort.
  //    NOTE: quiz_leads needs a boolean column "marketing_consent".
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

  // 2) Create or find the Systeme contact, then set fields via PATCH.
  let systemeOk = false;
  try {
    const a = p.answers || {};
    const fields = [
      { slug: "first_name", value: p.first_name || "" },
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
    } else {
      const res = await systeme("/contacts", {
        method: "POST",
        body: JSON.stringify({ email: p.email }),
      });
      if (res.ok) {
        const created = await res.json();
        contactId = created && created.id;
      } else {
        console.error("Create failed:", res.status, await res.text());
        const again = await findContactByEmail(p.email);
        if (again) contactId = again.id;
      }
    }

    if (contactId) {
      const patch = await systeme("/contacts/" + contactId, {
        method: "PATCH",
        contentType: "application/merge-patch+json",
        body: JSON.stringify({ fields }),
      });
      if (!patch.ok) console.error("Field update failed:", patch.status, await patch.text());

      // Phone number from the WhatsApp field, in its own update so a problem
      // here cannot break the fields above. Optional, best effort.
      if (p.whatsapp) {
        const ph = await systeme("/contacts/" + contactId, {
          method: "PATCH",
          contentType: "application/merge-patch+json",
          body: JSON.stringify({ fields: [{ slug: "phone_number", value: p.whatsapp }] }),
        });
        if (!ph.ok) console.error("Phone update failed:", ph.status, await ph.text());
      }

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
      systemeOk = patch.ok;
    }
  } catch (e) {
    console.error("Systeme sync error:", e);
  }

  // 3) Conversions API (server-side). Mirrors the browser Lead/QualifiedLead with the
  //    SAME event_id so Meta deduplicates. Secrets from env: META_PIXEL_ID, META_CAPI_TOKEN.
  //    Best effort; never blocks the response.
  let capiOk = false;
  try {
    const PIXEL_ID = process.env.META_PIXEL_ID;
    const TOKEN = process.env.META_CAPI_TOKEN;
    console.log("CAPI env check:", {
      hasPixel: !!PIXEL_ID,
      hasToken: !!TOKEN,
      hasEmail: !!p.email,
      testCode: process.env.META_TEST_EVENT_CODE || "(none)",
    });
    if (!marketingOk) {
      console.log("CAPI skipped: visitor declined marketing cookies (Lead/QualifiedLead not sent to Meta)");
    } else if (PIXEL_ID && TOKEN && p.email) {
      const h = event.headers || {};
      const ip = (h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0] || "").trim();
      const ua = h["user-agent"] || "";
      const user_data = {
        em: [sha256(p.email)],
        fn: p.first_name ? [sha256(p.first_name)] : undefined,
        fbp: p.fbp || undefined,
        fbc: p.fbc || undefined,
        client_ip_address: ip || undefined,
        client_user_agent: ua || undefined,
      };
      const base = {
        event_time: Math.floor(Date.now() / 1000),
        event_id: p.event_id,
        action_source: "website",
        event_source_url: p.page_url || undefined,
        user_data,
      };
      const events = [Object.assign({ event_name: "Lead" }, base)];
      if (p.qualified) events.push(Object.assign({ event_name: "QualifiedLead" }, base));
      // While testing, set META_TEST_EVENT_CODE in Netlify env to route these to Test Events.
      // Leave it empty/unset in production.
      const body = { data: events };
      if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;
      const capi = await fetch(
        "https://graph.facebook.com/v21.0/" + PIXEL_ID + "/events?access_token=" + encodeURIComponent(TOKEN),
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      const capiText = await capi.text();
      capiOk = capi.ok;
      console.log("CAPI response:", capi.status, capiText);
    } else if (!PIXEL_ID || !TOKEN) {
      console.error("CAPI skipped: set META_PIXEL_ID and META_CAPI_TOKEN in Netlify env vars");
    }
  } catch (e) {
    console.error("CAPI error:", e);
  }

  return {
    statusCode: 200,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, supabase: supabaseOk, systeme: systemeOk, capi: capiOk, consent: marketingOk }),
  };
};
