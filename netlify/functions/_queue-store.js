/* ═══════════════════════════════════════════════════════════════
   Storage for the claim queue.

   Three routes, tried in order, so the queue works on whatever the
   deployment actually provides:

     1. Netlify Blobs, configured automatically by the runtime
     2. Netlify Blobs, with siteID and token supplied by hand
     3. Postgres, which this project already depends on

   Each exposes the same four calls: get, set, del, list.
   ═══════════════════════════════════════════════════════════════ */

const NAME = 'claim-queue';

function env(...names){
  for(const n of names){
    const v = process.env[n];
    if(v && String(v).trim()) return String(v).trim();
  }
  return '';
}

/* ── Netlify Blobs ── */
async function blobs(){
  let mod;
  try{ mod = await import('@netlify/blobs'); }
  catch(e){
    const err = new Error('The @netlify/blobs package is not installed on this deploy.');
    err.reason = 'package_missing'; err.detail = String(e && e.message || e);
    throw err;
  }

  const siteID = env('NETLIFY_BLOBS_SITE_ID','NETLIFY_SITE_ID','SITE_ID');
  const token  = env('NETLIFY_BLOBS_TOKEN','NETLIFY_API_TOKEN','NETLIFY_AUTH_TOKEN');

  /* automatic first — inside a Netlify function this normally just works */
  try{
    const s = mod.getStore({ name:NAME, consistency:'strong' });
    await s.get('_probe').catch(()=>null);   /* prove it is really wired up */
    return wrapBlob(s, 'blobs-auto');
  }catch(e){
    if(!siteID || !token){
      const err = new Error(
        'Netlify Blobs is not configured automatically on this deploy, and no '
        + 'siteID or token was supplied. Set NETLIFY_SITE_ID and NETLIFY_API_TOKEN '
        + 'in the site environment, or set DATABASE_URL to use Postgres instead.');
      err.reason = 'blobs_unconfigured'; err.detail = String(e && e.message || e);
      throw err;
    }
  }

  /* explicit credentials, exactly as the error message asks for */
  try{
    const s = mod.getStore({ name:NAME, consistency:'strong', siteID, token });
    await s.get('_probe').catch(()=>null);
    return wrapBlob(s, 'blobs-manual');
  }catch(e){
    const err = new Error('Netlify Blobs refused the supplied siteID and token.');
    err.reason = 'blobs_rejected'; err.detail = String(e && e.message || e);
    throw err;
  }
}

function wrapBlob(s, kind){
  return {
    kind,
    async get(k){ return s.get(k, { type:'json' }).catch(()=>null); },
    async set(k,v){ return s.setJSON(k, v); },
    async del(k){ return s.delete(k); },
    async list(){
      const { blobs } = await s.list();
      return blobs.map(b => b.key);
    }
  };
}

/* ── Postgres ── */
async function pg(){
  const url = env('DATABASE_URL','NETLIFY_DATABASE_URL');
  if(!url){
    const err = new Error('DATABASE_URL is not set.');
    err.reason = 'no_database';
    throw err;
  }
  let postgres;
  try{ postgres = require('postgres'); }
  catch(e){
    const err = new Error('The postgres package is not installed.');
    err.reason = 'package_missing'; err.detail = String(e && e.message || e);
    throw err;
  }
  const sql = postgres(url, { ssl:'require', max:1, idle_timeout:10 });
  await sql`create table if not exists claim_queue(
    k text primary key,
    v jsonb not null,
    updated_at timestamptz not null default now()
  )`;
  return {
    kind:'postgres',
    async get(k){
      const r = await sql`select v from claim_queue where k = ${k}`;
      return r.length ? r[0].v : null;
    },
    async set(k,v){
      await sql`insert into claim_queue (k, v, updated_at)
                values (${k}, ${sql.json(v)}, now())
                on conflict (k) do update
                set v = excluded.v, updated_at = now()`;
    },
    async del(k){ await sql`delete from claim_queue where k = ${k}`; },
    async list(){
      const r = await sql`select k from claim_queue order by updated_at`;
      return r.map(x => x.k);
    }
  };
}

/* ── whichever works ── */
let cached = null;
async function open(){
  if(cached) return cached;
  const tried = [];
  try{ cached = await blobs(); return cached; }
  catch(e){ tried.push({ store:'blobs', reason:e.reason, message:e.message, detail:e.detail }); }
  try{ cached = await pg(); return cached; }
  catch(e){ tried.push({ store:'postgres', reason:e.reason, message:e.message }); }

  const err = new Error('No storage is available for the claim queue.');
  err.reason = 'no_storage';
  err.tried = tried;
  throw err;
}

/* what is configured, without throwing */
async function diagnose(){
  const out = {
    submitHour: process.env.CLAIMS_CRON_HOUR || '21',
    timezone: process.env.CLAIMS_TZ || 'America/Chicago',
    hasApiKey: !!process.env.STEDI_API_KEY,
    siteIdSet: !!env('NETLIFY_BLOBS_SITE_ID','NETLIFY_SITE_ID','SITE_ID'),
    tokenSet: !!env('NETLIFY_BLOBS_TOKEN','NETLIFY_API_TOKEN','NETLIFY_AUTH_TOKEN'),
    databaseUrlSet: !!env('DATABASE_URL','NETLIFY_DATABASE_URL'),
    store: null, canWrite: false, tried: []
  };
  try{
    const s = await open();
    out.store = s.kind;
    await s.set('_selftest', { at:new Date().toISOString() });
    const back = await s.get('_selftest');
    out.canWrite = !!back;
    await s.del('_selftest');
    out.fix = 'Nothing to fix — the queue is working.';
  }catch(e){
    out.tried = e.tried || [{ reason:e.reason, message:e.message }];
    out.fix = out.databaseUrlSet
      ? 'Postgres is configured but did not open. Check DATABASE_URL.'
      : 'Set NETLIFY_SITE_ID and NETLIFY_API_TOKEN in the site environment, '
        + 'or set DATABASE_URL to use Postgres instead. Redeploy afterwards.';
  }
  return out;
}

module.exports = { open, diagnose };
