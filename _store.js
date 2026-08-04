/* ═══════════════════════════════════════════════════════════════
   ReviFlow — account store
   ONE interface, TWO drivers:
     'local' — IndexedDB in the browser. Works with no server.
     'api'   — the Netlify Functions + Postgres backend.
   Flip DRIVER to 'api' after deploying. No other file changes.
   Passwords are PBKDF2-hashed in both drivers — never stored readable.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  const DRIVER = 'local';           // ← change to 'api' once deployed
  const DB = 'reviflow', STORE = 'accounts', META = 'meta', VER = 1;

  /* ── IndexedDB plumbing ── */
  function idb(){
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if(!d.objectStoreNames.contains(STORE)){
          const s = d.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
          s.createIndex('username','username',{ unique:true });
        }
        if(!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath:'k' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function tx(store, mode, fn){
    const d = await idb();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out;
      try{ out = fn(s); }catch(e){ rej(e); return; }
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  }
  const all   = () => tx(STORE,'readonly',  s => s.getAll());
  const put   = v  => tx(STORE,'readwrite', s => s.put(v));
  const del   = id => tx(STORE,'readwrite', s => s.delete(id));
  const meta  = async k => (await tx(META,'readonly', s => s.get(k)) || {}).v;
  const setMeta = (k,v) => tx(META,'readwrite', s => s.put({k, v}));

  /* ── password hashing: PBKDF2-SHA256, 150k rounds ── */
  const enc = new TextEncoder();
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('');
  async function hashPassword(pw, saltHex){
    const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map(h=>parseInt(h,16)))
                         : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name:'PBKDF2', salt, iterations:150000, hash:'SHA-256' }, key, 256);
    return `${hex(salt)}:${hex(bits)}`;
  }
  async function checkPassword(pw, stored){
    if(!stored || !stored.includes(':')) return false;
    const [salt] = stored.split(':');
    const test = await hashPassword(pw, salt);
    // constant-ish time compare
    if(test.length !== stored.length) return false;
    let diff = 0;
    for(let i=0;i<test.length;i++) diff |= test.charCodeAt(i) ^ stored.charCodeAt(i);
    return diff === 0;
  }

  /* ── TOTP, Google Authenticator compatible ── */
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function randomSecret(len=20){
    const b = crypto.getRandomValues(new Uint8Array(len));
    return [...b].map(x => B32[x % 32]).join('');
  }
  function b32decode(s){
    let bits = '';
    for(const c of String(s).toUpperCase().replace(/=+$/,'')){
      const i = B32.indexOf(c);
      if(i >= 0) bits += i.toString(2).padStart(5,'0');
    }
    const out = [];
    for(let i=0; i+8<=bits.length; i+=8) out.push(parseInt(bits.slice(i,i+8),2));
    return new Uint8Array(out);
  }
  async function totp(secret, step){
    const key = await crypto.subtle.importKey('raw', b32decode(secret),
      { name:'HMAC', hash:'SHA-1' }, false, ['sign']);
    const ctr = new ArrayBuffer(8), dv = new DataView(ctr);
    dv.setUint32(0, Math.floor(step / 0x100000000));
    dv.setUint32(4, step >>> 0);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, ctr));
    const off = sig[sig.length-1] & 0x0f;
    const code = ((sig[off]&0x7f)<<24 | sig[off+1]<<16 | sig[off+2]<<8 | sig[off+3]) % 1000000;
    return String(code).padStart(6,'0');
  }
  async function verifyTotp(secret, code){
    const clean = String(code||'').replace(/\D/g,'');
    if(!secret || clean.length !== 6) return false;
    const now = Math.floor(Date.now()/1000/30);
    for(let w=-1; w<=1; w++) if(await totp(secret, now+w) === clean) return true;
    return false;
  }
  const otpauth = (user, secret, issuer='ReviFlow RCM') =>
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}`
    + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

  /* ── seed: one temporary administrator, forced to change on first use ── */
  const TEMP_ADMIN = { username:'admin', password:'ReviFlow-Temp-2026' };
  async function seed(){
    if(await meta('seeded')) return;
    await put({
      username: TEMP_ADMIN.username,
      password_hash: await hashPassword(TEMP_ADMIN.password),
      role:'admin', full_name:'System Administrator',
      first_name:'System', last_name:'Administrator', title:'Platform Admin',
      initials:'SA', scope:'all', status:'active',
      must_change:true, mfa_enabled:false, mfa_secret:null,
      email:null, phone:null, provider_id:null,
      failed_attempts:0, locked_until:null, last_login:null,
      created_by:'seed', created_at:new Date().toISOString()
    });
    await setMeta('seeded', true);
    await setMeta('events', []);
    await setMeta('audit', []);
  }

  async function logEvent(username, event){
    const list = (await meta('events')) || [];
    list.unshift({ username, event, at:new Date().toISOString() });
    await setMeta('events', list.slice(0,500));
  }
  async function audit(actor, action, target, detail){
    const list = (await meta('audit')) || [];
    list.unshift({ actor, action, target, detail:detail||{}, at:new Date().toISOString() });
    await setMeta('audit', list.slice(0,300));
  }

  /* ── generated temporary password ── */
  function tempPassword(){
    const A='ABCDEFGHJKMNPQRSTUVWXYZ', a='abcdefghijkmnpqrstuvwxyz', n='23456789', s='!#$%&*+?';
    const r = k => k[crypto.getRandomValues(new Uint32Array(1))[0] % k.length];
    const out = [r(A),r(A),r(a),r(a),r(a),r(n),r(n),r(n),r(s),r(s)];
    for(let i=out.length-1;i>0;i--){
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i+1);
      [out[i],out[j]] = [out[j],out[i]];
    }
    return out.join('');
  }
  const initialsOf = n => String(n||'').replace(/^Dr\.?\s+/i,'')
    .split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();

  /* "Dr. Bhavan Kalyan" -> {prefix:'Dr.', first:'Bhavan', last:'Kalyan'}
     Everything between the first and last word is treated as a middle name,
     and a trailing credential such as ", NP" is kept out of the surname. */
  function splitName(full){
    let raw = String(full||'').trim().replace(/\s+/g,' ');
    let suffix = '';
    const comma = raw.indexOf(',');
    if(comma > -1){ suffix = raw.slice(comma+1).trim(); raw = raw.slice(0,comma).trim(); }
    let prefix = '';
    const m = raw.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?)\s+/i);
    if(m){ prefix = m[1]; raw = raw.slice(m[0].length); }
    const parts = raw.split(' ').filter(Boolean);
    return {
      prefix, suffix,
      first: parts[0] || '',
      middle: parts.length > 2 ? parts.slice(1,-1).join(' ') : '',
      last: parts.length > 1 ? parts[parts.length-1] : ''
    };
  }

  /* "Dr. Bhavan Kalyan, MD" -> {prefix:'Dr.', first:'Bhavan', last:'Kalyan', suffix:'MD'} */
  function splitName(full){
    let raw = String(full||'').trim();
    let prefix='', suffix='';
    const pm = raw.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?)\s+/i);
    if(pm){ prefix = pm[1]; raw = raw.slice(pm[0].length).trim(); }
    const sm = raw.match(/,\s*(.+)$/);
    if(sm){ suffix = sm[1].trim(); raw = raw.slice(0, sm.index).trim(); }
    const parts = raw.split(/\s+/).filter(Boolean);
    return {
      prefix,
      first: parts[0] || '',
      last:  parts.length > 1 ? parts.slice(1).join(' ') : '',
      suffix
    };
  }

  /* ── session (sessionStorage; cleared when the tab closes) ── */
  const SKEY = 'rf_session';
  const setSession = a => {
    const n = splitName(a.full_name);
    sessionStorage.setItem(SKEY, JSON.stringify({
      id:a.id, username:a.username, role:a.role, name:a.full_name,
      first: a.first_name || n.first, last: a.last_name || n.last,
      title:a.title, initials:a.initials, pid:a.provider_id, scope:a.scope, at:Date.now()
    }));
  };
  const getSession = () => { try{ return JSON.parse(sessionStorage.getItem(SKEY)||'null'); }catch{ return null; } };
  const clearSession = () => sessionStorage.removeItem(SKEY);

  /* ── remote driver ── */
  async function apiCall(path, action, payload, method){
    const r = await fetch(`${path}?action=${action}`, {
      method: method||'POST', credentials:'same-origin',
      headers:{ 'Content-Type':'application/json' },
      body: payload ? JSON.stringify(payload) : undefined
    });
    let j = {}; try{ j = await r.json(); }catch{}
    return { ok:r.ok, status:r.status, body:j };
  }

  /* ═══ public API ═══ */
  window.RFStore = {
    driver: DRIVER,
    tempAdmin: TEMP_ADMIN,
    randomSecret, otpauth, verifyTotp, tempPassword, initialsOf, splitName,
    getSession, clearSession,

    async ready(){ if(DRIVER==='local') await seed(); },

    async list(){
      if(DRIVER==='api'){
        const r = await fetch('/api/admin/users?action=list',{credentials:'same-origin'});
        return (await r.json()).accounts || [];
      }
      const rows = await all();
      return rows.map(({password_hash, mfa_secret, ...rest}) => {
        if(!rest.first_name || !rest.last_name){
          const n = splitName(rest.full_name);
          rest.first_name = rest.first_name || n.first;
          rest.last_name  = rest.last_name  || n.last;
        }
        return rest;
      });
    },

    async find(username){
      const u = String(username||'').trim().toLowerCase();
      return (await all()).find(a => a.username.toLowerCase() === u) || null;
    },

    /* step 1 of sign-in */
    async login(username, password){
      if(DRIVER==='api') return (await apiCall('/api/auth','login',{username,password})).body;
      await seed();
      const a = await this.find(username);
      if(!a){ await logEvent(username,'failed'); return { error:'unknown', message:'No account found for that username.' }; }
      if(a.status !== 'active') return { error:'disabled', message:'This account has been disabled. Contact your administrator.' };
      if(a.locked_until && new Date(a.locked_until) > new Date())
        return { error:'locked', message:'Too many attempts. Try again in a few minutes.' };

      if(!await checkPassword(password, a.password_hash)){
        a.failed_attempts = (a.failed_attempts||0) + 1;
        if(a.failed_attempts >= 5) a.locked_until = new Date(Date.now()+15*60000).toISOString();
        await put(a); await logEvent(a.username,'failed');
        return { error:'password', message: a.locked_until ? 'Too many attempts. Locked for 15 minutes.' : 'That password is not correct.' };
      }
      a.failed_attempts = 0; a.locked_until = null; await put(a);

      if(a.must_change) return { mustChange:true, id:a.id, name:a.full_name, username:a.username };
      if(a.mfa_enabled && a.mfa_secret) return { mfaRequired:true, id:a.id, name:a.full_name };
      return this._finish(a);
    },

    /* forced password change, then MFA enrolment */
    async changePassword(id, newPassword){
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'unknown' };
      if(String(newPassword).length < 10) return { error:'weak', message:'Use at least 10 characters.' };
      a.password_hash = await hashPassword(newPassword);
      a.must_change = false;
      a.mfa_secret = a.mfa_secret || randomSecret();
      await put(a);
      await audit(a.username,'change_password',a.username,{});
      return { ok:true, id:a.id, secret:a.mfa_secret, otpauth: otpauth(a.username, a.mfa_secret) };
    },

    async verifyMfa(id, code, enrol){
      if(DRIVER==='api') return (await apiCall('/api/auth','mfa',{challenge:id,code})).body;
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'unknown' };
      if(!await verifyTotp(a.mfa_secret, code))
        return { error:'code', message:'That code is not valid. Codes refresh every 30 seconds.' };
      if(enrol){ a.mfa_enabled = true; await put(a); }
      return this._finish(a);
    },

    async skipMfa(id){
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'unknown' };
      return this._finish(a);
    },

    async _finish(a){
      a.last_login = new Date().toISOString();
      await put(a); await logEvent(a.username,'login');
      setSession(a);
      const n = splitName(a.full_name);
      return { ok:true, account:{ id:a.id, username:a.username, role:a.role, name:a.full_name,
               first:a.first_name||n.first, last:a.last_name||n.last,
               title:a.title, initials:a.initials, pid:a.provider_id, scope:a.scope } };
    },

    async create(data){
      if(DRIVER==='api') return (await apiCall('/api/admin/users','create',data)).body;
      await seed();
      const username = String(data.username||'').trim().toLowerCase();
      if(!username || !data.full_name || !data.role) return { error:'Username, full name and role are required' };
      if(!/^[a-z0-9._-]{3,40}$/.test(username)) return { error:'Username may use letters, numbers, dot, dash and underscore only' };
      if(await this.find(username)) return { error:'That username is already taken' };

      const pw = data.password || tempPassword();
      const secret = data.mfa_enabled ? randomSecret() : null;
      const me = getSession();
      const nm = splitName(data.full_name);
      const row = {
        username, password_hash: await hashPassword(pw),
        role: data.role, full_name: data.full_name,
        first_name: data.first_name || nm.first,
        last_name:  data.last_name  || nm.last,
        name_prefix: nm.prefix || null,
        name_suffix: nm.suffix || null,
        title: data.title||null,
        initials: data.initials || initialsOf(data.full_name),
        email: data.email||null, phone: data.phone||null,
        provider_id: data.provider_id||null,
        scope: data.scope || (data.role==='admin'?'all':data.role==='provider'?'self':'facility'),
        status:'active', must_change: data.must_change !== false,
        mfa_enabled:false, mfa_secret:secret,
        failed_attempts:0, locked_until:null, last_login:null,
        created_by: me ? me.username : 'system', created_at:new Date().toISOString()
      };
      const id = await put(row);
      await audit(me?me.username:'system','create_account',username,{ role:data.role });
      return { ok:true, account:{ id, username, role:data.role, full_name:data.full_name },
               tempPassword: data.password ? null : pw,
               mfa: secret ? { secret, otpauth: otpauth(username, secret) } : null };
    },

    splitName,

    /* a provider editing their own profile files a remark; the name of record is unchanged */
    async requestNameChange(id, first, last){
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'Not found' };
      const wasFirst = a.first_name || splitName(a.full_name).first;
      const wasLast  = a.last_name  || splitName(a.full_name).last;
      if(wasFirst === first && wasLast === last) return { ok:true, changed:false };

      a.pending_name = { first, last, at:new Date().toISOString() };
      a.remarks = a.remarks || [];
      a.remarks.unshift({
        type:'name_change',
        text:`Requested name change from "${wasFirst} ${wasLast}" to "${first} ${last}"`,
        from:{ first:wasFirst, last:wasLast },
        to:{ first, last },
        at:new Date().toISOString(),
        by:a.username, status:'pending'
      });
      await put(a);
      await audit(a.username,'name_change_request',a.username,{ from:wasFirst+' '+wasLast, to:first+' '+last });
      return { ok:true, changed:true };
    },

    /* admin accepts the requested name */
    async approveNameChange(id){
      const a = (await all()).find(x => x.id === id);
      if(!a || !a.pending_name) return { error:'Nothing pending' };
      const { first, last } = a.pending_name;
      a.first_name = first; a.last_name = last;
      a.full_name = [a.name_prefix, first, last].filter(Boolean).join(' ') +
                    (a.name_suffix ? ', ' + a.name_suffix : '');
      a.initials = initialsOf(first + ' ' + last);
      (a.remarks||[]).forEach(r => { if(r.type==='name_change' && r.status==='pending') r.status='approved'; });
      a.pending_name = null;
      await put(a);
      const me = getSession();
      await audit(me?me.username:'system','name_change_approved',a.username,{});
      return { ok:true, full_name:a.full_name };
    },

    async remarks(){
      const rows = await all();
      const out = [];
      rows.forEach(a => (a.remarks||[]).forEach(r => out.push({ ...r, account:a.username,
        account_name:a.full_name, id:a.id })));
      return out.sort((x,y) => new Date(y.at) - new Date(x.at));
    },

    async update(id, patch){
      if(DRIVER==='api') return (await apiCall('/api/admin/users','update',{id,...patch})).body;
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'Not found' };
      Object.keys(patch).forEach(k => { if(patch[k] !== undefined && patch[k] !== null) a[k] = patch[k]; });
      await put(a);
      const me = getSession();
      await audit(me?me.username:'system','update_account',a.username,patch);
      return { ok:true };
    },

    async resetPassword(id, password){
      if(DRIVER==='api') return (await apiCall('/api/admin/users','reset-password',{id,password})).body;
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'Not found' };
      const pw = password || tempPassword();
      a.password_hash = await hashPassword(pw);
      a.must_change = true; a.failed_attempts = 0; a.locked_until = null;
      await put(a);
      const me = getSession();
      await audit(me?me.username:'system','reset_password',a.username,{});
      return { ok:true, tempPassword:pw, username:a.username };
    },

    async remove(id){
      if(DRIVER==='api') return (await apiCall('/api/admin/users','delete',{id})).body;
      const rows = await all();
      const a = rows.find(x => x.id === id);
      if(!a) return { error:'Not found' };
      const me = getSession();
      if(me && a.username === me.username) return { error:'You cannot delete your own account' };
      if(a.role === 'admin' && rows.filter(x => x.role==='admin' && x.status==='active').length <= 1)
        return { error:'This is the last active administrator' };
      await del(id);
      await audit(me?me.username:'system','delete_account',a.username,{});
      return { ok:true };
    },

    /* a user editing their own name — recorded as a remark, name field untouched */
    async requestNameChange(id, first, last){
      const rows = await all();
      const a = rows.find(x => x.id === id);
      if(!a) return { error:'Not found' };
      const before = ((a.first_name||'')+' '+(a.last_name||'')).trim();
      const after  = ((first||'')+' '+(last||'')).trim();
      if(before === after) return { ok:true, unchanged:true };
      a.name_remarks = a.name_remarks || [];
      a.name_remarks.unshift({ from:before, to:after, at:new Date().toISOString(), by:a.username });
      a.first_name = first;
      a.last_name = last;
      a.display_name = ((a.name_prefix?a.name_prefix+' ':'')+after+(a.name_suffix?', '+a.name_suffix:'')).trim();
      await put(a);
      await audit(a.username,'name_change',a.username,{ from:before, to:after });
      const sess = getSession();
      if(sess && sess.id === id){ sess.name = a.display_name || after; sessionStorage.setItem(SKEY, JSON.stringify(sess)); }
      return { ok:true, from:before, to:after };
    },

    async get(id){
      const a = (await all()).find(x => x.id === id);
      if(!a) return null;
      const { password_hash, mfa_secret, ...rest } = a;
      return rest;
    },

    async events(){ return (await meta('events')) || []; },
    async auditLog(){ return (await meta('audit')) || []; },

    /* wipe everything and re-seed the temp admin */
    async reset(){
      const d = await idb();
      await new Promise(r => { const t = d.transaction([STORE,META],'readwrite');
        t.objectStore(STORE).clear(); t.objectStore(META).clear(); t.oncomplete = r; });
      clearSession(); await seed();
      return TEMP_ADMIN;
    }
  };
})();
