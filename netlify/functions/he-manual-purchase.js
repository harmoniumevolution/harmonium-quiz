// netlify/functions/he-manual-purchase.js
//
// Handmatige verkopen (Revolut, Wise, overschrijving) -> Meta Conversions API.
// Hoort bij stap 37 van het relaunchplan: tweede ingang naast he-purchase.js
// (die door de Systeme "New sale"-webhook gevoed wordt). Afgestemd op lead.js:
// zelfde Supabase-URL, zelfde env-variabelen, zelfde Graph-versie, zelfde Systeme-helpers.
//
// Aangeroepen door Zapier:
//   Google Sheets "New Spreadsheet Row" -> Webhooks by Zapier (POST, json) -> deze Function
//
// Wat hij doet, in volgorde:
//   1. sleutel controleren (header x-manual-key = MANUAL_SALE_KEY)
//   2. invoer valideren; betaalmoment mag max. 7 dagen oud zijn (ouder gooit Meta weg)
//   3. lead opzoeken in Supabase quiz_leads op e-mail: fbc, fbp, marketing_consent, country, first_name
//   4. dedup op referentie via tabel manual_sales (zie manual_sales.sql)
//   5. Purchase naar de Conversions API (overgeslagen bij geweigerde marketing, zoals lead.js)
//   6. tag "customer" zetten in Systeme, op naam opgezocht zoals in lead.js (stap 35);
//      bestaat het contact nog niet (koper zonder quiz), dan wordt het aangemaakt met voornaam
//   7. rij loggen in manual_sales
//
// Omgevingsvariabelen in Netlify:
//   MANUAL_SALE_KEY        NIEUW: lange willekeurige sleutel, dezelfde in de Zap
//   META_PIXEL_ID          bestaand (stap 3a)
//   META_CAPI_TOKEN        bestaand (stap 3b)
//   SUPABASE_SERVICE_KEY   bestaand (service role)
//   SYSTEME_API_KEY        bestaand (stap 18)
//   SYSTEME_CUSTOMER_TAG   optioneel, naam van de klant-tag, default "customer"
//   META_TEST_EVENT_CODE   optioneel, net als in lead.js: gezet = alles naar Test Events
//
// Body (JSON) vanuit Zapier:
// {
//   "email": "jane@example.com",               verplicht, zoals ingevuld in de quiz
//   "first_name": "Jane",                      optioneel (anders uit quiz_leads)
//   "last_name": "Doe",                        optioneel
//   "country": "AU",                           optioneel, 2 letters (anders uit quiz_leads)
//   "amount": 699,                             verplicht: totale dealwaarde
//   "currency": "USD",                         verplicht
//   "product": "Harmonium Evolution Complete", optioneel
//   "reference": "WISE-20261027-JANE",         verplicht, uniek (Revolut/Wise-referentie)
//   "plan": false,                             true bij afbetaling -> waarde x0,75 (zoals he-purchase.js)
//   "paid_at": "27-10-2026 10:15",             echte betaalmoment; leeg = nu. Mag ook "27/10/2026",
//                                              "2026-10-27 10:15" of ISO met tijdzone. Zonder tijdzone
//                                              = Nederlandse tijd (zomer/wintertijd automatisch)
//   "payment_method": "wise",                  vrij veld, alleen voor de log
//   "consent": true,                           optioneel; false forceert "geen Meta-event"
//   "test_event_code": "TEST12345"             optioneel, per rij naar Test Events
// }

const crypto = require("crypto");

const SYSTEME_BASE = "https://api.systeme.io/api";
const SUPABASE_URL = "https://amrvuxvlsebrznwcqhij.supabase.co"; // zelfde als lead.js
const GRAPH_VERSION = "v21.0";                                     // zelfde als lead.js; samen verhogen

const MAX_AGE_DAYS = 7;    // harde grens van Meta
const PLAN_WEIGHT = 0.75;  // afbetaling telt 25% lager, zelfde regel als he-purchase.js

// ---------- helpers (zelfde stijl als lead.js) ----------

function sha256(s) {
  return crypto.createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex");
}

function sameEmail(a, b) {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

const norm = (v) => (v == null ? "" : String(v).trim().toLowerCase());
const isTrue = (v) => ["true", "1", "yes", "ja", "y"].includes(norm(v));

// ---------- datum uit de sheet ----------
// Google Sheets zet een getypte datum om naar zijn eigen notatie (bv. "27-10-2026 9:45:00"),
// dus hier worden de gangbare vormen geaccepteerd:
//   ISO met tijdzone      2026-10-27T10:15:00+01:00  (wordt letterlijk gelezen)
//   jaar eerst            2026-10-27 10:15 / 2026-10-27
//   Nederlands            27-10-2026 10:15 / 27/10/2026 / 27.10.2026
//   Amerikaans            10/27/2026 10:15 (herkend als de tweede waarde groter dan 12 is)
// Zonder tijdzone wordt de tijd gelezen als Nederlandse tijd (Europe/Amsterdam).

function amsterdamOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Amsterdam", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const g = {};
  for (const p of parts) g[p.type] = p.value;
  const asUTC = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute, +g.second);
  return (asUTC - date.getTime()) / 60000;
}

// Nederlandse klokstand -> echt tijdstip, ook op de dag van de zomer/wintertijdwissel.
function fromAmsterdam(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = amsterdamOffsetMinutes(new Date(guess));
  const utc1 = guess - off1 * 60000;
  const off2 = amsterdamOffsetMinutes(new Date(utc1));
  return new Date(off1 === off2 ? utc1 : guess - off2 * 60000);
}

function parsePaidAt(raw) {
  const s = String(raw || "").trim();
  if (!s) return new Date();

  // ISO met expliciete tijdzone: JS leest dit correct.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s);

  const time = "(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?$";
  let y, mo, d, h = 0, mi = 0, sec = 0;

  let m = s.match(new RegExp("^(\\d{4})-(\\d{1,2})-(\\d{1,2})" + time));
  if (m) {
    [y, mo, d] = [+m[1], +m[2], +m[3]];
    [h, mi, sec] = [+(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
  } else {
    m = s.match(new RegExp("^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})" + time));
    if (!m) return new Date(NaN);
    const a = +m[1], b = +m[2];
    y = +m[3];
    if (a > 12) [d, mo] = [a, b];        // 27-10-2026: dag eerst
    else if (b > 12) [mo, d] = [a, b];   // 10/27/2026: maand eerst (Amerikaans)
    else [d, mo] = [a, b];               // twijfel: Nederlands, dag eerst
    [h, mi, sec] = [+(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return new Date(NaN);
  return fromAmsterdam(y, mo, d, h, mi, sec);
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function supaHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: "Bearer " + process.env.SUPABASE_SERVICE_KEY,
    "Content-Type": "application/json",
  };
}

// Laatste quiz-lead met dit e-mailadres (hoofdletterongevoelig).
async function findLead(email) {
  const url =
    SUPABASE_URL + "/rest/v1/quiz_leads" +
    "?select=fbc,fbp,marketing_consent,country,first_name" +
    "&email=ilike." + encodeURIComponent(email) +
    "&order=created_at.desc&limit=1";
  const r = await fetch(url, { headers: supaHeaders() });
  if (!r.ok) throw new Error("Supabase quiz_leads " + r.status);
  const rows = await r.json();
  return rows[0] || null;
}

async function alreadyLogged(reference) {
  const url =
    SUPABASE_URL + "/rest/v1/manual_sales" +
    "?select=reference,meta_sent&reference=eq." + encodeURIComponent(reference) + "&limit=1";
  const r = await fetch(url, { headers: supaHeaders() });
  if (!r.ok) throw new Error("Supabase manual_sales " + r.status);
  const rows = await r.json();
  return rows[0] || null;
}

async function logSale(row) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/manual_sales", {
    method: "POST",
    headers: { ...supaHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error("Supabase insert " + r.status + ": " + (await r.text()));
}

async function sendPurchase(p) {
  const user_data = {
    em: [sha256(p.email)],
    fn: p.firstName ? [sha256(p.firstName)] : undefined,
    ln: p.lastName ? [sha256(p.lastName)] : undefined,
    country: p.country ? [sha256(p.country)] : undefined,
    fbc: p.fbc || undefined,
    fbp: p.fbp || undefined,
  };
  const body = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(p.paidAt.getTime() / 1000),
        event_id: "manual-" + p.reference,   // zelfde id bij een retry = geen dubbele telling
        action_source: p.actionSource,        // verkoop na een call, dus geen "website"
        user_data,
        custom_data: {
          currency: p.currency,
          value: Number(p.value.toFixed(2)),
          content_name: p.product,
          content_type: "product",
          order_id: p.reference,
        },
      },
    ],
  };
  const testCode = p.testCode || process.env.META_TEST_EVENT_CODE;
  if (testCode) body.test_event_code = testCode;

  const r = await fetch(
    "https://graph.facebook.com/" + GRAPH_VERSION + "/" + process.env.META_PIXEL_ID +
      "/events?access_token=" + encodeURIComponent(process.env.META_CAPI_TOKEN),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const text = await r.text();
  console.log("CAPI response:", r.status, text);
  if (!r.ok) throw new Error("Meta " + r.status + ": " + text);
  let out = {};
  try { out = JSON.parse(text); } catch { /* leeg laten */ }
  return { ...out, test: !!testCode };
}

// ---------- Systeme (gekopieerd uit lead.js) ----------

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

// Anders dan in lead.js wordt een foutstatus van Systeme hier als fout gemeld,
// niet als "niet gevonden", zodat je in het Zap-antwoord ziet wat er echt gebeurde.
async function findContactByEmail(email) {
  const res = await systeme("/contacts?email=" + encodeURIComponent(email));
  if (!res.ok) throw new Error("Systeme contact lookup " + res.status + ": " + (await res.text()));
  const data = await res.json();
  const items = Array.isArray(data) ? data : data.items || [];
  return items.find((c) => sameEmail(c.email, email)) || null;
}

// Contact aanmaken als het nog niet bestaat (koper die nooit de quiz deed), met voornaam.
async function createContact(email, firstName) {
  const res = await systeme("/contacts", { method: "POST", body: JSON.stringify({ email }) });
  if (!res.ok) throw new Error("Systeme contact aanmaken " + res.status + ": " + (await res.text()));
  const created = await res.json();
  if (firstName && created && created.id) {
    const patch = await systeme("/contacts/" + created.id, {
      method: "PATCH",
      contentType: "application/merge-patch+json",
      body: JSON.stringify({ fields: [{ slug: "first_name", value: firstName }] }),
    });
    if (!patch.ok) console.error("Systeme first_name update failed:", patch.status, await patch.text());
  }
  return created;
}

// Tag "customer" zetten zodat de koper uit de verkoopreeksen valt (stap 35).
async function tagCustomer(email, firstName) {
  if (!process.env.SYSTEME_API_KEY) return "overgeslagen (SYSTEME_API_KEY ontbreekt)";
  const tagName = (process.env.SYSTEME_CUSTOMER_TAG || "customer").toLowerCase();
  let contact = await findContactByEmail(email);
  let created = false;
  if (!contact) {
    contact = await createContact(email, firstName);
    created = true;
  }
  if (!contact || !contact.id) return "contact niet gevonden en aanmaken gaf geen id terug";
  const tagId = (await getTagMap())[tagName];
  if (!tagId) return 'tag "' + tagName + '" niet gevonden in Systeme' + (created ? " (contact wel aangemaakt)" : "");
  const t = await systeme("/contacts/" + contact.id + "/tags", {
    method: "POST",
    body: JSON.stringify({ tagId }),
  });
  if (!t.ok) throw new Error("Systeme tag " + t.status + ": " + (await t.text()));
  return (created ? "contact aangemaakt, " : "") + 'tag "' + tagName + '" gezet op contact ' + contact.id;
}

// ---------- handler ----------

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "alleen POST" });
  if (!process.env.MANUAL_SALE_KEY) return json(500, { error: "MANUAL_SALE_KEY ontbreekt in Netlify" });
  if (!process.env.META_PIXEL_ID || !process.env.META_CAPI_TOKEN || !process.env.SUPABASE_SERVICE_KEY) {
    return json(500, { error: "META_PIXEL_ID, META_CAPI_TOKEN of SUPABASE_SERVICE_KEY ontbreekt" });
  }

  // 1. sleutel
  const key = (event.headers || {})["x-manual-key"];
  if (!key || key !== process.env.MANUAL_SALE_KEY) return json(401, { error: "ongeldige sleutel" });

  // 2. invoer
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "body is geen JSON" });
  }

  // Zelfde e-mailnormalisatie als lead.js, zodat de lookup in quiz_leads matcht.
  const email = String(body.email || "").trim().toLowerCase().replace(/[.,;]+$/, "");
  const amount = Number(String(body.amount ?? "").replace(",", "."));
  const currency = norm(body.currency).toUpperCase();
  const reference = String(body.reference || "").trim();
  const plan = isTrue(body.plan);
  const product = String(body.product || "Harmonium Evolution Complete").trim();
  const paymentMethod = String(body.payment_method || "manual").trim();
  const actionSource = String(body.action_source || "phone_call").trim();
  const testCode = body.test_event_code ? String(body.test_event_code).trim() : null;

  if (!email.includes("@")) return json(400, { error: "email ontbreekt of is ongeldig" });
  if (!(amount > 0)) return json(400, { error: "amount moet groter zijn dan 0" });
  if (!/^[A-Z]{3}$/.test(currency)) return json(400, { error: "currency moet 3 letters zijn (USD, EUR)" });
  if (!reference) return json(400, { error: "reference ontbreekt (Revolut/Wise-referentie)" });

  const paidAt = parsePaidAt(body.paid_at);
  if (Number.isNaN(paidAt.getTime())) {
    return json(400, {
      error: 'paid_at "' + String(body.paid_at) + '" is geen geldige datum; gebruik bv. 27-10-2026 10:15',
    });
  }
  const ageDays = (Date.now() - paidAt.getTime()) / 86400000;
  if (ageDays > MAX_AGE_DAYS) {
    return json(400, { error: "betaling is " + ageDays.toFixed(1) + " dagen oud; Meta accepteert maximaal " + MAX_AGE_DAYS + " dagen" });
  }
  if (ageDays < -0.1) return json(400, { error: "paid_at ligt in de toekomst" });

  // 3. lead + 4. dedup. Supabase down (gepauzeerd?) = fout terug, dan kan Zapier de rij opnieuw sturen.
  let lead = null;
  let existing = null;
  try {
    lead = await findLead(email);
    existing = await alreadyLogged(reference);
  } catch (e) {
    console.error("Supabase error:", e);
    return json(502, {
      error: "Supabase antwoordt niet (project gepauzeerd?). Niets verstuurd; stuur de rij later opnieuw vanuit Zapier.",
      detail: e.message,
    });
  }
  if (existing) {
    return json(200, { ok: true, meta: "duplicate", note: "referentie " + reference + " was al verwerkt, niets opnieuw verstuurd" });
  }

  // Zelfde consentregel als lead.js: alleen een expliciete false blokkeert.
  const consentRefused =
    (lead && lead.marketing_consent === false) || (body.consent != null && !isTrue(body.consent));
  const firstName = body.first_name || (lead && lead.first_name) || "";
  const lastName = body.last_name || "";
  const country = String(body.country || (lead && lead.country) || "").slice(0, 2);
  const value = plan ? amount * PLAN_WEIGHT : amount;

  // 5. Meta
  let metaStatus = "skipped";
  let metaNote = "";
  if (consentRefused) {
    metaNote = "marketing geweigerd (cookie-consent), geen CAPI-event";
  } else {
    try {
      const out = await sendPurchase({
        email, firstName, lastName, country,
        fbc: lead && lead.fbc ? lead.fbc : null,
        fbp: lead && lead.fbp ? lead.fbp : null,
        value, currency, product, reference, paidAt, actionSource, testCode,
      });
      metaStatus = "sent";
      metaNote = "events_received=" + (out.events_received ?? "?") + (out.test ? " (test)" : "");
    } catch (e) {
      return json(502, { error: "Meta weigerde het event; niets gelogd, stuur de rij opnieuw", detail: e.message });
    }
  }

  // 6. Systeme-tag (niet fataal)
  let systemeNote;
  try {
    systemeNote = await tagCustomer(email, firstName);
  } catch (e) {
    console.error("Systeme tag error:", e);
    systemeNote = "fout: " + e.message;
  }

  // 7. log
  const row = {
    reference,
    email,
    amount,
    currency,
    product,
    plan,
    paid_at: paidAt.toISOString(),
    payment_method: paymentMethod,
    meta_sent: metaStatus === "sent",
    meta_note: metaNote,
    lead_matched: !!lead,
    systeme_note: systemeNote,
  };
  try {
    await logSale(row);
  } catch (e) {
    // Meta is al verstuurd; melden maar niet falen (een retry wordt door Meta op event_id ontdubbeld)
    console.error("Log error:", e);
    return json(200, { ok: true, meta: metaStatus, warning: "verstuurd naar Meta maar niet gelogd in manual_sales: " + e.message });
  }

  console.log("Manual sale done:", { reference, email, meta: metaStatus, lead: !!lead, systeme: systemeNote });

  return json(200, {
    ok: true,
    meta: metaStatus,
    meta_note: metaNote,
    value_sent: metaStatus === "sent" ? Number(value.toFixed(2)) : null,
    currency,
    lead_matched: !!lead,
    fbc: !!(lead && lead.fbc),
    fbp: !!(lead && lead.fbp),
    systeme: systemeNote,
  });
};
