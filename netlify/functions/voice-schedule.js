/* Twilio Voice webhook — lets a patient call in and book straight onto the
   Schedule calendar, no staff involved.

   Point one of your Twilio phone numbers' "A call comes in" webhook at:
     https://<your-site>/api/voice-schedule          (HTTP POST)
   For a practice with several organizations/locations, each with its own
   number, give each organization's "Main number" (Admin → Organizations →
   Appointment phone) the number you bought for it — this webhook looks up
   which organization owns the number that was dialed, so one function
   serves every location.

   The call is a short back-and-forth entirely driven by TwiML: this
   function has no memory of its own between one request and the next
   (Netlify Functions are stateless), so everything learned so far — which
   organization, which clinician, the patient's name, and so on — is carried
   forward as query-string state on each <Gather>'s action URL. Twilio
   re-posts that same query string with the caller's answer added, which is
   the only "session" this needs.

   Storage: like everything else in 'api' mode, organizations, providers,
   patients and appointments all live as JSON in the shared app_records
   table (see netlify/functions/data.js and the "generic record store"
   section of schema.sql) — never in the older per-entity tables schema.sql
   also defines. This file writes appointments the same way the Schedule
   page's own "New appointment" dialog does, so a phone-booked visit looks
   exactly like a staff-booked one everywhere it's shown. */

const crypto = require('crypto');
const L = require('./_lib');
const { columns } = require('./data');

/* ═══ small helpers ═══ */

const esc = v => String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const digitsOnly = v => String(v || '').replace(/\D/g, '');
const last10 = v => digitsOnly(v).slice(-10);

function xmlResponse(inner){
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    body: '<?xml version="1.0" encoding="UTF-8"?><Response>' + inner + '</Response>'
  };
}
function say(text){ return '<Say voice="alice" language="en-US">' + esc(text) + '</Say>'; }
function hangupWith(text){ return xmlResponse(say(text) + '<Hangup/>'); }

function siteOrigin(event){
  if(process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  try{ return new URL(event.rawUrl).origin; }catch(e){}
  const host = (event.headers || {}).host;
  return host ? 'https://' + host : '';
}
function actionUrl(event, step, state){
  const p = new URLSearchParams();
  p.set('step', step);
  Object.keys(state || {}).forEach(k => {
    if(state[k] !== undefined && state[k] !== null && state[k] !== '') p.set(k, String(state[k]));
  });
  return siteOrigin(event) + '/api/voice-schedule?' + p.toString();
}

/* ── Twilio only, verified — this endpoint creates appointments with no
   session cookie behind it, so anyone who finds the URL could otherwise
   book or spam the calendar. Twilio signs every request it sends with your
   Auth Token; a request that isn't validly signed is refused outright. ── */
function validTwilioRequest(event, params){
  const token = process.env.TWILIO_AUTH_TOKEN;
  if(!token) return false;
  const header = (event.headers || {})['x-twilio-signature'] || (event.headers || {})['X-Twilio-Signature'];
  if(!header) return false;
  const url = event.rawUrl || (siteOrigin(event) + (event.path || ''));
  let data = url;
  Object.keys(params).sort().forEach(k => { data += k + params[k]; });
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
  try{
    const a = Buffer.from(expected), b = Buffer.from(header);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }catch(e){ return false; }
}

/* "Mon–Fri, 08:00 – 17:00" is free text a person typed on the provider's
   record — there is no structured schedule to read. Read it as generously
   as possible and fall back to a sane weekday 8–5 when it doesn't parse. */
function parseAvailability(avail){
  const s = String(avail || '');
  const dayMap = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
  let days = [0,0,0,0,0,0,0];
  const dayRange = s.match(/\b([A-Za-z]{3,})\b\s*(?:[–—\-]|to)\s*\b([A-Za-z]{3,})\b/i);
  let rangeApplied = false;
  if(dayRange){
    const a = dayMap[dayRange[1].slice(0,3).toLowerCase()], b = dayMap[dayRange[2].slice(0,3).toLowerCase()];
    if(a != null && b != null){
      let i = a;
      for(let guard = 0; guard < 8; guard++){ days[i] = 1; if(i === b) break; i = (i + 1) % 7; }
      rangeApplied = true;
    }
  }
  if(!rangeApplied){
    /* not a "Mon–Fri" style range — pick up individually-named days instead,
       e.g. "Tue, Thu" or "Tuesdays and Thursdays" */
    const dayWord = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/ig;
    let m;
    while((m = dayWord.exec(s))) days[dayMap[m[1].toLowerCase()]] = 1;
  }
  if(!days.some(Boolean)) days = [0,1,1,1,1,1,0];

  const hrs = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:[–—\-]|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  function toMin(h, m, ap){
    h = +h; m = +(m || 0);
    if(ap){ ap = ap.toLowerCase(); if(ap === 'pm' && h < 12) h += 12; if(ap === 'am' && h === 12) h = 0; }
    return h * 60 + m;
  }
  let openMin = 8 * 60, closeMin = 17 * 60;
  if(hrs){
    openMin = toMin(hrs[1], hrs[2], hrs[3]);
    closeMin = toMin(hrs[4], hrs[5], hrs[6]);
    if(!hrs[3] && !hrs[6] && closeMin <= openMin) closeMin += 12 * 60; /* "8 - 5" meant 8am–5pm */
  }
  if(closeMin <= openMin){ openMin = 8 * 60; closeMin = 17 * 60; }
  return { days, openMin, closeMin };
}

/* pure calendar math — never mixes in a real time-of-day, so DST can't
   shift a date by skipping or repeating a hour */
function ymdInTZ(date, tz){
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(date);
  const g = t => (parts.find(p => p.type === t) || {}).value;
  let hh = +g('hour'); if(hh === 24) hh = 0;
  return { y:+g('year'), m:+g('month'), d:+g('day'), hh, mm:+g('minute') };
}
const pad2 = n => String(n).padStart(2, '0');
const dateStr = (y,m,d) => y + '-' + pad2(m) + '-' + pad2(d);
function stepDay(y, m, d, n){
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
}
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function spokenSlot(y, m, d, dow, startMin){
  let hh = Math.floor(startMin / 60), mm = startMin % 60;
  const ap = hh >= 12 ? 'PM' : 'AM';
  let h12 = hh % 12; if(h12 === 0) h12 = 12;
  const mmPart = mm === 0 ? '' : (' ' + pad2(mm));
  return WEEKDAYS[dow] + ', ' + MONTHS[m - 1] + ' ' + d + ' at ' + h12 + mmPart + ' ' + ap;
}

const DUR_MIN = 20;      /* matches the Schedule page's own default appointment length */
const SEARCH_DAYS = 45;  /* give up and suggest calling the office beyond this */

/* find the next open slot for this provider strictly after `cursor`,
   skipping anything that overlaps an existing appointment */
async function findNextSlot(sql, providerId, availability, tz, cursor){
  const avail = parseAvailability(availability);
  const now = ymdInTZ(new Date(), tz);
  const start = cursor || { y: now.y, m: now.m, d: now.d, start: now.hh * 60 + now.mm };
  const fromDate = dateStr(start.y, start.m, start.d);

  const rows = await sql`select data from app_records
    where kind='appt' and provider_id=${providerId} and deleted_at is null
      and on_date >= ${fromDate}`;
  const busyByDate = {};
  rows.forEach(r => {
    const a = r.data || {};
    if(!a.date) return;
    (busyByDate[a.date] = busyByDate[a.date] || []).push({
      start: Number(a.start) || 0, dur: Number(a.dur) || DUR_MIN
    });
  });

  let cur = { y: start.y, m: start.m, d: start.d, dow: new Date(Date.UTC(start.y, start.m - 1, start.d)).getUTCDay() };
  for(let day = 0; day <= SEARCH_DAYS; day++){
    if(avail.days[cur.dow]){
      const ds = dateStr(cur.y, cur.m, cur.d);
      const isStartDay = (ds === fromDate);
      const busy = busyByDate[ds] || [];
      for(let slot = avail.openMin; slot + DUR_MIN <= avail.closeMin; slot += DUR_MIN){
        if(isStartDay && slot <= start.start) continue;
        const clashes = busy.some(b => slot < (b.start + b.dur) && b.start < (slot + DUR_MIN));
        if(!clashes) return { y: cur.y, m: cur.m, d: cur.d, dow: cur.dow, date: ds, start: slot };
      }
    }
    cur = stepDay(cur.y, cur.m, cur.d, 1);
  }
  return null;
}

/* insert exactly the way data.js's action=save does, so this row is
   indistinguishable from one saved through the normal UI */
async function insertRecord(sql, kind, rec){
  const [{ id: rawId }] = await sql`select nextval('app_records_id_seq') as id`;
  const id = Number(rawId);
  rec.id = id;
  rec.created_by = rec.created_by || 'phone-ivr';
  rec.created_at = rec.created_at || new Date().toISOString();
  rec.updated_at = new Date().toISOString();
  const c = columns(kind, rec);
  await sql`insert into app_records
    (kind, id, org_id, patient_ref, provider_id, on_date, status, search, data, created_by, updated_by)
    values (${kind}, ${id}, ${c.org_id}, ${c.patient_ref}, ${c.provider_id},
            ${c.on_date}, ${c.status}, ${c.search}, ${sql.json(rec)},
            ${rec.created_by}, ${rec.created_by})
    on conflict (kind, id) do update set
      org_id=excluded.org_id, patient_ref=excluded.patient_ref,
      provider_id=excluded.provider_id, on_date=excluded.on_date,
      status=excluded.status, search=excluded.search,
      data=excluded.data, updated_by=excluded.updated_by, updated_at=now()`;
  return rec;
}

async function findOrg(sql, toNumber){
  const wanted = last10(toNumber);
  const orgs = await sql`select data from app_records where kind='org' and deleted_at is null`;
  let match = orgs.find(r => {
    const o = r.data || {};
    return [o.appt_phone, o.phone, o.billing_phone].some(p => p && last10(p) === wanted && wanted);
  });
  if(!match && orgs.length === 1) match = orgs[0];
  return match ? match.data : null;
}
async function findProviders(sql, orgId){
  const rows = await sql`select data from app_records
    where kind='provider' and org_id=${orgId} and deleted_at is null order by id`;
  return rows.map(r => r.data);
}
async function findPatientMatch(sql, orgId, lastName, dobISO, callerPhone){
  if(!lastName) return null;
  const rows = await sql`select data from app_records
    where kind='patient' and org_id=${orgId} and deleted_at is null
      and search like ${'%' + lastName.toLowerCase() + '%'}`;
  const wantPhone = last10(callerPhone);
  const hit = rows.find(r => {
    const p = r.data || {};
    if(String(p.last_name || '').toLowerCase() !== lastName.toLowerCase()) return false;
    if(dobISO && p.dob) return String(p.dob).slice(0,10) === dobISO;
    if(wantPhone && p.phone) return last10(p.phone) === wantPhone;
    return false;
  });
  return hit ? hit.data : null;
}
function splitName(spoken){
  const words = String(spoken || '').trim().split(/\s+/).filter(Boolean);
  if(!words.length) return { first:'', last:'' };
  if(words.length === 1) return { first:'', last: words[0] };
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1] };
}
function dobFromDigits(d){
  d = digitsOnly(d);
  if(d.length !== 8) return null;
  const mm = +d.slice(0,2), dd = +d.slice(2,4), yyyy = +d.slice(4,8);
  if(mm < 1 || mm > 12 || dd < 1 || dd > 31 || yyyy < 1900 || yyyy > new Date().getFullYear()) return null;
  return dateStr(yyyy, mm, dd);
}

async function sendConfirmationSms(toPhone, text){
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if(!sid || !token || !from) return;
  try{
    const digits = digitsOnly(toPhone);
    const to = digits.length === 10 ? '+1' + digits : (String(toPhone).startsWith('+') ? toPhone : '+' + digits);
    const params = new URLSearchParams({ To: to, From: from, Body: text });
    await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
  }catch(e){ console.error('voice-schedule: confirmation text failed', e.message); }
}

/* ═══ the call flow itself ═══ */

exports.handler = async (event) => {
  if(event.httpMethod === 'GET' && !(event.queryStringParameters || {}).CallSid &&
     !(event.queryStringParameters || {}).step){
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' },
      body: 'This endpoint expects a Twilio Voice webhook (POST), not a browser visit.' };
  }

  let bodyStr = event.body || '';
  if(event.isBase64Encoded) bodyStr = Buffer.from(bodyStr, 'base64').toString('utf-8');
  const posted = {};
  new URLSearchParams(bodyStr).forEach((v, k) => { posted[k] = v; });

  if(!validTwilioRequest(event, posted)){
    console.error('voice-schedule: rejected — missing or invalid Twilio signature');
    return hangupWith('Sorry, this line could not be verified. Goodbye.');
  }

  const qs = event.queryStringParameters || {};
  const step = qs.step || 'start';
  const from = posted.From || qs.From || '';
  const to = posted.To || qs.To || '';
  const digits = posted.Digits || '';
  const speech = posted.SpeechResult || '';

  let sql;
  try{ sql = L.db(); }
  catch(e){ return hangupWith('Sorry, our scheduling system is unavailable right now. Please call back later.'); }

  const TZ = process.env.SCHEDULING_TZ || process.env.CLAIMS_TZ || 'America/Chicago';

  try{

    /* ── call just came in ── */
    if(step === 'start'){
      const org = await findOrg(sql, to);
      if(!org) return hangupWith('Sorry, this number is not set up for scheduling yet. Please call the office directly.');
      const providers = (await findProviders(sql, org.id)).slice(0, 9);
      if(!providers.length) return hangupWith('Sorry, there are no clinicians set up for scheduling yet. Please call the office directly.');

      if(providers.length === 1){
        return xmlResponse(
          '<Gather input="speech" language="en-US" speechTimeout="auto" ' +
            'action="' + esc(actionUrl(event, 'dob', { org: org.id, prov: providers[0].id })) + '">' +
            say('Thanks for calling ' + (org.name || 'our office') + '. ' +
                'Can I get the first and last name of the patient?') +
          '</Gather>' + say("Sorry, I didn't catch that.") + '<Redirect method="POST">' +
            esc(actionUrl(event, 'start', {})) + '</Redirect>'
        );
      }
      const provlist = providers.map(p => p.id).join(',');
      const menu = providers.map((p,i) => (i+1) + ' for ' + (p.full_name || 'clinician ' + (i+1))).join(', ');
      return xmlResponse(
        '<Gather input="dtmf" numDigits="1" timeout="8" ' +
          'action="' + esc(actionUrl(event, 'provider', { org: org.id, provlist })) + '">' +
          say('Thanks for calling ' + (org.name || 'our office') + '. To schedule, press ' + menu + '.') +
        '</Gather>' + say("Sorry, I didn't get that.") + '<Redirect method="POST">' +
          esc(actionUrl(event, 'start', {})) + '</Redirect>'
      );
    }

    /* ── clinician chosen by keypress ── */
    if(step === 'provider'){
      const list = (qs.provlist || '').split(',').filter(Boolean);
      const idx = parseInt(digits, 10) - 1;
      const provId = list[idx] || list[0];
      if(!provId) return hangupWith('Sorry, I could not set up scheduling for this call. Please call the office directly.');
      return xmlResponse(
        '<Gather input="speech" language="en-US" speechTimeout="auto" ' +
          'action="' + esc(actionUrl(event, 'dob', { org: qs.org, prov: provId })) + '">' +
          say('Can I get the first and last name of the patient?') +
        '</Gather>' + say("Sorry, I didn't catch that.") + '<Hangup/>'
      );
    }

    /* ── name captured (speech), now ask date of birth ── */
    if(step === 'dob'){
      const name = speech || '';
      if(!name){
        if(qs.tries === '1') return hangupWith('No problem — please call the office directly to schedule. Goodbye.');
        return xmlResponse(
          '<Gather input="speech" language="en-US" speechTimeout="auto" ' +
            'action="' + esc(actionUrl(event, 'dob', { org: qs.org, prov: qs.prov, tries: '1' })) + '">' +
            say("I didn't catch a name. Could you say the patient's first and last name again?") +
          '</Gather>' + say('No problem — please call the office directly to schedule. Goodbye.') + '<Hangup/>'
        );
      }
      return xmlResponse(
        '<Gather input="dtmf" numDigits="8" timeout="12" ' +
          'action="' + esc(actionUrl(event, 'reason', { org: qs.org, prov: qs.prov, name })) + '">' +
          say('Using your telephone keypad, please enter the patient’s date of birth as ' +
              'two digit month, two digit day, and four digit year.') +
        '</Gather>' +
        say("I didn't get that — we'll finish the date of birth with our office later.") +
        '<Redirect method="POST">' +
          esc(actionUrl(event, 'reason', { org: qs.org, prov: qs.prov, name })) + '</Redirect>'
      );
    }

    /* ── DOB captured (or skipped), now ask the reason for the visit ── */
    if(step === 'reason'){
      const dobISO = dobFromDigits(digits) || '';
      return xmlResponse(
        '<Gather input="speech" language="en-US" speechTimeout="auto" ' +
          'action="' + esc(actionUrl(event, 'offer', { org: qs.org, prov: qs.prov, name: qs.name, dob: dobISO })) + '">' +
          say('In a few words, what is this appointment for?') +
        '</Gather>' + '<Redirect method="POST">' +
          esc(actionUrl(event, 'offer', { org: qs.org, prov: qs.prov, name: qs.name, dob: dobISO, reason: '' })) +
        '</Redirect>'
      );
    }

    /* ── we now know enough: find a slot and offer it, or act on 1/2/9 ── */
    if(step === 'offer'){
      const orgId = Number(qs.org), provId = Number(qs.prov);
      const providers = await findProviders(sql, orgId);
      const provider = providers.find(p => String(p.id) === String(provId)) || {};
      const reason = qs.reason !== undefined ? qs.reason : speech;
      const { first, last } = splitName(qs.name || '');
      const dobISO = qs.dob || '';

      /* first time through: no digits yet, nothing offered yet — go find one */
      if(!digits && !qs.offDate){
        const slot = await findNextSlot(sql, provId, provider.availability, TZ, null);
        if(!slot) return hangupWith('I could not find an opening in the next few weeks with ' +
          (provider.full_name || 'this clinician') + '. Please call the office directly. Goodbye.');
        return offerSlot(event, { org: orgId, prov: provId, name: qs.name, dob: dobISO, reason }, slot, provider);
      }

      const offered = { y:+qs.offY, m:+qs.offM, d:+qs.offD, dow:+qs.offDow, date:qs.offDate, start:+qs.offStart };

      if(digits === '1'){
        /* re-check right before writing — another caller may have booked this
           slot in the meantime. start/dur live inside the JSON data, not as
           real columns, so the overlap check happens in JS after the fetch. */
        const rows = await sql`select data from app_records
          where kind='appt' and provider_id=${provId} and deleted_at is null and on_date=${offered.date}`;
        const clash = rows.some(r => {
          const a = r.data || {};
          const s = Number(a.start) || 0, d = Number(a.dur) || DUR_MIN;
          return offered.start < (s + d) && s < (offered.start + DUR_MIN);
        });
        if(clash){
          const next = await findNextSlot(sql, provId, provider.availability, TZ, offered);
          if(!next) return hangupWith('That time was just taken and I could not find another opening soon. ' +
            'Please call the office directly. Goodbye.');
          return offerSlot(event, { org: orgId, prov: provId, name: qs.name, dob: dobISO, reason },
            next, provider, "Sorry, that time was just taken. ");
        }

        const patient = await findPatientMatch(sql, orgId, last, dobISO, from);
        const rec = {
          org_id: orgId, provider_id: provId,
          patient_ref: patient ? patient.id : null,
          date: offered.date, start: offered.start, dur: DUR_MIN,
          block_type: 'patient',
          patient_first: patient ? (patient.first_name || first) : first,
          patient_last: patient ? (patient.last_name || last) : last,
          dob: dobISO || (patient && patient.dob) || undefined,
          member_id: (patient && patient.member_id) || '',
          kind: 'office', is_new: !patient,
          copay: 0, collected: false, payer: (patient && patient.payer) || '',
          reason: reason || '', status: 'Scheduled',
          booked_mode: 'A', booked_by: 'Phone (automated)', booked_at: new Date().toISOString(),
          phone: from
        };
        await insertRecord(sql, 'appt', rec);

        const spoken = spokenSlot(offered.y, offered.m, offered.d, offered.dow, offered.start);
        if(from){
          sendConfirmationSms(from,
            'You’re confirmed with ' + (provider.full_name || 'your clinician') + ' on ' + spoken + '.' +
            (rec.patient_last ? ' Patient: ' + (rec.patient_first ? rec.patient_first + ' ' : '') + rec.patient_last + '.' : '') +
            ' Reply or call the office if you need to reschedule.');
        }
        return hangupWith('You’re all set. ' + (provider.full_name || 'Your clinician') + ' will see ' +
          (rec.patient_first || rec.patient_last ? (rec.patient_first + ' ' + rec.patient_last).trim() : 'the patient') +
          ' on ' + spoken + '. ' + (from ? 'We’ve texted a confirmation to this number. ' : '') +
          'Thank you, goodbye.');
      }

      if(digits === '2'){
        const next = await findNextSlot(sql, provId, provider.availability, TZ, offered);
        if(!next) return hangupWith('That was the last opening I have in the next few weeks. ' +
          'Please call the office directly. Goodbye.');
        return offerSlot(event, { org: orgId, prov: provId, name: qs.name, dob: dobISO, reason }, next, provider);
      }

      if(digits === '9' || qs.tries === '1'){
        return hangupWith('No problem — please call the office directly to schedule. Goodbye.');
      }

      /* anything else (bad key, or a timeout with no input) — repeat once */
      return offerSlot(event, { org: orgId, prov: provId, name: qs.name, dob: dobISO, reason, tries: '1' },
        offered, provider, "Sorry, I didn't get that. ");
    }

    return hangupWith('Sorry, something went wrong with this call. Please call the office directly.');

  }catch(err){
    console.error('voice-schedule: unhandled error', err);
    return hangupWith('Sorry, something went wrong. Please call the office directly to schedule.');
  }
};

/* exported for unit testing only — the handler above is the real entry point */
module.exports.parseAvailability = parseAvailability;
module.exports.findNextSlot = findNextSlot;
module.exports.dobFromDigits = dobFromDigits;
module.exports.splitName = splitName;
module.exports.validTwilioRequest = validTwilioRequest;
module.exports.spokenSlot = spokenSlot;

function offerSlot(event, state, slot, provider, prefix){
  const spoken = spokenSlot(slot.y, slot.m, slot.d, slot.dow, slot.start);
  const nextState = Object.assign({}, state, {
    offY: slot.y, offM: slot.m, offD: slot.d, offDow: slot.dow, offDate: slot.date, offStart: slot.start,
    tries: undefined
  });
  return xmlResponse(
    '<Gather input="dtmf" numDigits="1" timeout="8" ' +
      'action="' + esc(actionUrl(event, 'offer', nextState)) + '">' +
      say((prefix || '') + 'The next opening with ' + (provider.full_name || 'this clinician') + ' is ' +
          spoken + '. Press 1 to book it. Press 2 to hear another time. Press 9 to have our office call you instead.') +
    '</Gather>' + '<Redirect method="POST">' + esc(actionUrl(event, 'offer', nextState)) + '</Redirect>'
  );
}
