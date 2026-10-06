// netlify/functions/he-purchase.js
// Harmonium Evolution — Purchase -> Meta Conversions API (relaunchplan, stap 37)
//
// Ontvangt de Systeme.io "New sale"-webhook (x-webhook-event: SALE_NEW) en
// stuurt server-side een Purchase naar Meta CAPI. Haalt fbc/fbp uit Supabase
// (bewaard bij de quiz-lead) voor sterke attributie, dedupt op order-ID tegen
// retries, en weegt payment plans 25% lager dan ineens-betalingen.
//
// Node 18+ (global fetch beschikbaar op Netlify). Geen extra packages nodig.
//
// Veldnamen + centen-conversie bevestigd met een echte testpayload (6 okt 2026).

const crypto = require('crypto');

const PIXEL_ID     = process.env.META_PIXEL_ID;        // 1777296816750878
const CAPI_TOKEN   = process.env.META_CAPI_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service-role key
const SUB_ID       = process.env.HE_WEBHOOK_SUB_ID;    // Systeme webhook-subscription-id (slot)
const TEST_CODE    = process.env.TEST_EVENT_CODE;      // tijdelijk tijdens testen; leeg = productie

const LEADS_TABLE   = 'quiz_leads';  // Supabase-tabel met email, fbc, fbp, created_at
const PLAN_DISCOUNT = 0.25;          // payment plan telt 25% lager richting Meta

const sha256 = (v) =>
  v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : undefined;

exports.handler = async (event) => {
  // 1. Alleen POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = event.headers || {};

  // 2. Slot: alleen berichten van JOUW Systeme-webhook (subscription-id) toelaten.
  //    Niemand anders kent deze waarde. (HMAC-verificatie kan later.)
  if (SUB_ID && headers['x-webhook-subscription-id'] !== SUB_ID) {
    console.log('Geweigerd: onbekende subscription-id', headers['x-webhook-subscription-id']);
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // 3. Alleen echte verkopen verwerken
  if (headers['x-webhook-event'] && headers['x-webhook-event'] !== 'SALE_NEW') {
    console.log('Overslaan: event is', headers['x-webhook-event']);
    return { statusCode: 200, body: 'ok (ander event)' };
  }

  // 4. Payload parsen
  let p;
  try {
    p = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('Kon payload niet parsen:', event.body);
    return { statusCode: 200, body: 'ok (unparseable)' };
  }

  // 5. Velden uithalen (bevestigd met echte testpayload)
  const email     = p.customer?.email;
  const firstName = p.customer?.fields?.first_name;
  const lastName  = p.customer?.fields?.surname;
  const orderId   = p.order?.id;
  const currency  = (p.pricePlan?.currency || 'usd').toLowerCase();

  // Bedrag staat in CENTEN -> /100
  const paidAmount = (p.order?.totalPrice != null) ? Number(p.order.totalPrice) / 100 : undefined;

  // Ineens vs plan: one_shot = ineens; alles anders = plan -> 25% lager signaal
  const planType = p.pricePlan?.type;                       // bv. 'one_shot'
  const isOneShot = planType === 'one_shot';
  const productName = p.pricePlan?.name || 'Harmonium Evolution';

  // 6. Geen e-mail of geen geldig bedrag -> niets sturen
  if (!email || paidAmount === undefined || paidAmount <= 0) {
    console.log('Overslaan: geen e-mail of bedrag <= 0', { email, paidAmount });
    return { statusCode: 200, body: 'ok (skipped)' };
  }

  // 7. Waarde naar Meta: ineens = betaald bedrag; plan = 25% lager
  const value = isOneShot
    ? Math.round(paidAmount)
    : Math.round(paidAmount * (1 - PLAN_DISCOUNT));

  // 8. Supabase: dedup-check + fbc/fbp ophalen
  let fbc, fbp;
  if (SUPABASE_URL && SUPABASE_KEY) {
    const sb = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    if (orderId) {
      try {
        const chk = await fetch(
          `${SUPABASE_URL}/rest/v1/he_purchase_log?order_id=eq.${encodeURIComponent(orderId)}&select=order_id`,
          { headers: sb }
        );
        const rows = await chk.json();
        if (Array.isArray(rows) && rows.length > 0) {
          console.log('Al verstuurd voor order', orderId, '— skip');
          return { statusCode: 200, body: 'ok (duplicate)' };
        }
      } catch (e) { console.error('Dedup-check faalde (ga door):', e); }
    }

    try {
      const lead = await fetch(
        `${SUPABASE_URL}/rest/v1/${LEADS_TABLE}?email=eq.${encodeURIComponent(email)}&select=fbc,fbp&order=created_at.desc&limit=1`,
        { headers: sb }
      );
      const rows = await lead.json();
      if (Array.isArray(rows) && rows[0]) { fbc = rows[0].fbc; fbp = rows[0].fbp; }
    } catch (e) { console.error('fbc/fbp-lookup faalde (ga door zonder):', e); }
  }

  // 9. CAPI-payload bouwen
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
      event_id: `he_purchase_${orderId || (email + '_' + Date.now())}`,
      user_data: userData,
      custom_data: {
        currency,
        value,
        content_name: productName,
        content_type: isOneShot ? 'fullpay' : 'payment_plan',
      },
    }],
  };
  if (TEST_CODE) body.test_event_code = TEST_CODE;

  // 10. Naar Meta CAPI
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    console.log('CAPI-resultaat:', JSON.stringify(await res.json()), '| value:', value, '| product:', productName);

    if (SUPABASE_URL && SUPABASE_KEY && orderId) {
      await fetch(`${SUPABASE_URL}/rest/v1/he_purchase_log`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates',
        },
        body: JSON.stringify({ order_id: String(orderId), email, amount: value }),
      });
    }
  } catch (e) {
    console.error('CAPI-call faalde:', e);
  }

  return { statusCode: 200, body: 'ok' };
};
