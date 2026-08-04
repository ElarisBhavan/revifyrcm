/* Authentication — login, MFA, session, logout, forgot/reset password */
const crypto = require('crypto');
const L = require('./_lib');

const MAX_FAILS = 5, LOCK_MINUTES = 15;

async function sendResetEmail(to, link, name){
  const key = process.env.RESEND_API_KEY;
  if(!key) return { sent:false, reason:'RESEND_API_KEY not set' };
  try{
    const r = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${key}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'ReviFlow <onboarding@resend.dev>',
        to: [to],
        subject: 'Reset your ReviFlow password',
        html: `<p>Hello ${name||''},</p>
               <p>A password reset was requested for your ReviFlow account.
               This link is valid for 30 minutes and can be used once.</p>
               <p><a href="${link}">Reset your password</a></p>
               <p>If you did not request this, you can ignore this email.</p>`
      })
    });
    return { sent: r.ok };
  }catch(e){ return { sent:false, reason:String(e.message||e) }; }
}

exports.handler = async (event) => {
  if(event.httpMethod !== 'POST' && event.httpMethod !== 'GET')
    return L.J(405, { error:'Method not allowed' });

  const sql = L.db();
  const url = new URL(event.rawUrl || `https://x${event.path}`);
  const action = (url.searchParams.get('action') || '').toLowerCase();
  let body = {};
  if(event.body){ try{ body = JSON.parse(event.body); }catch{} }

  try{
    /* ── current session ── */
    if(action === 'me'){
      const s = L.session(event);
      if(!s) return L.J(401, { error:'Not signed in' });
      return L.J(200, { account: s });
    }

    /* ── sign out ── */
    if(action === 'logout'){
      const s = L.session(event);
      if(s) await L.logEvent(s.id, s.username, 'logout', event);
      return L.J(200, { ok:true }, { 'Set-Cookie': L.clearCookie() });
    }

    /* ── step 1: username + password ── */
    if(action === 'login'){
      const { username, password } = body;
      if(!username || !password) return L.J(400, { error:'Username and password are required' });

      const [acct] = await sql`SELECT * FROM accounts WHERE LOWER(username)=LOWER(${username}) LIMIT 1`;
      if(!acct){
        await L.logEvent(null, username, 'failed', event);
        return L.J(401, { error:'unknown', message:'No account found for that username.' });
      }
      if(acct.status !== 'active')
        return L.J(403, { error:'disabled', message:'This account has been disabled. Contact your administrator.' });
      if(acct.locked_until && new Date(acct.locked_until) > new Date())
        return L.J(423, { error:'locked', message:`Too many attempts. Try again after ${new Date(acct.locked_until).toLocaleTimeString()}.` });

      if(!L.verifyPassword(password, acct.password_hash)){
        const fails = (acct.failed_attempts||0) + 1;
        const lock = fails >= MAX_FAILS ? new Date(Date.now()+LOCK_MINUTES*60000) : null;
        await sql`UPDATE accounts SET failed_attempts=${fails}, locked_until=${lock} WHERE id=${acct.id}`;
        await L.logEvent(acct.id, acct.username, 'failed', event);
        return L.J(401, { error:'password',
          message: lock ? `Too many attempts. Locked for ${LOCK_MINUTES} minutes.` : 'That password is not correct.',
          remaining: Math.max(0, MAX_FAILS - fails) });
      }

      await sql`UPDATE accounts SET failed_attempts=0, locked_until=NULL WHERE id=${acct.id}`;

      /* MFA enrolled -> hand back a short-lived challenge, not a session */
      if(acct.mfa_enabled && acct.mfa_secret){
        const challenge = L.sign({ mfa:true, id:acct.id, username:acct.username }, 0.08); // ~5 min
        return L.J(200, { mfaRequired:true, challenge, name:acct.full_name });
      }

      /* MFA not set up yet but required for the role -> enrol now */
      if(!acct.mfa_enabled && acct.role === 'admin' && process.env.REQUIRE_ADMIN_MFA === 'true'){
        const secret = L.randomSecret();
        await sql`UPDATE accounts SET mfa_secret=${secret} WHERE id=${acct.id}`;
        const challenge = L.sign({ enrol:true, id:acct.id, username:acct.username }, 0.16);
        return L.J(200, { mfaEnrol:true, challenge, secret,
                          otpauth: L.otpauth(acct.username, secret), name:acct.full_name });
      }

      return finish(acct, sql, event);
    }

    /* ── step 2: verify the 6-digit code ── */
    if(action === 'mfa'){
      const { challenge, code } = body;
      const c = L.verify(challenge);
      if(!c || !(c.mfa || c.enrol)) return L.J(401, { error:'expired', message:'That sign-in attempt expired. Start again.' });

      const [acct] = await sql`SELECT * FROM accounts WHERE id=${c.id} LIMIT 1`;
      if(!acct) return L.J(401, { error:'unknown' });

      if(!L.verifyTotp(acct.mfa_secret, code)){
        await L.logEvent(acct.id, acct.username, 'mfa_failed', event);
        return L.J(401, { error:'code', message:'That code is not valid. Codes refresh every 30 seconds.' });
      }
      if(c.enrol) await sql`UPDATE accounts SET mfa_enabled=TRUE WHERE id=${acct.id}`;
      return finish(acct, sql, event);
    }

    /* ── forgot password ── */
    if(action === 'forgot'){
      const { username } = body;
      const [acct] = await sql`SELECT * FROM accounts
                               WHERE LOWER(username)=LOWER(${username}) OR LOWER(email)=LOWER(${username})
                               LIMIT 1`;
      /* Always answer the same way so the form cannot be used to discover accounts */
      const generic = { ok:true, message:'If that account exists, a reset link has been sent to the email on file.' };
      if(!acct || !acct.email) return L.J(200, generic);

      const token = crypto.randomBytes(32).toString('base64url');
      await sql`INSERT INTO reset_tokens (token,account_id,expires_at)
                VALUES (${token},${acct.id},${new Date(Date.now()+30*60000)})`;

      const origin = process.env.SITE_URL || url.origin;
      const link = `${origin}/Admin/reset-password.html?token=${token}`;
      const mail = await sendResetEmail(acct.email, link, acct.full_name);
      await L.logEvent(acct.id, acct.username, 'reset', event);

      /* Dev escape hatch — never enable in production */
      if(!mail.sent && process.env.DEV_SHOW_RESET_LINK === 'true')
        return L.J(200, { ...generic, devLink: link, mailError: mail.reason });

      return L.J(200, generic);
    }

    /* ── complete the reset ── */
    if(action === 'reset'){
      const { token, password } = body;
      if(!token || !password) return L.J(400, { error:'Token and new password are required' });
      if(String(password).length < 10)
        return L.J(400, { error:'weak', message:'Use at least 10 characters.' });

      const [row] = await sql`SELECT * FROM reset_tokens WHERE token=${token} LIMIT 1`;
      if(!row || row.used_at || new Date(row.expires_at) < new Date())
        return L.J(400, { error:'invalid', message:'That reset link has expired or has already been used.' });

      await sql`UPDATE accounts SET password_hash=${L.hashPassword(password)},
                must_change=FALSE, failed_attempts=0, locked_until=NULL, updated_at=NOW()
                WHERE id=${row.account_id}`;
      await sql`UPDATE reset_tokens SET used_at=NOW() WHERE token=${token}`;
      return L.J(200, { ok:true, message:'Password updated. You can sign in now.' });
    }

    return L.J(400, { error:'Unknown action' });

  }catch(err){
    return L.J(500, { error:'server', message:String(err.message||err) });
  }
};

async function finish(acct, sql, event){
  await sql`UPDATE accounts SET last_login=NOW() WHERE id=${acct.id}`;
  await L.logEvent(acct.id, acct.username, 'login', event);
  const payload = {
    id: acct.id, username: acct.username, role: acct.role, name: acct.full_name,
    title: acct.title, initials: acct.initials, pid: acct.provider_id,
    scope: acct.scope, mustChange: acct.must_change
  };
  return L.J(200, { ok:true, account: payload }, { 'Set-Cookie': L.cookie(L.sign(payload)) });
}
