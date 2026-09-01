/* ═══════════════════════════════════════════════════════════════
   Netlify Function — Stedi insurance discovery proxy
   Keeps STEDI_API_KEY server-side. The browser never sees it.

   Finds a member's coverage from name/DOB/SSN/address and a rendering
   provider's NPI — no payer has to be selected first, and an incorrect
   or unknown payer on file doesn't block it. This is a different Stedi
   product from /api/eligibility (which needs a specific payer already
   picked); this one is how you find the payer in the first place.

   POST /api/insurance-discovery         -> starts a check
     -> Stedi POST /insurance-discovery/check/v1
     Stedi answers either right away (status COMPLETE) or, for a slower
     match, with status PENDING and a discoveryId to poll.

   GET  /api/insurance-discovery?id=...  -> polls a pending check
     -> Stedi GET /insurance-discovery/check/v1/{discoveryId}
   ═══════════════════════════════════════════════════════════════ */

const L = require('./_lib');

const STEDI_BASE = 'https://healthcare.us.stedi.com/2024-04-01/insurance-discovery/check/v1';

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  /* same-origin only — this endpoint returns PHI */
  'Access-Control-Allow-Origin': process.env.SITE_URL || 'null',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Use POST or GET' }) };
  }

  /* same session-or-throttle gate as /api/eligibility */
  let me = null, sessionsAvailable = false;
  try{
    if(process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL){
      sessionsAvailable = true;
      const gate = await L.requireSession(event);
      if(gate.error) return gate.error;
      me = gate.session;
    }
  }catch(e){
    console.warn('insurance-discovery: session check failed, falling back to address throttling', e.message);
    sessionsAvailable = false;
  }
  if(!sessionsAvailable){
    console.warn('insurance-discovery: running without a server session. '+
      'Connect DATABASE_URL to require a signed-in user.');
  }

  const throttleKey = me ? ('disc:'+me.id) : ('disc-ip:'+(L.clientIp(event)||'unknown'));
  const throttle = await L.rateLimit(throttleKey, 60, 60, 10)
    .catch(() => ({ blocked:false }));
  if(throttle.blocked)
    return { statusCode:429, headers:CORS,
             body: JSON.stringify({ error:'throttled', message:'Too many discovery checks this hour.' }) };

  const key = process.env.STEDI_API_KEY;
  if (!key) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: 'STEDI_API_KEY is not set',
        hint: 'Add it under Site configuration → Environment variables in Netlify, then redeploy.'
      })
    };
  }

  const started = Date.now();

  /* ── poll an existing check ── */
  if(event.httpMethod === 'GET'){
    const id = (event.queryStringParameters && event.queryStringParameters.id) || '';
    if(!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing ?id=<discoveryId>' }) };
    try{
      const res = await fetch(STEDI_BASE + '/' + encodeURIComponent(id), {
        method: 'GET',
        headers: { 'Authorization': key }
      });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return {
        statusCode: res.status,
        headers: CORS,
        body: JSON.stringify({ ...data, _meta: { ms: Date.now() - started, status: res.status } })
      };
    }catch(err){
      return { statusCode: 502, headers: CORS,
        body: JSON.stringify({ error: 'Could not reach Stedi', detail: String(err && err.message || err) }) };
    }
  }

  /* ── start a new check ── */
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Body is not valid JSON' }) }; }

  if(!payload || !payload.provider || !payload.provider.npi ||
     !payload.subscriber || !payload.subscriber.firstName || !payload.subscriber.lastName){
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'provider.npi, subscriber.firstName and subscriber.lastName are required' }) };
  }

  try {
    const res = await fetch(STEDI_BASE, {
      method: 'POST',
      headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    try{
      await L.audit(event, {
        actor_id: me ? me.id : null,
        actor: me ? me.username : 'unauthenticated',
        action:'insurance_discovery',
        entity:'patient', entity_id: null,
        phi: true, outcome: res.ok ? 'success' : 'failure',
        detail: { npi: payload.provider.npi, coveragesFound: data.coveragesFound, ms: Date.now() - started }
      });
    }catch(e){
      console.warn('insurance-discovery: check succeeded but was not audited —', e.message);
    }

    return {
      statusCode: res.status,
      headers: CORS,
      body: JSON.stringify({ ...data, _meta: { ms: Date.now() - started, status: res.status } })
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: 'Could not reach Stedi', detail: String(err && err.message || err) })
    };
  }
};
