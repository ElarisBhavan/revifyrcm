/* ═══════════════════════════════════════════════════════════════
   ReviFlow — account store
   ONE interface, TWO drivers:
     'local' — IndexedDB in the browser. Works with no server.
     'api'   — the Netlify Functions + Postgres backend.
   Flip DRIVER to 'api' after deploying. No other file changes.
   Passwords are PBKDF2-hashed in both drivers — never stored readable.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  /* 'api'   — accounts live in Postgres, shared by everyone (needs deployment)
     'local' — accounts live in this browser only, for offline development */
  const DRIVER = 'local';           // ← change to 'api' once deployed
  const DB = 'reviflow', STORE = 'accounts', META = 'meta', VER = 7;
  const ORGS = 'orgs', PROVIDERS = 'providers', PATIENTS = 'patients', APPTS = 'appts', TASKS = 'tasks', CLAIMS = 'claims', ENC = 'encounters', HIST = 'history', CRED = 'credentialing';

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
        if(!d.objectStoreNames.contains(ORGS))
          d.createObjectStore(ORGS, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(PROVIDERS))
          d.createObjectStore(PROVIDERS, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(PATIENTS))
          d.createObjectStore(PATIENTS, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(ENC))
          d.createObjectStore(ENC, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(CRED))
          d.createObjectStore(CRED, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(HIST))
          d.createObjectStore(HIST, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(CLAIMS))
          d.createObjectStore(CLAIMS, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(ENC))
          d.createObjectStore(ENC, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(CRED))
          d.createObjectStore(CRED, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(HIST))
          d.createObjectStore(HIST, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(CLAIMS))
          d.createObjectStore(CLAIMS, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(TASKS))
          d.createObjectStore(TASKS, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(ENC))
          d.createObjectStore(ENC, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(CRED))
          d.createObjectStore(CRED, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(HIST))
          d.createObjectStore(HIST, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(CLAIMS))
          d.createObjectStore(CLAIMS, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(ENC))
          d.createObjectStore(ENC, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(CRED))
          d.createObjectStore(CRED, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(HIST))
          d.createObjectStore(HIST, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(CLAIMS))
          d.createObjectStore(CLAIMS, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(TASKS))
          d.createObjectStore(TASKS, { keyPath:'id', autoIncrement:true });
        if(!d.objectStoreNames.contains(APPTS)){
          const ap = d.createObjectStore(APPTS, { keyPath:'id', autoIncrement:true });
          ap.createIndex('date','date',{ unique:false });
        }
      };
      r.onsuccess = () => {
        const d = r.result;
        d.onversionchange = () => d.close();
        res(d);
      };
      r.onerror = () => rej(r.error || new Error('Could not open the local database'));
      r.onblocked = () => rej(new Error(
        'Another ReviFlow tab is open with an older version. Close the other tabs and reload.'));
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
  const rows  = st => tx(st,'readonly',  s => s.getAll());
  const save_ = (st,v) => tx(st,'readwrite', s => s.put(v));
  const kill  = (st,id) => tx(st,'readwrite', s => s.delete(id));
  const meta  = async k => (await tx(META,'readonly', s => s.get(k)) || {}).v;
  const setMeta = (k,v) => tx(META,'readwrite', s => s.put({k, v}));

  /* ── password hashing: PBKDF2-SHA256, 150k rounds ── */
  const enc = new TextEncoder();
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('');
  /* PBKDF2-HMAC-SHA256 at the OWASP-recommended work factor.
     Format: pbkdf2$<iterations>$<salt>$<hash>. The older salt:hash form
     still verifies, so accounts created before this change keep working
     and are quietly upgraded on the next successful sign-in. */
  const KDF_ROUNDS = 310000;

  async function derive(pw, salt, rounds){
    const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name:'PBKDF2', salt, iterations:rounds, hash:'SHA-256' }, key, 256);
    return hex(bits);
  }
  const unhex = h => Uint8Array.from(String(h).match(/../g).map(x => parseInt(x,16)));

  async function hashPassword(pw){
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const h = await derive(pw, salt, KDF_ROUNDS);
    return `pbkdf2$${KDF_ROUNDS}$${hex(salt)}$${h}`;
  }

  function timingSafeEqual(a, b){
    if(a.length !== b.length) return false;
    let diff = 0;
    for(let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  async function checkPassword(pw, stored){
    if(!stored) return false;
    try{
      if(stored.startsWith('pbkdf2$')){
        const [, rounds, salt, want] = stored.split('$');
        const got = await derive(pw, unhex(salt), parseInt(rounds,10));
        return timingSafeEqual(got, want);
      }
      /* legacy: salt:hash at 150k rounds */
      if(stored.includes(':')){
        const [salt, want] = stored.split(':');
        const got = await derive(pw, unhex(salt), 150000);
        return timingSafeEqual(got, want);
      }
    }catch(e){}
    return false;
  }
  const isLegacyHash = h => !!h && !String(h).startsWith('pbkdf2$');

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

  /* ── session: owned by RFSession so every tab agrees ── */
  const SKEY = 'rf_session';
  const sessionPayload = a => {
    const n = splitName(a.full_name);
    return {
      id:a.id, username:a.username, role:a.role,
      name: a.display_name || a.full_name,
      first: a.first_name || n.first, last: a.last_name || n.last,
      title:a.title, initials:a.initials, pid:a.provider_id, scope:a.scope,
      org_id:a.org_id||null, provider_ref:a.provider_ref||null, at:Date.now()
    };
  };
  const setSession = a => {
    const p = sessionPayload(a);
    if(window.RFSession) window.RFSession.start(p);
    else { try{ localStorage.setItem(SKEY, JSON.stringify(p)); }catch(e){} }
    return p;
  };
  const getSession = () => {
    if(window.RFSession) return window.RFSession.get();
    try{ return JSON.parse(localStorage.getItem(SKEY) || 'null'); }catch(e){ return null; }
  };
  const clearSession = () => {
    if(DRIVER === 'api'){
      /* let the server drop the cookie too; the local end is immediate */
      try{ fetch('/api/auth?action=logout', { method:'POST', credentials:'same-origin' }); }catch(e){}
    }
    if(window.RFSession) return window.RFSession.end('manual');
    try{ localStorage.removeItem(SKEY); }catch(e){}
  };

  /* ── remote driver: the same interface, served by Netlify Functions ── */
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

    async ready(){
      if(DRIVER==='local'){ await seed(); return; }
      /* remote: the cookie is the source of truth, so check it once per load */
      try{
        const r = await fetch('/api/auth?action=me', { credentials:'same-origin' });
        if(r.ok){
          const j = await r.json();
          if(j.account && window.RFSession && !window.RFSession.get())
            window.RFSession.start({ ...j.account, at:Date.now() });
        }else if(window.RFSession && window.RFSession.get()){
          window.RFSession.end('expired');
        }
      }catch(e){}
    },

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
      if(DRIVER==='api'){
        const r = await apiCall('/api/auth','login',{username,password});
        /* the server sets an httpOnly cookie; mirror the identity locally
           so every tab can render the header without another round trip */
        if(r.body && r.body.ok && r.body.account && window.RFSession)
          window.RFSession.start({ ...r.body.account, at:Date.now() });
        return r.body;
      }
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
      a.failed_attempts = 0; a.locked_until = null;
      /* quietly move an old hash up to the current work factor */
      if(isLegacyHash(a.password_hash)){
        try{ a.password_hash = await hashPassword(password); }catch(e){}
      }
      await put(a);

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
      if(DRIVER==='api'){
        const r = await apiCall('/api/auth','mfa',{challenge:id,code});
        if(r.body && r.body.ok && r.body.account && window.RFSession)
          window.RFSession.start({ ...r.body.account, at:Date.now() });
        return r.body;
      }
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
      try{ await this.touchDevice(); }catch(e){}
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
        org_id: data.org_id || null,
        provider_ref: data.provider_ref || null,
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

    /* ═══ ORGANIZATIONS ═══ */
    async orgs(){ return (await rows(ORGS)).sort((a,b)=>a.name.localeCompare(b.name)); },
    async org(id){ return (await rows(ORGS)).find(o => o.id === id) || null; },
    async saveOrg(o){
      try{
      const me = getSession();
      if(!o.name) return { error:'Organization name is required' };
      if(o.id === undefined || o.id === null || o.id === '') delete o.id;
      if(!o.id){
        o.created_at = new Date().toISOString();
        o.created_by = me ? me.username : 'system';
      }
      o.updated_at = new Date().toISOString();
      const id = await save_(ORGS, o);
      await audit(me?me.username:'system', o.id?'update_org':'create_org', o.name, {});
      return { ok:true, id: o.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async removeOrg(id){
      const linked = (await rows(PROVIDERS)).filter(p => p.org_id === id);
      if(linked.length) return { error:`${linked.length} provider(s) are still attached to this organization.` };
      await kill(ORGS, id);
      const me = getSession();
      await audit(me?me.username:'system','delete_org',String(id),{});
      return { ok:true };
    },

    /* ═══ PROVIDERS ═══ */
    async providers(orgId){
      const list = (await rows(PROVIDERS)).sort((a,b)=>
        (a.last_name||'').localeCompare(b.last_name||''));
      return orgId ? list.filter(p => p.org_id === orgId) : list;
    },
    async provider(id){ return (await rows(PROVIDERS)).find(p => p.id === id) || null; },
    async saveProvider(p){
      try{
      const me = getSession();
      if(!p.full_name) return { error:'Provider name is required' };
      if(p.id === undefined || p.id === null || p.id === '') delete p.id;
      if(!p.org_id)    return { error:'Select the organization this provider belongs to' };
      const n = splitName(p.full_name);
      p.first_name = p.first_name || n.first;
      p.last_name  = p.last_name  || n.last;
      p.name_prefix = n.prefix || null;
      p.initials = p.initials || initialsOf(p.full_name);
      if(!p.id){
        p.created_at = new Date().toISOString();
        p.created_by = me ? me.username : 'system';
        p.remarks = [];
        p.code = p.code || (n.first[0]||'X').toUpperCase() + (n.last[0]||'X').toUpperCase();
      }
      p.updated_at = new Date().toISOString();
      const id = await save_(PROVIDERS, p);
      await audit(me?me.username:'system', p.id?'update_provider':'create_provider', p.full_name, {});
      return { ok:true, id: p.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async removeProvider(id){
      await kill(PROVIDERS, id);
      const me = getSession();
      await audit(me?me.username:'system','delete_provider',String(id),{});
      return { ok:true };
    },
    /* a provider editing their own record — recorded as a remark */
    async providerRemark(id, changes, by){
      const p = (await rows(PROVIDERS)).find(x => x.id === id);
      if(!p) return { error:'Not found' };
      p.remarks = p.remarks || [];
      p.remarks.unshift({ changes, by: by || 'provider', at: new Date().toISOString() });
      Object.keys(changes).forEach(k => { p[k] = changes[k].to; });
      p.updated_at = new Date().toISOString();
      await save_(PROVIDERS, p);
      return { ok:true };
    },
    /* which providers still have no login */
    async providersWithoutLogin(){
      const accts = await all();
      const ids = new Set(accts.map(a => a.provider_ref).filter(Boolean));
      return (await rows(PROVIDERS)).filter(p => !ids.has(p.id));
    },

    /* ═══ PATIENTS (shared by scheduling and the patient dashboard) ═══ */
    async patients(){ return rows(PATIENTS); },
    async savePatient(pt){
      if(!pt.id){ pt.created_at = new Date().toISOString(); }
      const id = await save_(PATIENTS, pt);
      return { ok:true, id: pt.id || id };
    },

    /* ═══ ELIGIBILITY HISTORY — 24 hours, scoped to the signed-in user ═══ */
    async eligHistory(){
      const me = getSession();
      const key = 'elig:' + (me ? me.username : 'anon');
      const raw = (await meta(key)) || [];
      const cut = Date.now() - 86400000;
      const live = raw.filter(r => r.t > cut);
      if(live.length !== raw.length) await setMeta(key, live);
      return live;
    },
    async pushElig(entry){
      const me = getSession();
      const key = 'elig:' + (me ? me.username : 'anon');
      const raw = (await meta(key)) || [];
      const cut = Date.now() - 86400000;
      let list = raw.filter(r => r.t > cut && !(r.n === entry.n && r.d === entry.d));
      const id = 'e_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
      list.unshift({ ...entry, id, t: Date.now() });
      await setMeta(key, list.slice(0,30));
      return { list, id };
    },
    /* the full 271 for one saved check */
    async eligResult(id){
      const list = await this.eligHistory();
      return list.find(r => r.id === id) || null;
    },
    async lastElig(){
      const list = await this.eligHistory();
      return list[0] || null;
    },

    /* ═══ APPOINTMENTS ═══ */
    async appts(date, providerIds){
      let list = await rows(APPTS);
      if(date) list = list.filter(a => a.date === date);
      if(providerIds && providerIds.length){
        const set = new Set(providerIds.map(String));
        list = list.filter(a => set.has(String(a.provider_id)));
      }
      return list.sort((a,b) => a.start - b.start);
    },
    async appt(id){ return (await rows(APPTS)).find(a => a.id === id) || null; },
    async saveAppt(a){
      try{
        if(a.id === undefined || a.id === null || a.id === '') delete a.id;
        if(!a.provider_id) return { error:'Choose a provider' };
        if(!a.date)        return { error:'Choose a date' };
        if(a.start == null) return { error:'Choose a start time' };
        a.dur = +a.dur || 20;

        /* refuse to double-book the same provider unless it is the same record */
        const clash = (await rows(APPTS)).find(x =>
          String(x.provider_id) === String(a.provider_id) &&
          x.date === a.date && x.id !== a.id &&
          a.start < (x.start + x.dur) && x.start < (a.start + a.dur));
        if(clash) return {
          error:`That overlaps ${clash.patient_last||'an existing appointment'} at ` +
                `${String(Math.floor(clash.start/60)).padStart(2,'0')}:${String(clash.start%60).padStart(2,'0')}.`
        };

        const me = getSession();
        if(!a.id){
          a.created_at = new Date().toISOString();
          a.created_by = me ? me.username : 'system';
          a.status = a.status || 'Scheduled';
        }
        a.updated_at = new Date().toISOString();
        const id = await save_(APPTS, a);
        return { ok:true, id: a.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async removeAppt(id){
      try{
        const list = await rows(APPTS);
        const target = list.find(a => a.id === id);
        /* an attendee copy points at the organiser's row via linked_to */
        const rootId = (target && target.linked_to) || id;
        const doomed = list.filter(a => a.id === rootId || a.linked_to === rootId);
        for(const a of doomed) await kill(APPTS, a.id);
        return { ok:true, removed: doomed.length };
      }catch(err){ return { error:String(err && err.message || err) }; }
    },

    /* keep attendee copies in step when the organiser edits a meeting */
    async syncMeeting(rootId, patch){
      try{
        const list = await rows(APPTS);
        const copies = list.filter(a => a.linked_to === rootId);
        for(const c of copies){
          Object.assign(c, patch, { id:c.id, provider_id:c.provider_id, linked_to:rootId });
          await save_(APPTS, c);
        }
        return { ok:true, synced: copies.length };
      }catch(err){ return { error:String(err && err.message || err) }; }
    },

    /* attendee copies that are no longer invited */
    async pruneMeeting(rootId, keepProviderIds){
      try{
        const keep = new Set((keepProviderIds||[]).map(String));
        const list = await rows(APPTS);
        const gone = list.filter(a => a.linked_to === rootId && !keep.has(String(a.provider_id)));
        for(const a of gone) await kill(APPTS, a.id);
        return { ok:true, removed: gone.length };
      }catch(err){ return { error:String(err && err.message || err) }; }
    },

    /* ═══ PER-USER PREFERENCES ═══ */
    async prefs(){
      const me = getSession();
      return (await meta('prefs:' + (me ? me.username : 'anon'))) || {};
    },
    async setPrefs(patch){
      const me = getSession();
      const key = 'prefs:' + (me ? me.username : 'anon');
      const cur = (await meta(key)) || {};
      const next = { ...cur, ...patch };
      await setMeta(key, next);
      return next;
    },

    /* ═══ DEVICES / ACTIVE SESSIONS ═══ */
    _deviceId(){
      let id = localStorage.getItem('rf_device');
      if(!id){
        id = 'dev_' + Math.random().toString(36).slice(2,10);
        localStorage.setItem('rf_device', id);
      }
      return id;
    },
    _describe(){
      const ua = navigator.userAgent;
      let os = 'Unknown device', br = 'Browser';
      if(/iPhone/.test(ua)) os = 'iPhone';
      else if(/iPad/.test(ua)) os = 'iPad';
      else if(/Android/.test(ua)) os = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
      else if(/Macintosh/.test(ua)) os = 'Mac';
      else if(/Windows/.test(ua)) os = 'Windows PC';
      else if(/Linux/.test(ua)) os = 'Linux';
      if(/Edg\//.test(ua)) br = 'Edge';
      else if(/OPR\//.test(ua)) br = 'Opera';
      else if(/Chrome\//.test(ua)) br = 'Chrome';
      else if(/Firefox\//.test(ua)) br = 'Firefox';
      else if(/Safari\//.test(ua)) br = 'Safari';
      return { os, br, label: os + ' · ' + br };
    },
    async touchDevice(){
      const me = getSession();
      if(!me) return;
      const key = 'devices:' + me.username;
      const list = (await meta(key)) || [];
      const id = this._deviceId(), d = this._describe();
      const i = list.findIndex(x => x.id === id);
      const rec = { id, label: d.label, os: d.os, br: d.br,
                    first: i > -1 ? list[i].first : new Date().toISOString(),
                    last: new Date().toISOString() };
      if(i > -1) list[i] = rec; else list.unshift(rec);
      await setMeta(key, list.slice(0,12));
      return rec;
    },
    async devices(){
      const me = getSession();
      if(!me) return [];
      const list = (await meta('devices:' + me.username)) || [];
      const here = this._deviceId();
      return list.map(d => ({ ...d, current: d.id === here }))
                 .sort((a,b) => (b.current?1:0) - (a.current?1:0) || new Date(b.last) - new Date(a.last));
    },
    async revokeDevice(id){
      const me = getSession();
      if(!me) return { error:'Not signed in' };
      const key = 'devices:' + me.username;
      const list = ((await meta(key)) || []).filter(d => d.id !== id);
      await setMeta(key, list);
      return { ok:true };
    },

    /* the signed-in user changing their own password */
    async selfPassword(current, next){
      const me = getSession();
      if(!me) return { error:'Not signed in' };
      const a = (await all()).find(x => x.id === me.id);
      if(!a) return { error:'Account not found' };
      if(!await checkPassword(current, a.password_hash))
        return { error:'current', message:'That current password is not correct.' };
      if(String(next).length < 10)
        return { error:'weak', message:'Use at least 10 characters.' };
      a.password_hash = await hashPassword(next);
      a.must_change = false;
      a.password_changed = new Date().toISOString();
      await put(a);
      await audit(a.username,'change_password',a.username,{ self:true });
      return { ok:true };
    },

    /* ═══ PER-USER SETTINGS ═══ */
    async settings(){
      const me = getSession();
      if(!me) return {};
      return (await meta('cfg:'+me.username)) || {};
    },
    async settingsFor(username){ return (await meta('cfg:'+username)) || {}; },
    async saveSettings(patch){
      const me = getSession();
      if(!me) return { error:'Not signed in' };
      const cur = (await meta('cfg:'+me.username)) || {};
      const next = { ...cur, ...patch, updated_at:new Date().toISOString() };
      await setMeta('cfg:'+me.username, next);
      return { ok:true, settings:next };
    },

    /* ═══ DEVICE SESSIONS ═══ */
    deviceLabel(){
      const ua = navigator.userAgent, p = navigator.platform || '';
      let device = 'Unknown device', browser = 'Browser';
      if(/iPhone/.test(ua)) device = 'iPhone';
      else if(/iPad/.test(ua)) device = 'iPad';
      else if(/Android/.test(ua)) device = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
      else if(/Macintosh/.test(ua)) device = 'Mac';
      else if(/Windows/.test(ua)) device = 'Windows PC';
      else if(/Linux/.test(ua)) device = 'Linux PC';
      if(/Edg\//.test(ua)) browser = 'Edge';
      else if(/OPR\//.test(ua)) browser = 'Opera';
      else if(/Chrome\//.test(ua)) browser = 'Chrome';
      else if(/Firefox\//.test(ua)) browser = 'Firefox';
      else if(/Safari\//.test(ua)) browser = 'Safari';
      return { device, browser, label: device + ' · ' + browser, platform: p };
    },
    deviceId(){
      let id = localStorage.getItem('rf_device');
      if(!id){
        id = 'dev_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
        localStorage.setItem('rf_device', id);
      }
      return id;
    },
    async touchDevice(){
      const me = getSession();
      if(!me) return;
      const key = 'dev:' + me.username;
      const list = (await meta(key)) || [];
      const id = this.deviceId(), info = this.deviceLabel();
      const now = new Date().toISOString();
      const found = list.find(d => d.id === id);
      if(found){ found.last_seen = now; found.label = info.label; }
      else list.unshift({ id, label:info.label, device:info.device, browser:info.browser,
                          first_seen:now, last_seen:now });
      /* drop anything untouched for a week */
      const cut = Date.now() - 7*86400000;
      await setMeta(key, list.filter(d => new Date(d.last_seen).getTime() > cut).slice(0,12));
    },
    async devices(){
      const me = getSession();
      if(!me) return [];
      const list = (await meta('dev:'+me.username)) || [];
      const id = this.deviceId();
      return list.map(d => ({ ...d, current: d.id === id }))
                 .sort((a,b) => (b.current?1:0)-(a.current?1:0) ||
                                new Date(b.last_seen)-new Date(a.last_seen));
    },
    async signOutDevice(id){
      const me = getSession();
      if(!me) return { error:'Not signed in' };
      const key = 'dev:'+me.username;
      const list = ((await meta(key)) || []).filter(d => d.id !== id);
      await setMeta(key, list);
      return { ok:true };
    },

    /* change your own password, checking the old one first */
    async changeOwnPassword(current, next){
      const me = getSession();
      if(!me) return { error:'Not signed in' };
      const a = (await all()).find(x => x.id === me.id);
      if(!a) return { error:'Account not found' };
      if(!await checkPassword(current, a.password_hash))
        return { error:'current', message:'That current password is not correct.' };
      if(String(next).length < 10)
        return { error:'weak', message:'Use at least 10 characters.' };
      a.password_hash = await hashPassword(next);
      a.must_change = false;
      await put(a);
      await audit(a.username,'change_password',a.username,{ self:true });
      return { ok:true };
    },

    /* ═══ BATCH ELIGIBILITY ═══ */
    async batches(){
      const me = getSession();
      const list = (await meta('batch:'+(me?me.username:'anon'))) || [];
      return list.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    },
    async batch(id){ return (await this.batches()).find(b => b.id === id) || null; },
    async saveBatch(b){
      const me = getSession();
      const key = 'batch:'+(me?me.username:'anon');
      const list = (await meta(key)) || [];
      const i = list.findIndex(x => x.id === b.id);
      if(i > -1) list[i] = b; else list.unshift(b);
      await setMeta(key, list.slice(0,60));
      return { ok:true };
    },
    async removeBatch(id){
      const me = getSession();
      const key = 'batch:'+(me?me.username:'anon');
      const list = ((await meta(key)) || []).filter(b => b.id !== id);
      await setMeta(key, list);
      return { ok:true };
    },

    /* ═══ TASKS ═══ */

    /* who this account may assign work to */
    async assignable(){
      const me = getSession();
      if(!me) return [];
      const accts = await this.list();
      const orgId = me.org_id || null;
      return accts.filter(a => {
        if(a.username === me.username) return false;
        if(a.status !== 'active') return false;
        if(a.role === 'admin') return true;              /* admins are always reachable */
        if(!orgId) return false;
        return String(a.org_id) === String(orgId);       /* everyone else must share the facility */
      }).map(a => ({
        username:a.username, name:a.full_name, role:a.role,
        title:a.title || '', initials:a.initials || '', org_id:a.org_id || null
      })).sort((x,y) => x.role.localeCompare(y.role) || x.name.localeCompare(y.name));
    },

    async tasks(){ return rows(TASKS); },

    /* everything this account is allowed to see, and in what capacity */
    async myTasks(){
      const me = getSession();
      if(!me) return [];
      const all = await rows(TASKS);
      return all.filter(t =>
          t.to === me.username ||
          t.from === me.username ||
          (t.cc || []).includes(me.username)
        ).map(t => ({
          ...t,
          _mine:   t.to === me.username,
          _sent:   t.from === me.username,
          _cc:     (t.cc || []).includes(me.username) && t.to !== me.username,
          _canEdit: t.to === me.username || t.from === me.username
        }))
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    },

    async saveTask(t){
      try{
        const me = getSession();
        if(t.id === undefined || t.id === null || t.id === '') delete t.id;
        if(!t.to)    return { error:'Choose who the task is for' };
        if(!t.title) return { error:'Give the task a name' };

        if(!t.id){
          t.created_at = new Date().toISOString();
          t.from = me ? me.username : 'system';
          t.from_name = me ? me.name : 'System';
          t.status = t.status || 'open';
          t.ref = 'TSK-' + Math.floor(4000 + Math.random() * 5999);
          t.history = [{ at:t.created_at, by:t.from, by_name:t.from_name,
                         what:'Assigned to ' + (t.to_name || t.to) }];
        }
        t.cc = t.cc || [];
        t.org_id = t.org_id || (me ? me.org_id : null);
        t.updated_at = new Date().toISOString();
        const id = await save_(TASKS, t);
        return { ok:true, id: t.id || id, ref:t.ref };
      }catch(err){ return { error:'Save failed: ' + (err && err.message || err) }; }
    },

    async updateTask(id, patch, note){
      try{
        const me = getSession();
        const list = await rows(TASKS);
        const t = list.find(x => x.id === id);
        if(!t) return { error:'Task not found' };
        /* a CC recipient may look but not touch */
        if(t.to !== me.username && t.from !== me.username)
          return { error:'You are copied on this task and cannot change it' };

        const before = { status:t.status, priority:t.priority, to:t.to };
        Object.assign(t, patch);
        t.updated_at = new Date().toISOString();
        t.history = t.history || [];
        const bits = [];
        if(patch.status   && patch.status   !== before.status)   bits.push('status → ' + patch.status);
        if(patch.priority && patch.priority !== before.priority) bits.push('priority → ' + patch.priority);
        if(patch.to       && patch.to       !== before.to)       bits.push('reassigned to ' + (patch.to_name || patch.to));
        if(note) bits.push(note);
        if(bits.length) t.history.unshift({
          at:t.updated_at, by:me.username, by_name:me.name, what:bits.join(' · ')
        });
        await save_(TASKS, t);
        return { ok:true, task:t };
      }catch(err){ return { error:String(err && err.message || err) }; }
    },

    async removeTask(id){
      try{
        const me = getSession();
        const t = (await rows(TASKS)).find(x => x.id === id);
        if(!t) return { error:'Not found' };
        if(t.from !== me.username) return { error:'Only the person who raised a task can delete it' };
        await kill(TASKS, id);
        return { ok:true };
      }catch(err){ return { error:String(err && err.message || err) }; }
    },

    /* ═══ TASKS ═══
       Visible to the assignee, the person who raised it, and anyone in CC.
       Nobody else — so a task sent to an admin never surfaces for an employee. */
    async tasks(){
      const me = getSession();
      if(!me) return [];
      const u = me.username;
      return (await rows(TASKS))
        .filter(t => t.assignee === u || t.created_by === u || (t.cc||[]).indexOf(u) > -1)
        .map(t => ({
          ...t,
          _role: t.assignee === u ? 'assignee' : (t.created_by === u ? 'owner' : 'cc'),
          _readonly: t.assignee !== u && t.created_by !== u
        }))
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    },
    async task(id){
      const me = getSession();
      const t = (await rows(TASKS)).find(x => x.id === id);
      if(!t || !me) return null;
      const u = me.username;
      if(t.assignee !== u && t.created_by !== u && (t.cc||[]).indexOf(u) < 0) return null;
      return { ...t, _readonly: t.assignee !== u && t.created_by !== u };
    },

    /* who this account may assign work to */
    async assignableTo(){
      const me = getSession();
      if(!me) return [];
      const accts = await all();
      const provs = await rows(PROVIDERS);
      const myOrg = me.org_id ||
        (provs.find(p => p.id === me.provider_ref) || {}).org_id || null;

      return accts
        .filter(a => a.status === 'active' && a.username !== me.username)
        /* admins are platform-wide; everyone else must share the facility */
        .filter(a => a.role === 'admin' || !myOrg || !a.org_id || a.org_id === myOrg)
        .map(a => ({
          username: a.username, name: a.full_name, role: a.role,
          title: a.title || '', org_id: a.org_id || null,
          initials: a.initials || initialsOf(a.full_name)
        }))
        .sort((a,b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
    },

    async saveTask(t){
      try{
        const me = getSession();
        if(!me) return { error:'Not signed in' };
        if(t.id === undefined || t.id === null || t.id === '') delete t.id;
        if(!t.title)    return { error:'Give the task a name' };
        if(!t.assignee) return { error:'Choose who the task is for' };

        if(!t.id){
          t.created_at = new Date().toISOString();
          t.created_by = me.username;
          t.from_name  = me.name || me.username;
          t.status     = t.status || 'open';
          t.history    = [{ at:t.created_at, by:me.username, what:'created',
                            detail:'Assigned to '+(t.assignee_name||t.assignee) }];
          t.ref        = 'TSK-' + Math.floor(4000 + Math.random()*5999);
        }else{
          const prev = (await rows(TASKS)).find(x => x.id === t.id);
          if(prev){
            /* CC may never write */
            if(prev.assignee !== me.username && prev.created_by !== me.username)
              return { error:'You have view-only access to this task' };
            t.history = prev.history || [];
            const changes = [];
            if(prev.status   !== t.status)   changes.push('status → '+t.status);
            if(prev.priority !== t.priority) changes.push('priority → '+t.priority);
            if(prev.assignee !== t.assignee) changes.push('reassigned to '+(t.assignee_name||t.assignee));
            if(changes.length)
              t.history = [{ at:new Date().toISOString(), by:me.username,
                             what:'updated', detail:changes.join(' · ') }].concat(t.history);
          }
        }
        t.updated_at = new Date().toISOString();
        const id = await save_(TASKS, t);
        return { ok:true, id: t.id || id, ref:t.ref };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },

    async addTaskNote(id, text){
      const me = getSession();
      const t = (await rows(TASKS)).find(x => x.id === id);
      if(!t || !me) return { error:'Not found' };
      if(t.assignee !== me.username && t.created_by !== me.username)
        return { error:'You have view-only access to this task' };
      t.history = [{ at:new Date().toISOString(), by:me.username,
                     what:'note', detail:text }].concat(t.history || []);
      t.updated_at = new Date().toISOString();
      await save_(TASKS, t);
      return { ok:true };
    },

    async removeTask(id){
      const me = getSession();
      const t = (await rows(TASKS)).find(x => x.id === id);
      if(!t) return { error:'Not found' };
      if(t.created_by !== me.username) return { error:'Only the person who raised it can delete a task' };
      await kill(TASKS, id);
      return { ok:true };
    },

    /* ═══ CLAIMS ═══ */
    async claims(filter){
      let list = await rows(CLAIMS);
      if(filter && filter.patient_ref) list = list.filter(c => c.patient_ref === filter.patient_ref);
      if(filter && filter.org_id)      list = list.filter(c => c.org_id === filter.org_id);
      if(filter && filter.provider_id) list = list.filter(c => String(c.provider_id) === String(filter.provider_id));
      return list.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    },
    async claim(id){ return (await rows(CLAIMS)).find(c => c.id === id) || null; },
    async claimForAppt(apptId){
      return (await rows(CLAIMS)).find(c => String(c.appt_ref) === String(apptId)) || null;
    },
    async saveClaim(c){
      try{
        const me = getSession();
        if(c.id === undefined || c.id === null || c.id === '') delete c.id;
        if(!c.patient_ref) return { error:'The claim must be attached to a patient' };
        if(!c.lines || !c.lines.length) return { error:'Add at least one service line' };
        if(!c.id){
          c.created_at = new Date().toISOString();
          c.created_by = me ? me.username : 'system';
          c.created_by_name = me ? (me.name || me.username) : 'system';
          c.number = 'CLM' + Math.floor(900000 + Math.random()*99999);
          c.status = c.status || 'draft';
          c.history = [{ at:c.created_at, by:c.created_by, what:'created',
                         detail:'Claim drafted from '+(c.dos||'service') }];
        }
        c.total = (c.lines||[]).reduce((t,l) => t + (+l.charge||0) * (+l.units||1), 0);
        c.updated_at = new Date().toISOString();
        const id = await save_(CLAIMS, c);
        return { ok:true, id: c.id || id, number:c.number };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async setClaimStatus(id, status, note){
      const me = getSession();
      const c = (await rows(CLAIMS)).find(x => x.id === id);
      if(!c) return { error:'Not found' };
      c.status = status;
      c.history = [{ at:new Date().toISOString(), by:me?me.username:'system',
                     what:'status', detail:status + (note?' — '+note:'') }].concat(c.history||[]);
      if(status === 'submitted') c.submitted_at = new Date().toISOString();
      c.updated_at = new Date().toISOString();
      await save_(CLAIMS, c);
      return { ok:true };
    },
    async removeClaim(id){ await kill(CLAIMS, id); return { ok:true }; },

    /* appointments for one patient, newest first */
    async apptsForPatient(ref){
      return (await rows(APPTS))
        .filter(a => String(a.patient_ref) === String(ref) && (a.block_type||'patient')==='patient')
        .sort((a,b) => (b.date+String(b.start).padStart(4,'0')).localeCompare(a.date+String(a.start).padStart(4,'0')));
    },

    /* ═══ CLAIMS ═══ */
    async claims(filter){
      let list = await rows(CLAIMS);
      if(filter && filter.patient_ref) list = list.filter(c => c.patient_ref === filter.patient_ref);
      if(filter && filter.appt_id)     list = list.filter(c => c.appt_id === filter.appt_id);
      if(filter && filter.org_id)      list = list.filter(c => c.org_id === filter.org_id);
      return list.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    },
    async claim(id){ return (await rows(CLAIMS)).find(c => c.id === id) || null; },
    async claimForAppt(apptId){
      return (await rows(CLAIMS)).find(c => String(c.appt_id) === String(apptId)) || null;
    },
    async saveClaim(c){
      try{
        const me = getSession();
        if(c.id === undefined || c.id === null || c.id === '') delete c.id;
        if(!c.patient_ref && !c.patient_last) return { error:'The claim needs a patient' };
        if(!c.lines || !c.lines.length)       return { error:'Add at least one service line' };

        if(!c.id){
          c.created_at = new Date().toISOString();
          c.created_by = me ? me.username : 'system';
          c.created_name = me ? (me.name || me.username) : 'System';
          c.claim_no = 'CLM' + Math.floor(900000 + Math.random()*99999);
          c.status = c.status || 'submitted';
          c.history = [{ at:c.created_at, by:c.created_by, what:'created',
                         detail:'Claim built and submitted' }];
        }
        c.total = (c.lines || []).reduce((sum,l) => sum + (Number(l.charge)||0) * (Number(l.units)||1), 0);
        c.updated_at = new Date().toISOString();
        const id = await save_(CLAIMS, c);
        return { ok:true, id: c.id || id, claim_no: c.claim_no };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async setClaimStatus(id, status, note){
      const c = (await rows(CLAIMS)).find(x => x.id === id);
      if(!c) return { error:'Not found' };
      const me = getSession();
      c.status = status;
      c.history = [{ at:new Date().toISOString(), by:me?me.username:'system',
                     what:'status', detail:status + (note?' — '+note:'') }].concat(c.history||[]);
      c.updated_at = new Date().toISOString();
      await save_(CLAIMS, c);
      return { ok:true };
    },
    async removeClaim(id){ await kill(CLAIMS, id); return { ok:true }; },

    /* every appointment for one patient, newest first */
    async apptsForPatient(ref, last, first, memberId){
      const list = await rows(APPTS);
      const L = String(last||'').trim().toLowerCase();
      const F = String(first||'').trim().toLowerCase();
      const M = String(memberId||'').trim().toUpperCase();
      return list.filter(a => {
        if((a.block_type||'patient') !== 'patient') return false;
        /* a direct reference always wins */
        if(ref && String(a.patient_ref) === String(ref)) return true;
        /* otherwise fall back to the name or member id booked on the slot */
        if(M && String(a.member_id||'').toUpperCase() === M) return true;
        if(L && String(a.patient_last||'').toLowerCase() === L){
          const af = String(a.patient_first||'').toLowerCase();
          if(!F || !af || af === F) return true;
        }
        return false;
      }).sort((a,b) => (b.date+String(b.start).padStart(4,'0'))
                       .localeCompare(a.date+String(a.start).padStart(4,'0')));
    },

    /* ═══ PATIENT DEMOGRAPHICS ═══ */
    async patient(ref){
      const list = await rows(PATIENTS);
      return list.find(p => String(p.id) === String(ref)) || null;
    },
    async findPatient({ ref, memberId, last, first }){
      const list = await rows(PATIENTS);
      if(ref){ const a = list.find(p => String(p.id) === String(ref)); if(a) return a; }
      if(memberId){
        const M = String(memberId).toUpperCase();
        const b = list.find(p => String(p.member_id||'').toUpperCase() === M ||
                                 String(p.internal_id||'').toUpperCase() === M);
        if(b) return b;
      }
      if(last){
        const L = String(last).toLowerCase(), F = String(first||'').toLowerCase();
        const c = list.find(p => String(p.last_name||'').toLowerCase() === L &&
                                 (!F || String(p.first_name||'').toLowerCase() === F));
        if(c) return c;
      }
      return null;
    },
    async savePatientRec(p){
      try{
        if(p.id === undefined || p.id === null || p.id === '') delete p.id;
        if(!p.last_name) return { error:'Last name is required' };
        if(!p.id){
          p.created_at = new Date().toISOString();
          p.internal_id = p.internal_id ||
            (String(p.last_name).slice(0,3) + String(p.first_name||'XX').slice(0,3)).toUpperCase() +
            String(Math.floor(10 + Math.random()*89));
          p.insurances = p.insurances || [];
        }
        p.updated_at = new Date().toISOString();
        const id = await save_(PATIENTS, p);
        return { ok:true, id: p.id || id, internal_id:p.internal_id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },

    /* ═══ ENCOUNTERS ═══ */
    async encounters(patientRef){
      const list = await rows(ENC);
      return list.filter(e => String(e.patient_ref) === String(patientRef))
                 .sort((a,b) => (b.dos||'').localeCompare(a.dos||''));
    },
    async encounter(id){ return (await rows(ENC)).find(e => e.id === id) || null; },
    async encounterForAppt(apptId){
      return (await rows(ENC)).find(e => String(e.appt_id) === String(apptId)) || null;
    },
    async saveEncounter(e){
      try{
        if(e.id === undefined || e.id === null || e.id === '') delete e.id;
        const me = getSession();
        if(!e.id){
          e.created_at = new Date().toISOString();
          e.created_by = me ? me.username : 'system';
          e.status = e.status || 'open';
          e.lines = e.lines || [];
        }
        e.updated_at = new Date().toISOString();
        const id = await save_(ENC, e);
        return { ok:true, id: e.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async removeEncounter(id){ await kill(ENC, id); return { ok:true }; },

    /* ═══ ACTIVITY HISTORY ═══ */
    async history(patientRef){
      const list = await rows(HIST);
      return list.filter(h => !patientRef || String(h.patient_ref) === String(patientRef))
                 .sort((a,b) => new Date(b.at) - new Date(a.at));
    },
    async logHistory(patientRef, what, detail, extra){
      try{
        const me = getSession();
        await save_(HIST, {
          patient_ref: patientRef, what, detail: detail || '',
          by: me ? (me.name || me.username) : 'system',
          username: me ? me.username : 'system',
          at: new Date().toISOString(),
          ...(extra || {})
        });
      }catch(e){}
    },

    /* ═══ CREDENTIALING ═══
       One record per provider, holding their identifiers and a payer
       enrolment for each plan they are being credentialed with. */
    async credentialing(providerRef){
      const list = await rows(CRED);
      if(providerRef == null) return list;
      return list.find(c => String(c.provider_ref) === String(providerRef)) || null;
    },
    async saveCredentialing(rec){
      try{
        if(rec.id === undefined || rec.id === null || rec.id === '') delete rec.id;
        if(!rec.provider_ref) return { error:'A provider is required' };
        const me = getSession();
        if(!rec.id){
          rec.created_at = new Date().toISOString();
          rec.created_by = me ? me.username : 'system';
          rec.enrollments = rec.enrollments || [];
          rec.log = rec.log || [];
        }
        rec.updated_at = new Date().toISOString();
        const id = await save_(CRED, rec);
        return { ok:true, id: rec.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async logCredentialing(providerRef, what, detail){
      const rec = await this.credentialing(providerRef);
      if(!rec) return { error:'Not found' };
      const me = getSession();
      rec.log = [{ at:new Date().toISOString(), by: me ? (me.name||me.username) : 'system',
                   what, detail: detail || '' }].concat(rec.log || []);
      await save_(CRED, rec);
      return { ok:true };
    },
    /* create an empty record from the provider's own file the first time */
    async ensureCredentialing(provider){
      let rec = await this.credentialing(provider.id);
      if(rec) return rec;
      const r = await this.saveCredentialing({
        provider_ref: provider.id,
        org_id: provider.org_id || null,
        caqh_id: provider.caqh || '',
        npi: provider.npi || '',
        license_no: provider.license || '',
        license_state: provider.state || '',
        dea: provider.dea || '',
        taxonomy: provider.taxonomy || '',
        enrollments: [], log: []
      });
      return await this.credentialing(provider.id);
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
