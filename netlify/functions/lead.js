// netlify/functions/lead.js
// Receives the quiz payload, stores it in Supabase, then creates or updates
// the contact in Systeme and sets custom fields and the route tag.
// 28 Oct 2026: route H (hobby, the One Year All Access offer). The quiz sends hobby:true,
// route "H", qualified false. This file then adds the tag "hobby" next to "route-h" /
// "route-h-results-only", stores hobby in quiz_leads, and sends HobbyLead (not QualifiedLead)
// to the Conversions API with the same event_id as the browser event.
// Tags to create in Systeme: route-h, route-h-results-only, hobby.
// SQL once: alter table quiz_leads add column if not exists hobby boolean;
// 30 Oct 2026 (evening): question 10 states the size of the investment (no price) and routes on the
// answer: "program" -> H (the page, beginner or not, tag hobby + HobbyLead), "mentorship" -> B (call,
// QualifiedLead), "explore" and "budget" -> D. A "budget" answer also sends budget:true; this file then
// adds the tag "d-budget" (with email consent) so the D mails can show the cheap path. Route A is gone.
// Tag to create in Systeme: d-budget.
// SQL once: alter table quiz_leads add column if not exists budget boolean;
// Secrets live in Netlify environment variables, never in the repo:
//   SYSTEME_API_KEY        (Systeme public API key)
//   SUPABASE_SERVICE_KEY   (Supabase service_role key)
//   ZAPIER_D_HOOK          (optional: Zapier catch hook for experienced D-leads)
//   RESEND_API_KEY         (optional: Resend API key for the lead notification to Kenny)
//   NOTIFY_TO              (optional: the inbox that receives the lead notification)
//   NOTIFY_FROM            (optional: sender, default "Harmonium Quiz <onboarding@resend.dev>")
//   NOTIFY_ALL_QUALIFIED   (optional: "1" = also notify for qualified leads without a WhatsApp number)

const SYSTEME_BASE = "https://api.systeme.io/api";
const SUPABASE_URL = "https://amrvuxvlsebrznwcqhij.supabase.co";
const CALL_LINK = "https://harmoniumevolution.com/apply";
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
  invest: {
    // 30 Oct 2026 (evening) question: the investment size is in the question, these are the answers
    explore: "Still exploring, free videos for now",
    program: "Ready for an investment the size of a good harmonium or a few months of lessons, wants to learn through the program at own pace",
    mentorship: "Wants more than the program (play for others, maybe teach), open to personal mentorship",
    budget: "Would love to, but an investment like that isn't realistic right now",
    // 30 Oct 2026 (morning) question
    unsure: "Getting started, not sure they can learn it or stay motivated",
    properly: "Beginner, wants to learn it the right way with quality guidance, ready to invest",
    hobby: "Plays already, hobby, no big plans, wants to get better at own pace",
    serious: "Plays already, wants to play well also with others, ready to invest",
    // older questions
    ambitious: "Ambitious (28-30 Oct question)",
    ready: "Ready to invest (old question)",
    free: "Free tips for now (old question)",
  },
};

// How the level reads inside a sentence of the WhatsApp message.
const LEVEL_PHRASE = {
  none: "you haven't started yet",
  under1: "you've been playing for less than a year",
  "1to5": "you've been playing for 1-5 years",
  over5: "you've been playing for more than 5 years",
};

// Country hint by dial code. Only used when the WhatsApp number starts with a country code.
const DIAL_CODES = {
  "1": "US/Canada", "44": "UK", "61": "Australia", "64": "New Zealand", "91": "India",
  "31": "Netherlands", "32": "Belgium", "49": "Germany", "33": "France", "34": "Spain",
  "39": "Italy", "41": "Switzerland", "43": "Austria", "45": "Denmark", "46": "Sweden",
  "47": "Norway", "351": "Portugal", "353": "Ireland", "358": "Finland", "27": "South Africa",
  "52": "Mexico", "55": "Brazil", "65": "Singapore", "971": "UAE", "972": "Israel", "81": "Japan",
};

function label(group, val) {
  const map = LABELS[group] || {};
  if (Array.isArray(val)) return val.map((v) => map[v] || v).join(", ");
  return map[val] || val || "";
}

function sameEmail(a, b) {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

// ---------- Lead notification helpers (22 Oct 2026) ----------

// "Play confidently with others" -> "play confidently with others"
function goalPhrase(v) {
  const l = label("sixmonths", Array.isArray(v) ? v[0] : v);
  if (!l) return "take the next step with your harmonium";
  return l.charAt(0).toLowerCase() + l.slice(1);
}

// The WhatsApp message Kenny sends by hand. Edit the wording here; the first name is filled in
// per lead. 30 Oct 2026: shorter and more conversational (Kenny's wording), opens a chat instead of
// pushing the call. LEVEL_PHRASE and goalPhrase stay available for a personal variant later.
function whatsappMessage(p) {
  const name = (p.first_name || "").trim() || "there";
  return (
    "Hi " + name + " 🙏 This is Kenny from Harmonium Evolution. How are you doing? " +
    "Thanks for taking the quiz. Do you already play some harmonium, or are you just starting? " +
    "And did you get a chance to watch the harmonium masterclass?\n\n" +
    "Happy to talk and see how I can help you. If you like, we can chat here, or you can schedule " +
    "a call with me in the next few days through the form on this page: " + CALL_LINK + "\n\n" +
    "Best wishes,\nKenny"
  );
}

// wa.me needs the full international number as digits only ("+31 6 1234 5678" -> "31612345678").
function waDigits(n) {
  let d = String(n || "").trim();
  if (d.startsWith("00")) d = d.slice(2);
  return d.replace(/\D/g, "");
}

function dialCountry(digits) {
  for (const len of [3, 2, 1]) {
    const k = digits.slice(0, len);
    if (DIAL_CODES[k]) return DIAL_CODES[k];
  }
  return "";
}

// Visitor location from Netlify's geo data (same source as the consent region in the quiz).
function getGeo(event, context) {
  const h = event.headers || {};
  let g = (context && context.geo) || null;
  if (!g && h["x-nf-geo"]) {
    try {
      g = JSON.parse(Buffer.from(h["x-nf-geo"], "base64").toString("utf8"));
    } catch {
      try { g = JSON.parse(h["x-nf-geo"]); } catch { g = null; }
    }
  }
  const c = (g && g.country) || {};
  return {
    countryCode: c.code || h["x-country"] || "",
    countryName: c.name || "",
    city: (g && g.city) || "",
    timezone: (g && g.timezone) || "",
  };
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Email to Kenny with the lead, the quiz answers and a one-tap WhatsApp link that opens the
// chat with the message already typed. Sent through Resend.
async function sendLeadNotification(p, geo) {
  const a = p.answers || {};
  const digits = waDigits(p.whatsapp);
  const msg = whatsappMessage(p);
  const waLink = digits ? "https://wa.me/" + digits + "?text=" + encodeURIComponent(msg) : "";
  const dial = digits ? dialCountry(digits) : "";
  const where = [geo.countryName || geo.countryCode, geo.city].filter(Boolean).join(", ");
  const routeTxt = String(p.route || "").toUpperCase() + (p.advanced ? " advanced" : "");
  const subject =
    "Quiz lead: " + (p.first_name || p.email) +
    (geo.countryCode ? " (" + geo.countryCode + ")" : "") +
    " · route " + routeTxt + (digits ? " · WhatsApp" : " · no WhatsApp");

  const rows = [
    ["Name", p.first_name || ""],
    ["Email", p.email || ""],
    ["WhatsApp", p.whatsapp ? p.whatsapp + (dial ? " (" + dial + ")" : "") : "not left"],
    ["Country", (where || "unknown") + (geo.timezone ? " · " + geo.timezone : "")],
    ["Route", routeTxt + (p.qualified ? ", qualified (mentorship answer, call)" : p.hobby ? ", program answer (the page; on a call: offer the year, not lifetime)" : p.budget ? ", budget answer (proof route, cheap path in the mails, no call)" : ", exploring (proof route, no call)")],
    ["Plays", label("place", a.place)],
    ["Level", label("level", a.level)],
    ["Situation", label("blocker", a.blocker)],
    ["Goal (6 months)", label("sixmonths", a.sixmonths)],
    ["Practice time", label("time", a.time)],
    ["Harmonium", label("harmonium", a.harmonium)],
    ["Commitment", label("invest", a.invest)],
    ["Email consent", p.email_consent === true ? "yes" : "no"],
    ["Ad (utm_content)", p.utm_content || ""],
  ];
  // Any other quiz answers (questions without a label map), shown raw.
  const known = new Set(["place", "level", "blocker", "sixmonths", "time", "harmonium", "invest"]);
  for (const k of Object.keys(a)) {
    if (!known.has(k)) rows.push([k, Array.isArray(a[k]) ? a[k].join(", ") : String(a[k] ?? "")]);
  }

  const table = rows
    .map(([k, v]) =>
      "<tr><td style=\"padding:4px 14px 4px 0;color:#666;vertical-align:top;white-space:nowrap\">" +
      escapeHtml(k) + "</td><td style=\"padding:4px 0\">" + escapeHtml(v) + "</td></tr>")
    .join("");
  const button = waLink
    ? "<p style=\"margin:20px 0\"><a href=\"" + escapeHtml(waLink) + "\" style=\"display:inline-block;background:#25D366;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold\">Open WhatsApp with the message</a></p>"
    : "<p style=\"margin:20px 0;color:#666\">No WhatsApp number left, reply by email instead.</p>";
  const html =
    "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222\">" +
    "<h2 style=\"margin:0 0 12px\">New quiz lead: " + escapeHtml(p.first_name || p.email) + "</h2>" +
    "<table style=\"border-collapse:collapse\">" + table + "</table>" + button +
    "<p style=\"color:#666;margin:0 0 6px\">Message (copy it if the button doesn't open WhatsApp):</p>" +
    "<pre style=\"white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:8px;font-family:inherit\">" +
    escapeHtml(msg) + "</pre></div>";
  const text =
    rows.map(([k, v]) => k + ": " + v).join("\n") +
    (waLink ? "\n\nWhatsApp: " + waLink : "") + "\n\n" + msg;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM || "Harmonium Quiz <onboarding@resend.dev>",
      to: [process.env.NOTIFY_TO],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) console.error("Notify failed:", res.status, await res.text());
  else console.log("Notify sent to", process.env.NOTIFY_TO);
  return res.ok;
}

// ---------- Systeme helpers ----------

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

exports.handler = async (event, context) => {
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

  // 0) Email check (20 Oct 2026). Systeme refuses an invalid address with a 422, and then
  //    the contact is never created and the lead gets no emails. Same rule as the quiz:
  //    trim, lowercase, drop a stray dot/comma at the end, require a domain with a TLD.
  //    An invalid address is refused here before anything is stored or sent, and the quiz
  //    shows "please check your email" instead of redirecting.
  const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
  const email = String(p.email || "").trim().toLowerCase().replace(/[.,;]+$/, "");
  if (!EMAIL_RE.test(email) || email.includes("..")) {
    console.error("Invalid email, nothing saved:", email);
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, reason: "invalid_email" }),
    };
  }
  p.email = email; // normalized address for Supabase, Systeme and CAPI
  let systemeEmailInvalid = false; // set when Systeme itself still refuses the address

  // Country of the visitor (22 Oct 2026), from Netlify's geo data. Stored as ISO code in
  // quiz_leads.country and shown in the lead notification.
  const geo = getGeo(event, context);
  if (geo.countryCode) p.country = geo.countryCode;

  // Marketing consent, set by the quiz cookie banner. true for non-EU and
  // EU/UK visitors who accepted; false ONLY when an EU/UK visitor declined
  // marketing cookies. Undefined on older quiz builds -> treated as allowed.
  const marketingOk = p.marketing_consent !== false;

  // Experienced players (1-5 years or 5+ years) who chose "not planning to invest
  // right now" (route D). They get a personal 3-mail follow-up in Systeme via the
  // tag "d-experienced" and, optionally, a heads-up to Kenny via Zapier.
  // Only with email consent, because the follow-up sends email. No Meta event:
  // the QualifiedLead signal stays untouched.
  // 30 Oct 2026: route D is now "still exploring" or "not realistic right now"; an experienced player
  // who is still exploring is a contradiction worth a look, same as before. An experienced player who
  // said the investment isn't realistic is not: the reason is known, so d-budget handles that one.
  const expD =
    String(p.route || "").toUpperCase() === "D" &&
    p.budget !== true &&
    ["1to5", "over5"].includes((p.answers || {}).level) &&
    p.email_consent === true;

  // 1) Supabase is the source of truth. Store first, best effort.
  //    NOTE: quiz_leads needs the boolean column "marketing_consent" and, since 22 Oct, the
  //    text column "country". If "country" doesn't exist yet, the insert is retried without
  //    it, so a missing column never loses a lead.
  //    SQL once: alter table quiz_leads add column if not exists country text;
  let supabaseOk = false;
  const insertLead = (row) =>
    fetch(SUPABASE_URL + "/rest/v1/quiz_leads", {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
  try {
    // A column the table does not have yet (country in Oct, hobby since 28 Oct) must never lose a
    // lead: PostgREST names the column in its error, so drop that key and retry, up to three times.
    let row = Object.assign({}, p);
    let r = await insertLead(row);
    for (let i = 0; i < 3 && !r.ok; i++) {
      const t = await r.text();
      const m = r.status === 400 && /'([A-Za-z0-9_]+)' column/.exec(t);
      if (!m || !(m[1] in row)) { console.error("Supabase insert failed:", r.status, t); break; }
      console.error("quiz_leads has no '" + m[1] + "' column yet, retrying without it. Run: alter table quiz_leads add column if not exists " + m[1] + " " + (typeof row[m[1]] === "boolean" ? "boolean" : "text") + ";");
      delete row[m[1]];
      r = await insertLead(row);
    }
    supabaseOk = r.ok;
    if (r.ok) console.log("Supabase insert:", r.status, "route", p.route, "qualified", !!p.qualified, "consent", p.email_consent === true, "country", p.country || "?");
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
      console.log("Systeme contact found (existing):", contactId);
    } else {
      const res = await systeme("/contacts", {
        method: "POST",
        body: JSON.stringify({ email: p.email }),
      });
      if (res.ok) {
        const created = await res.json();
        contactId = created && created.id;
        console.log("Systeme contact created:", res.status, contactId);
      } else {
        const text = await res.text();
        console.error("Create failed:", res.status, text);
        // Systeme's own validation refused the address: tell the quiz so the person can fix it.
        if (res.status === 422 && /"propertyPath"\s*:\s*"email"/.test(text)) systemeEmailInvalid = true;
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
      else console.log("Systeme fields updated:", patch.status);

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

      // Email consent decides which route tag starts the automations in Systeme:
      //   consent   -> "route-b"              (starts the full email sequence)
      //   no consent -> "route-b-results-only" (sends only the results email)
      // "email-consent" is the general tag to filter newsletters and broadcasts on.
      // "d-experienced" (route D, 1-5 or 5+ years, with consent) starts the
      // personal follow-up campaign "D experienced follow-up".
      const route = String(p.route || "").toLowerCase();
      const emailOk = p.email_consent === true;
      const tags = [emailOk ? "route-" + route : "route-" + route + "-results-only"];
      if (p.qualified) tags.push("qualified");
      if (p.advanced) tags.push("advanced");
      if (p.hobby) tags.push("hobby");                // route H (28 Oct 2026)
      if (emailOk) tags.push("email-consent");
      if (expD) tags.push("d-experienced");
      // 30 Oct 2026 (evening): "the investment isn't realistic right now". Only with consent, because
      // the tag changes which mails go out (Getting Started on day 5, the half year on day 14).
      if (route === "d" && p.budget === true && emailOk) tags.push("d-budget");
      const tagMap = await getTagMap();
      const tagged = [];
      for (const name of tags) {
        const tagId = tagMap[name];
        if (!tagId) {
          console.error("Tag not found in Systeme:", name);
          continue;
        }
        const t = await systeme("/contacts/" + contactId + "/tags", {
          method: "POST",
          body: JSON.stringify({ tagId }),
        });
        if (t.ok) tagged.push(name);
        else console.error("Tag add failed:", name, t.status, await t.text());
      }
      console.log("Systeme tags added:", tagged.join(", ") || "(none)");
      systemeOk = patch.ok;
    }
  } catch (e) {
    console.error("Systeme sync error:", e);
  }

  // 2b) Optional heads-up to Kenny for experienced D-leads, via a Zapier catch hook
  //     (ZAPIER_D_HOOK in Netlify env vars). Lets him send a personal WhatsApp when a
  //     number was left. Best effort; never blocks the response. Nothing is sent when
  //     the variable is unset.
  let hookOk = false;
  if (expD && process.env.ZAPIER_D_HOOK) {
    try {
      const hook = await fetch(process.env.ZAPIER_D_HOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: p.first_name || "",
          email: p.email || "",
          level: label("level", (p.answers || {}).level),
          whatsapp: p.whatsapp || "", // the quiz only fills this in when WhatsApp consent was given
          utm_content: p.utm_content || "",
          route: p.route || "",
        }),
      });
      hookOk = hook.ok;
      if (!hook.ok) console.error("Zapier hook failed:", hook.status, await hook.text());
    } catch (e) {
      console.error("Zapier hook error:", e);
    }
  }

  // 2c) Lead notification to Kenny by email (22 Oct 2026), with the quiz answers, the country
  //     and a one-tap WhatsApp link with the message already typed. Sent when the lead left a
  //     WhatsApp number (the quiz only fills p.whatsapp with WhatsApp consent). Set
  //     NOTIFY_ALL_QUALIFIED=1 to also get qualified leads without a number. Best effort;
  //     nothing is sent when RESEND_API_KEY or NOTIFY_TO is unset.
  let notifyOk = false;
  const wantNotify =
    !!p.whatsapp || (process.env.NOTIFY_ALL_QUALIFIED === "1" && !!p.qualified);
  if (wantNotify && process.env.RESEND_API_KEY && process.env.NOTIFY_TO) {
    try {
      notifyOk = await sendLeadNotification(p, geo);
    } catch (e) {
      console.error("Notify error:", e);
    }
  } else if (wantNotify) {
    console.log("Notify skipped: set RESEND_API_KEY and NOTIFY_TO in Netlify env vars");
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
    } else if (systemeEmailInvalid) {
      // The quiz asks the person to correct the address; the corrected submit sends the event
      // with the same event_id, so sending the wrong hash now would win the dedup.
      console.log("CAPI skipped: Systeme refused the email address, waiting for a corrected submit");
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
      else if (p.hobby) events.push(Object.assign({ event_name: "HobbyLead" }, base)); // route H, same event_id as the browser event
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

  console.log("Lead done:", { supabase: supabaseOk, systeme: systemeOk, capi: capiOk, notify: notifyOk, emailRefused: systemeEmailInvalid });

  return {
    statusCode: 200,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify({
      ok: !systemeEmailInvalid,
      reason: systemeEmailInvalid ? "invalid_email" : undefined,
      supabase: supabaseOk,
      systeme: systemeOk,
      capi: capiOk,
      consent: marketingOk,
      d_experienced: expD,
      hobby: !!p.hobby,
      budget: p.budget === true,
      hook: hookOk,
      notify: notifyOk,
    }),
  };
};
