/* ═══════════════════════════════════════════════════════════════
   Netlify Function — Stedi real-time eligibility proxy
   Keeps STEDI_API_KEY server-side. The browser never sees it.
   POST /api/eligibility  ->  Stedi /change/medicalnetwork/eligibility/v3
   ═══════════════════════════════════════════════════════════════ */

const STEDI_URL =
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Use POST' }) };
  }

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

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Body is not valid JSON' }) }; }

  // Control number is required and must be 9 digits.
  if (!payload.controlNumber) {
    payload.controlNumber = String(Math.floor(100000000 + Math.random() * 899999999));
  }

  try {
    const started = Date.now();
    const res = await fetch(STEDI_URL, {
      method: 'POST',
      headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

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
