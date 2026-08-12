/* Shared helpers — zero external crypto deps, all from node:crypto */
const crypto = require('crypto');
const postgres = require('postgres');

let _sql;
function db(){
  if(!_sql){
    const url = process.env.DATABASE_URL;
    if(!url) throw new Error('DATABASE_URL is not set');
    _sql = postgres(url, { ssl:'require', max:1, idle_timeout:20, connect_timeout:10 });
  }
  return _sql;
}

/* ── passwords: scrypt, salted, constant-time compare ── */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function hashPassword(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${salt}$${hash}`;
}
function verifyPassword(pw, stored){
  try{
    const s = String(stored);
    if(s.startsWith('scrypt$')){
      const [, N, salt, hash] = s.split('$');
      const test = crypto.scryptSync(String(pw), salt, SCRYPT.keylen,
        { ...SCRYPT, N: parseInt(N, 10) });
      const known = Buffer.from(hash, 'hex');
      return test.length === known.length && crypto.timingSafeEqual(test, known);
    }
    /* legacy salt:hash at the default cost */
    const [salt, hash] = s.split(':');
    if(!salt || !hash) return false;
    const test = crypto.scryptSync(String(pw), salt, 64);
    const known = Buffer.from(hash, 'hex');
    return test.length === known.length && crypto.timingSafeEqual(test, known);
  }catch{ return false; }
}

/* ── sessions: signed JWT (HS256) in an httpOnly cookie ── */
const b64u = b => Buffer.from(b).toString('base64url');
function sign(payload, hours=8){
  const secret = process.env.JWT_SECRET;
  if(!secret) throw new Error('JWT_SECRET is not set');
  const head = b64u(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const body = b64u(JSON.stringify({...payload, exp: Math.floor(Date.now()/1000)+hours*3600}));
  const sig  = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verify(token){
  try{
    const secret = process.env.JWT_SECRET;
    const [h,b,s] = String(token).split('.');
    if(!h||!b||!s) return null;
    const expect = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
    if(!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) return null;
    const payload = JSON.parse(Buffer.from(b,'base64url').toString());
    if(payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  }catch{ return null; }
}
function cookie(token, hours=8){
  const attrs = ['Path=/','HttpOnly','SameSite=Lax','Secure',`Max-Age=${hours*3600}`];
  return `rf_token=${token}; ${attrs.join('; ')}`;
}
const clearCookie = () => 'rf_token=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0';
function readCookie(event, name='rf_token'){
  const raw = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)'+name+'=([^;]+)'));
  return m ? m[1] : null;
}
function session(event){ return verify(readCookie(event)); }

/* ── TOTP (RFC 6238) — Google Authenticator compatible ── */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function randomSecret(len=20){
  const buf = crypto.randomBytes(len);
  let out = '';
  for(const byte of buf) out += B32[byte % 32];
  return out;
}
function b32decode(s){
  let bits = '', out = [];
  for(const c of String(s).toUpperCase().replace(/=+$/,'')){
    const i = B32.indexOf(c);
    if(i < 0) continue;
    bits += i.toString(2).padStart(5,'0');
  }
  for(let i=0; i+8<=bits.length; i+=8) out.push(parseInt(bits.slice(i,i+8),2));
  return Buffer.from(out);
}
function totp(secret, step){
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step/0x100000000), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const hmac = crypto.createHmac('sha1', b32decode(secret)).update(counter).digest();
  const off  = hmac[hmac.length-1] & 0x0f;
  const code = ((hmac[off]&0x7f)<<24 | hmac[off+1]<<16 | hmac[off+2]<<8 | hmac[off+3]) % 1000000;
  return String(code).padStart(6,'0');
}
/* accept the previous and next window to tolerate clock drift */
function verifyTotp(secret, code){
  if(!secret || !code) return false;
  const clean = String(code).replace(/\D/g,'');
  if(clean.length !== 6) return false;
  const now = Math.floor(Date.now()/1000/30);
  for(let w=-1; w<=1; w++) if(totp(secret, now+w) === clean) return true;
  return false;
}
function otpauth(user, secret, issuer='ReviFlow RCM'){
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}`
       + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ── responses ── */
const J = (code, body, extra={}) => ({
  statusCode: code,
  headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store', ...extra },
  body: JSON.stringify(body)
});

async function audit(actor, action, target, detail){
  try{ await db()`INSERT INTO account_audit (actor,action,target,detail)
                  VALUES (${actor},${action},${target},${db().json(detail||{})})`; }catch{}
}
async function logEvent(accountId, username, event, ev){
  try{
    const h = ev.headers||{};
    await db()`INSERT INTO login_events (account_id,username,event,ip,user_agent)
               VALUES (${accountId},${username},${event},
                       ${h['x-nf-client-connection-ip']||h['client-ip']||null},
                       ${h['user-agent']||null})`;
  }catch{}
}

module.exports = { db, hashPassword, verifyPassword, sign, verify, cookie, clearCookie,
                   session, randomSecret, totp, verifyTotp, otpauth, J, audit, logEvent };
