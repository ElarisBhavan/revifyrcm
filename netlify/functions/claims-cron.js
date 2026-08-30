/* Nightly claim submission.
   Runs on a schedule, drains the queue, and sends each claim to Stedi using
   exactly the same mapping the manual button uses — one payload builder, so
   an automated claim and a hand-sent one are identical. */

const { toStedi } = require('./claims.js');
const L = require('./_lib.js');

const STEDI_URL = process.env.STEDI_CLAIMS_URL ||
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/professionalclaims/v3/submission';

/* Local hour, in the practice's own timezone. Netlify schedules in UTC, so the
   function wakes hourly and only works when the local hour matches — which
   keeps it correct across daylight saving without editing the cron. */
const TZ   = process.env.CLAIMS_TZ || 'America/Chicago';
const HOUR = parseInt(process.env.CLAIMS_CRON_HOUR || '21', 10);

function localHour(){
  try{
    return parseInt(new Intl.DateTimeFormat('en-GB',
      { timeZone: TZ, hour:'2-digit', hour12:false }).format(new Date()), 10);
  }catch(e){ return new Date().getUTCHours(); }
}

function apiKey(){
  return String(process.env.STEDI_API_KEY || '')
    .trim().replace(/^["']|["']$/g,'').trim().replace(/^Bearer\s+/i,'');
}

const Q = require('./_queue-store.js');

function isClaimResponse(d){
  return !!(d && typeof d === 'object' &&
    (d.claimReference || d.errors || d.status || d.x12 || d.meta));
}

/* Write the outcome back onto the real claim (app_records, kind='claim'), not
   just the queue's own copy. Without this the nightly run and "Send now"
   silently drift from what the claims screen shows: a claim that was in fact
   sent or rejected still reads "ready to submit" forever, and reopening it
   shows none of the payer's reasons, because those lived only in the queue's
   private history log. */
async function syncClaim(sql, claimId, status, note, extra){
  if(!sql || claimId == null) return;
  try{
    const rows = await sql`select data from app_records
      where kind='claim' and id=${Number(claimId)} and deleted_at is null`;
    if(!rows.length) return;
    const rec = rows[0].data || {};
    rec.status = status;
    rec.history = [{ at:new Date().toISOString(), by:'system', what:'status',
                     detail:status + (note?' — '+note:'') }].concat(rec.history||[]);
    rec.updated_at = new Date().toISOString();
    if(extra) Object.assign(rec, extra);
    await sql`update app_records set data=${sql.json(rec)}, status=${status},
      updated_at=now() where kind='claim' and id=${Number(claimId)}`;
  }catch(e){ console.error('claims-cron: could not sync claim '+claimId, e.message); }
}

exports.handler = async (event) => {
  const forced = !!(event && (event.forced ||
    (event.queryStringParameters||{}).force === '1'));

  /* The nightly wake-up carries no cookie — Netlify's own scheduler calls
     this, not a browser — so only the human-triggered "Send now" path is
     required to prove who it is. */
  if(forced){
    const me = await L.session(event).catch(()=>null);
    if(!me) return { statusCode:401, body: JSON.stringify({ error:'unauthenticated' }) };
  }

  const hour = localHour();

  if(!forced && hour !== HOUR){
    return { statusCode:200, body: JSON.stringify({
      skipped:true, reason:'not the submission hour',
      localHour:hour, submitAt:HOUR, timezone:TZ }) };
  }

  let sql = null;
  try{ sql = L.db(); }catch(e){ sql = null; }

  const key = apiKey();
  if(!key) return { statusCode:200, body: JSON.stringify({
    error:'not_configured', message:'STEDI_API_KEY is not set.' }) };

  let s;
  try{ s = await Q.open(); }
  catch(err){
    return { statusCode:200, body: JSON.stringify({
      error: err.reason || 'no_storage',
      message: String(err.message),
      tried: err.tried || undefined }) };
  }

  const keys = await s.list();

  /* A readable, sequential batch number: RF-20260819-01 for the first run that
     day. Quoting it is how a biller ties a claim back to a run. */
  function stampDay(){
    try{
      const p = new Intl.DateTimeFormat('en-CA',
        { timeZone:TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
      return p.replace(/-/g,'');
    }catch(e){ return new Date().toISOString().slice(0,10).replace(/-/g,''); }
  }
  const log = (await s.get('_runs').catch(()=>null)) || { runs:[] };
  const day = stampDay();
  const todayRuns = log.runs.filter(r => String(r.batch||'').indexOf('RF-'+day) === 0).length;
  const batch = 'RF-' + day + '-' + String(todayRuns + 1).padStart(2,'0');

  const results = { batch, ran_at:new Date().toISOString(), timezone:TZ, localHour:hour,
                    trigger: forced ? 'manual' : 'automatic',
                    sent:0, rejected:0, failed:0, skipped:0, detail:[] };

  for(const bk of keys){
    /* the run log lives in the same store; it is not a claim */
    if(String(bk).charAt(0) === '_') continue;

    const entry = await s.get(bk).catch(()=>null);
    if(!entry || !entry.claim){ continue; }
    if(entry.status === 'sent' || entry.status === 'rejected'){ results.skipped++; continue; }

    /* Five failures and it stops trying — an endlessly retried claim that a
       payer keeps refusing is noise, not persistence. */
    if((entry.attempts||0) >= 5){
      results.skipped++;
      results.detail.push({ claim:entry.claim.claim_no, outcome:'given up after 5 attempts' });
      continue;
    }

    const claim = entry.claim;
    const payload = toStedi(claim);
    const idem = String(claim.claim_no || claim.control || bk)
      .replace(/[^A-Za-z0-9._-]/g,'').slice(0,64) || ('rf'+Date.now().toString(36));

    try{
      const res = await fetch(STEDI_URL, {
        method:'POST',
        headers:{ 'Authorization':key, 'Content-Type':'application/json',
                  'Idempotency-Key':idem },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      let data = {};
      try{ data = JSON.parse(text); }catch{ data = { raw:text.slice(0,300) }; }

      const processed = isClaimResponse(data);
      const errs = (data.errors||[]).map(e =>
        (e.code?e.code+' ':'')+(e.description||e.message||''));
      const rejItems = (data.errors||[]).map(e => ({
        code: e.code || e.errorCode || undefined,
        message: e.description || e.message || e.reason || '' }));
      const ref = (data.claimReference||{});

      if(processed && !errs.length && res.ok){
        await s.set(bk, { ...entry, status:'sent',
          sent_at:new Date().toISOString(),
          stedi_claim_no: ref.rhclaimNumber || ref.correlationId || '',
          attempts:(entry.attempts||0)+1 });
        results.sent++;
        results.detail.push({ claim:claim.claim_no, outcome:'sent',
          reference: ref.rhclaimNumber || ref.correlationId || '' });
        await syncClaim(sql, claim.id, 'submitted',
          'Sent via ' + (forced ? 'manual run' : 'automatic nightly run') +
          ' · batch ' + batch + (ref.rhclaimNumber||ref.correlationId
            ? ' · ' + (ref.rhclaimNumber||ref.correlationId) : ''),
          { stedi_claim_no: ref.rhclaimNumber || ref.correlationId || '',
            correlationId: ref.correlationId || '', rejections: null,
            submitted_at: new Date().toISOString() });
      }else if(processed){
        /* the payer looked at it and refused — retrying will not help */
        await s.set(bk, { ...entry, status:'rejected',
          rejected_at:new Date().toISOString(),
          errors:errs, stedi_claim_no: ref.rhclaimNumber || '',
          attempts:(entry.attempts||0)+1 });
        results.rejected++;
        results.detail.push({ claim:claim.claim_no, outcome:'rejected', errors:errs });
        await syncClaim(sql, claim.id, 'rejected', errs.join(' · ').slice(0,300),
          { stedi_claim_no: ref.rhclaimNumber || '', rejections: rejItems,
            rejected_at: new Date().toISOString() });
      }else{
        await s.set(bk, { ...entry, status:'pending',
          attempts:(entry.attempts||0)+1,
          last_error:(data.message||data.error||('HTTP '+res.status)),
          last_tried:new Date().toISOString() });
        results.failed++;
        results.detail.push({ claim:claim.claim_no, outcome:'failed',
          error:(data.message||data.error||('HTTP '+res.status)) });
      }
    }catch(err){
      await s.set(bk, { ...entry, status:'pending',
        attempts:(entry.attempts||0)+1, last_error:String(err.message||err),
        last_tried:new Date().toISOString() });
      results.failed++;
      results.detail.push({ claim:claim.claim_no, outcome:'failed', error:String(err.message||err) });
    }
  }

  /* Keep a history the interface can show. Empty runs are not recorded —
     an hourly wake-up with nothing queued is noise, not history. */
  try{
    if(results.sent || results.rejected || results.failed){
      log.runs.unshift(results);
      log.runs = log.runs.slice(0, 200);
      await s.set('_runs', log);
    }
    await s.set('_lastrun', results);
  }catch(e){}

  console.log('ReviFlow nightly claims:', JSON.stringify({
    sent:results.sent, rejected:results.rejected, failed:results.failed }));

  return { statusCode:200, body: JSON.stringify(results) };
};
