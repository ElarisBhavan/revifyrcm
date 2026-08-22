/* Nightly remittance collection.
   Asks Stedi what the payers have sent and stores each one, so a biller opens
   the payments screen to remittances already waiting rather than having to go
   and fetch them.

   Posting still happens in the browser, deliberately: applying money to a
   patient's account is a decision, and a claim matched by the wrong control
   number should be caught by a person, not silently posted overnight. */

const Q = require('./_queue-store.js');
const { summarise } = require('./era.js');

const BASE = process.env.STEDI_REPORTS_URL ||
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2';

const TZ   = process.env.CLAIMS_TZ || 'America/Chicago';
/* an hour after the claims run, so the two never overlap */
const HOUR = parseInt(process.env.ERA_CRON_HOUR || '22', 10);

function apiKey(){
  return String(process.env.STEDI_API_KEY || '')
    .trim().replace(/^["']|["']$/g,'').trim().replace(/^Bearer\s+/i,'');
}

function localHour(){
  try{
    return parseInt(new Intl.DateTimeFormat('en-GB',
      { timeZone: TZ, hour:'2-digit', hour12:false }).format(new Date()), 10);
  }catch(e){ return new Date().getUTCHours(); }
}

exports.handler = async (event) => {
  const forced = !!(event && (event.forced ||
    (event.queryStringParameters||{}).force === '1'));
  const hour = localHour();

  if(!forced && hour !== HOUR){
    return { statusCode:200, body: JSON.stringify({
      skipped:true, reason:'not the collection hour',
      localHour:hour, collectAt:HOUR, timezone:TZ }) };
  }

  const key = apiKey();
  if(!key) return { statusCode:200, body: JSON.stringify({
    error:'not_configured', message:'STEDI_API_KEY is not set.' }) };

  let s;
  try{ s = await Q.open(); }
  catch(err){
    return { statusCode:200, body: JSON.stringify({
      error: err.reason || 'no_storage', message:String(err.message) }) };
  }

  const result = { ran_at:new Date().toISOString(), timezone:TZ, localHour:hour,
                   found:0, stored:0, skipped:0, failed:0, detail:[] };

  try{
    const r = await fetch(BASE + '?reportTypeCode=835', { headers:{ 'Authorization': key } });
    const text = await r.text();
    let data = {}; try{ data = JSON.parse(text); }catch{ data = { raw:text.slice(0,300) }; }

    if(!r.ok){
      return { statusCode:200, body: JSON.stringify({
        ...result, error:'stedi', status:r.status,
        message: data.message || data.error || 'Could not list remittances' }) };
    }

    const reports = data.reports || data.items || [];
    result.found = reports.length;

    for(const rep of reports){
      const id = rep.reportId || rep.fileName || rep.id;
      if(!id) continue;
      const k = 'era_' + String(id).replace(/[^A-Za-z0-9._-]/g,'');

      /* already collected on an earlier run */
      const seen = await s.get(k).catch(()=>null);
      if(seen){ result.skipped++; continue; }

      try{
        const g = await fetch(BASE + '/' + encodeURIComponent(id) + '/835',
          { headers:{ 'Authorization': key } });
        const gt = await g.text();
        let gd = {}; try{ gd = JSON.parse(gt); }catch{ gd = null; }
        if(!g.ok || !gd){
          result.failed++;
          result.detail.push({ id, outcome:'could not fetch' });
          continue;
        }

        const era = summarise(gd);
        await s.set(k, {
          id, collected_at:new Date().toISOString(),
          status:'waiting',            /* a person still posts it */
          payer: era.payer, reference: era.reference,
          total: era.total_paid, claims: era.claims.length,
          remittance: era
        });
        result.stored++;
        result.detail.push({ id, payer:era.payer, reference:era.reference,
                             total:era.total_paid, claims:era.claims.length });
      }catch(err){
        result.failed++;
        result.detail.push({ id, outcome:String(err.message || err) });
      }
    }

    try{ await s.set('_era_lastrun', result); }catch(e){}
    console.log('ReviFlow nightly remittances:', JSON.stringify({
      found:result.found, stored:result.stored, skipped:result.skipped }));

    return { statusCode:200, body: JSON.stringify(result) };
  }catch(err){
    return { statusCode:200, body: JSON.stringify({
      ...result, error:'upstream', message:String(err.message || err) }) };
  }
};
