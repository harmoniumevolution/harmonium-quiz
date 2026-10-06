// netlify/functions/he-purchase.js
// Harmonium Evolution — Purchase -> Meta Conversions API (relaunchplan, stap 37)
//
// Ontvangt de Systeme.io "new sale"-webhook en stuurt server-side een Purchase
// naar Meta CAPI. Haalt fbc/fbp uit Supabase (bewaard bij de quiz-lead) voor
// sterke attributie, en dedupt op order-ID zodat Systeme-retries niet
// dubbel tellen.
//
// Node 18+ (global fetch beschikbaar op Netlify). Geen extra packages nodig.

const crypto = require('crypto');

const PIXEL_ID     = process.env.META_PIXEL_ID;        // 1777296816750878
const CAPI_TOKEN   = process.env.META_CAPI_TOKEN;      // bestaat al
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service-role key (server-side)
const SECRET       = process.env.HE_WEBHOOK_SECRET;    // zelfgekozen geheim

// ---- LET OP: pas deze twee aan je echte Supabase-schema aan ----
const LEADS_TABLE = 'quiz_leads';     // tabel waar de quiz-leads in staan
// kolommen die we verwachten: email, fbc, fbp, created_at
// ----------------------------------------------------------------

const sha256 = (v) =>
  v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : undefined;

// Haal een waarde op via meerdere mogelijke paden.
// De exacte payloadstructuur bevestig je bij de eerste echte test (zie de log hieronder).
const pick = (obj, paths) => {
  for (const p of paths) {
    const val = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
};

exports.handler = async (event) => {
  // 1. Alleen POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // 2. Simpele beveiliging: geheim token in de URL (?token=...)
  if (SECRET) {
    const token = (event.queryStringParameters || {}).token;
    if (token !== SECRET) return { statusCode: 401, body: 'Unauthorized' };
  }

  // 3. Payload parsen
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('Kon payload niet parsen:', event.body);
    return { statusCode: 200, body: 'ok (unparseable)' }; // 200 -> Systeme stopt met retryen
  }

  // 4. LOG de volledige payload — bij de eerste test zie je hier de echte structuur
  console.log('SYSTEME SALE PAYLOAD:', JSON.stringify(payload));

  // 5. Velden uithalen (paden defensief; bevestig/verfijn na de eerste log)
  const email     = pick(payload, ['customer.email','contact.email','order.customer.email','email']);
  const firstName = pick(payload, ['customer.first_name','contact.first_name','order.customer.first_name','first_name']);
  const lastName  = pick(payload, ['customer.last_name','contact.last_name','order.customer.last_name','last_name']);
  const amount    = pick(payload, ['order.amount','order.total','amount','total']);
  const orderId   = pick(payload, ['order.id','order.order_id','id','order_id']);
  const currency  = pick(payload, ['order.currency','currency']) || 'USD';

  // 6. Geen e-mail of bedrag <= 0 -> niets sturen (test-ping, gratis order, 100%-kortingstest)
  if (!email || amount === undefined || Number(amount) <= 0) {
    console.log('Overslaan: geen e-mail of bedrag <= 0', { email, amount });
    return { statusCode: 200, body: 'ok (skipped)' };
  }

  // 7. Supabase: dedup-check + fbc/fbp ophalen
  let fbc, fbp;
  if (SUPABASE_URL && SUPABASE_KEY) {
    const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    // 7a. Al verstuurd voor dit order-ID? (beschermt tegen Systeme-retries)
    if (orderId) {
      try {
        const chk = await fetch(
          `${SUPABASE_URL}/rest/v1/he_purchase_log?order_id=eq.${encodeURIComponent(orderId)}&select=order_id`,
          { headers: sbHeaders }
        );
        const rows = await chk.json();
        if (Array.isArray(rows) && rows.length > 0) {
          console.log('Al verstuurd voor order', orderId, '— skip');
          return { statusCode: 200, body: 'ok (duplicate)' };
        }
      } catch (e) { console.error('Dedup-check faalde (ga door):', e); }
    }

    // 7b. fbc/fbp ophalen uit de leads-tabel op e-mail (meest recente lead)
    try {
      const lead = await fetch(
        `${SUPABASE_URL}/rest/v1/${LEADS_TABLE}?email=eq.${encodeURIComponent(email)}&select=fbc,fbp&order=created_at.desc&limit=1`,
        { headers: sbHeaders }
      );
      const rows = await lead.json();
      if (Array.isArray(rows) && rows[0]) { fbc = rows[0].fbc; fbp = rows[0].fbp; }
    } catch (e) { console.error('fbc/fbp-lookup faalde (ga door zonder):', e); }
  }

  // 8. CAPI-payload bouwen
  const eventId = `he_purchase_${orderId || (email + '_' + Date.now())}`;
  const userData = {
    em:  [sha256(email)],
    fn:  firstName ? [sha256(firstName)] : undefined,
    ln:  lastName  ? [sha256(lastName)]  : undefined,
    fbc: fbc || undefined,
    fbp: fbp || undefined,
  };
  Object.keys(userData).forEach((k) => userData[k] === undefined && delete userData[k]);

  const body = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: 'https://harmoniumevolution.com/',
      event_id: eventId,
      user_data: userData,
      custom_data: { currency, value: Number(amount) },
    }],
    // test_event_code: 'TESTxxxxx',  // tijdelijk aanzetten om in Test Events te zien
  };

  // 9. Naar Meta CAPI
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    console.log('CAPI-resultaat:', JSON.stringify(await res.json()));

    // 10. Order-ID loggen zodat een retry na succes niet dubbel telt
    if (SUPABASE_URL && SUPABASE_KEY && orderId) {
      await fetch(`${SUPABASE_URL}/rest/v1/he_purchase_log`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates',
        },
        body: JSON.stringify({ order_id: String(orderId), email, amount: Number(amount) }),
      });
    }
  } catch (e) {
    // Tóch 200: anders retryt Systeme en riskeer je een dubbel event zodra het wél lukt.
    console.error('CAPI-call faalde:', e);
  }

  return { statusCode: 200, body: 'ok' };
};
