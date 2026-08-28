/* Sends a patient's sign-in code by text.

   Answers honestly when no messaging service is configured, so the portal can
   say so plainly instead of claiming a message went out that never did. */

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': process.env.SITE_URL || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode:204, headers:CORS, body:'' };
  if(event.httpMethod !== 'POST')
    return { statusCode:405, headers:CORS, body: JSON.stringify({ error:'method' }) };

  let body = {};
  try{ body = JSON.parse(event.body || '{}'); }catch{}
  const phone = String(body.phone||'').replace(/\D/g,'');
  const code  = String(body.code||'');
  if(!phone || !code)
    return { statusCode:400, headers:CORS, body: JSON.stringify({ error:'missing' }) };

  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM;

  if(!sid || !token || !from){
    return { statusCode:200, headers:CORS, body: JSON.stringify({
      delivered:false,
      note:'No messaging service is connected. Set TWILIO_ACCOUNT_SID, '+
           'TWILIO_AUTH_TOKEN and TWILIO_FROM to send codes by text.'
    }) };
  }

  const practice = process.env.PRACTICE_NAME || 'your practice';
  const text = code + ' is your code for ' + practice +
    '. It expires in 10 minutes. We will never ask you for it.';

  try{
    const params = new URLSearchParams({
      To: phone.length === 10 ? '+1'+phone : (phone.startsWith('+') ? phone : '+'+phone),
      From: from, Body: text
    });
    const r = await fetch(
      'https://api.twilio.com/2010-04-01/Accounts/'+encodeURIComponent(sid)+'/Messages.json',
      { method:'POST',
        headers:{ 'Authorization':'Basic '+Buffer.from(sid+':'+token).toString('base64'),
                  'Content-Type':'application/x-www-form-urlencoded' },
        body: params.toString() });

    const data = await r.json().catch(()=>({}));
    if(!r.ok){
      console.error('portal-sms: send failed', r.status, data && data.message);
      return { statusCode:200, headers:CORS, body: JSON.stringify({
        delivered:false, note:'The message could not be sent. Please call the practice.' }) };
    }
    /* the code is never logged */
    console.log('portal-sms: sent to ••••'+phone.slice(-4));
    return { statusCode:200, headers:CORS, body: JSON.stringify({ delivered:true }) };
  }catch(err){
    console.error('portal-sms: error', err.message);
    return { statusCode:200, headers:CORS, body: JSON.stringify({
      delivered:false, note:'The messaging service could not be reached.' }) };
  }
};
