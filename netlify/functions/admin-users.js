/* Account management. Creates the logins the front end signs in with.
   Reachable by a site-owner admin (unrestricted), an org Administrator
   (their own organization, never a Provider/Billing account), or a
   Practice Manager (their own organization, Provider/Billing accounts
   only) — see the handler below for exactly what each may do. */
const crypto = require('crypto');
const L = require('./_lib');

const ROLES = ['admin','supervisor','provider','scheduler','employee'];

function tempPassword(){
  const A='ABCDEFGHJKMNPQRSTUVWXYZ', a='abcdefghijkmnpqrstuvwxyz', n='23456789', s='!#$%&*+?';
  const pick = set => set[crypto.randomInt(set.length)];
  let out = [pick(A),pick(A),pick(a),pick(a),pick(a),pick(n),pick(n),pick(n),pick(s),pick(s)];
  for(let i=out.length-1;i>0;i--){ const j=crypto.randomInt(i+1); [out[i],out[j]]=[out[j],out[i]]; }
  return out.join('');
}
const initialsOf = n => String(n||'').replace(/^Dr\.?\s+/i,'')
  .split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();

/* Three kinds of caller reach this file now:
   - a "site owner" admin (role 'admin', no org_id) — the one login that isn't
     tied to any single practice, used only to set up a new organization and
     its first Practice Manager/Administrator. Unrestricted, as 'admin' has
     always been here.
   - an org Administrator (role 'admin', org_id set) — everything a site
     owner can do, but only within their own organization, and never able to
     create or manage a Provider or Billing/Scheduler account. That is a
     Practice Manager's job now.
   - a Practice Manager (role 'supervisor') — full run of their own
     organization's Provider and Billing/Scheduler accounts (create, edit,
     reset password, disable), but cannot create another Administrator or
     Practice Manager. */
const ADMIN_CREATABLE = ['admin','supervisor'];       /* what an org Administrator may create */
const PM_CREATABLE    = ['provider','employee','scheduler']; /* what a Practice Manager may create */

exports.handler = async (event) => {
  const me = await L.session(event);
  if(!me) return L.J(401, { error:'Not signed in' });

  const isSiteOwner  = me.role === 'admin' && (me.org_id == null || me.org_id === '');
  const isOrgAdmin   = me.role === 'admin' && !isSiteOwner;
  const isSupervisor = me.role === 'supervisor';
  const myOrgId = me.org_id != null && me.org_id !== '' ? Number(me.org_id) : null;

  const url = new URL(event.rawUrl || `https://x${event.path}`);
  const action = (url.searchParams.get('action') || 'list').toLowerCase();

  /* Everyone signed in may read the roster for their own organization's
     Teams page (a Provider or Billing/Scheduler account only ever sees
     "view schedule & teams", never account management) — every other
     action here is create/edit/reset/delete and stays limited to a
     site-owner admin, an org Administrator, or a Practice Manager. */
  if(action !== 'list' && !isSiteOwner && !isOrgAdmin && !isSupervisor)
    return L.J(403, { error:'Administrator or practice manager access required' });
  if(action === 'list' && !isSiteOwner && !isOrgAdmin && !isSupervisor && myOrgId == null)
    return L.J(403, { error:'No organization is linked to your account' });
  /* the roles this caller may CREATE a target account as. A Provider or
     Billing/Scheduler login is only ever created by a Practice Manager —
     that is true for a site-owner admin exactly as it is for an org
     Administrator, so both share the same, narrower, creatable list; the
     site owner's only real difference from an org Administrator is that it
     isn't confined to one organization (see orgId below). */
  const creatable = isSupervisor ? PM_CREATABLE : ADMIN_CREATABLE;
  /* the roles this caller may otherwise MANAGE (edit, disable, reset a
     password, delete) once the account already exists — wider than
     creatable for any Administrator, since "cannot add a Provider or
     Biller" is only about creating one, not about the ordinary running of
     an organization's existing accounts. A Practice Manager's reach never
     includes another Administrator's or Practice Manager's own login. */
  const manageable = isSupervisor ? PM_CREATABLE : ROLES;

  const sql = L.db();
  let b = {};
  if(event.body){ try{ b = JSON.parse(event.body); }catch{} }

  /* fetch a target account and, unless this caller is the site owner,
     refuse anything outside their own organization or role reach */
  async function scopedTarget(id, forWrite){
    const [row] = await sql`SELECT id,username,role,org_id,status FROM accounts WHERE id=${id}`;
    if(!row) return { error: L.J(404, { error:'Not found' }) };
    if(!isSiteOwner){
      if(row.org_id == null || Number(row.org_id) !== myOrgId)
        return { error: L.J(403, { error:'That account is not in your organization' }) };
      if(forWrite && !manageable.includes(row.role))
        return { error: L.J(403, { error:'Your role may not manage a ' + row.role + ' account' }) };
    }
    return { row };
  }

  try{
    /* ── list ── */
    if(action === 'list'){
      const rows = isSiteOwner
        ? await sql`
            SELECT id,username,email,phone,role,full_name,title,initials,provider_id,
                   provider_ref,org_id,scope,access,
                   status,mfa_enabled,must_change,last_login,created_by,created_at
            FROM accounts ORDER BY role, full_name`
        : await sql`
            SELECT id,username,email,phone,role,full_name,title,initials,provider_id,
                   provider_ref,org_id,scope,access,
                   status,mfa_enabled,must_change,last_login,created_by,created_at
            FROM accounts WHERE org_id=${myOrgId} ORDER BY role, full_name`;
      return L.J(200, { accounts: rows });
    }

    /* ── create ── */
    if(action === 'create'){
      const { username, full_name, role } = b;
      if(!username || !full_name || !role)
        return L.J(400, { error:'Username, full name and role are required' });
      if(!ROLES.includes(role)) return L.J(400, { error:'Unknown role' });
      if(!creatable.includes(role))
        return L.J(403, { error: isSupervisor
          ? 'A practice manager may add providers, billing and front-office staff, not a ' + role + ' account.'
          : 'An administrator may add a practice manager or another administrator, not a ' + role + ' account.' });
      if(!/^[a-z0-9._-]{3,40}$/i.test(username))
        return L.J(400, { error:'Username may use letters, numbers, dot, dash and underscore only' });

      const [dupe] = await sql`SELECT id FROM accounts WHERE LOWER(username)=LOWER(${username}) LIMIT 1`;
      if(dupe) return L.J(409, { error:'That username is already taken' });

      /* an org Administrator or Practice Manager can only ever place a new
         account under their own organization — a client-supplied org_id is
         ignored for them, exactly as it is for a team-member request */
      const orgId = isSiteOwner
        ? (b.org_id != null && b.org_id !== '' ? Number(b.org_id) : null)
        : myOrgId;
      if(!isSiteOwner && !orgId)
        return L.J(400, { error:'No organization is linked to your account' });

      const pw = b.password || tempPassword();
      const secret = b.mfa_enabled ? L.randomSecret() : null;

      const [row] = await sql`
        INSERT INTO accounts (username,email,phone,password_hash,role,full_name,title,initials,
                              provider_id,provider_ref,org_id,scope,mfa_enabled,mfa_secret,
                              must_change,created_by,access)
        VALUES (${username.toLowerCase()},${b.email||null},${b.phone||null},${L.hashPassword(pw)},
                ${role},${full_name},${b.title||null},${b.initials||initialsOf(full_name)},
                ${b.provider_id||null},
                ${b.provider_ref != null && b.provider_ref !== '' ? Number(b.provider_ref) : null},
                ${orgId},
                ${b.scope||(role==='admin'?'all':role==='provider'?'self':'facility')},
                ${!!b.mfa_enabled},${secret},${b.must_change !== false},${me.username},
                ${b.access ? sql.json(b.access) : null})
        RETURNING id,username,role,full_name,provider_ref,org_id`;

      await L.audit(event,{ actor_id:me.id, actor:me.username, action:'create_account',
        entity:'account', entity_id:row.id, detail:{ role } });
      return L.J(201, {
        ok: true,
        account: row,
        tempPassword: b.password ? null : pw,   // shown once, never stored in the clear
        mfa: secret ? { secret, otpauth: L.otpauth(username, secret) } : null
      });
    }

    /* ── update ── */
    if(action === 'update'){
      const { id } = b;
      if(!id) return L.J(400, { error:'id is required' });
      const scoped = await scopedTarget(id, true);
      if(scoped.error) return scoped.error;
      /* Saving an account's existing role back unchanged (the normal case —
         editing contact details, or flipping active/disabled) is never
         blocked here; only an actual role CHANGE is held to the same
         creatable list a fresh account of that role would need, so e.g. a
         practice manager can't use "edit" to promote a hire to
         administrator. */
      if(b.role != null && b.role !== '' && b.role !== scoped.row.role && !creatable.includes(b.role))
        return L.J(403, { error:'Your role may not assign the ' + b.role + ' role' });
      const [row] = await sql`
        UPDATE accounts SET
          email       = COALESCE(${b.email ?? null}, email),
          phone       = COALESCE(${b.phone ?? null}, phone),
          role        = COALESCE(${b.role || null}, role),
          full_name   = COALESCE(${b.full_name ?? null}, full_name),
          title       = COALESCE(${b.title ?? null}, title),
          initials    = COALESCE(${b.initials ?? null}, initials),
          provider_id = COALESCE(${b.provider_id ?? null}, provider_id),
          provider_ref = COALESCE(${b.provider_ref != null && b.provider_ref !== '' ? Number(b.provider_ref) : null}, provider_ref),
          org_id      = COALESCE(${isSiteOwner && b.org_id != null && b.org_id !== '' ? Number(b.org_id) : null}, org_id),
          scope       = COALESCE(${b.scope ?? null}, scope),
          status      = COALESCE(${b.status ?? null}, status),
          access      = COALESCE(${b.access ? sql.json(b.access) : null}, access),
          updated_at  = NOW()
        WHERE id=${id} RETURNING id,username,role,status,provider_ref,org_id`;
      await L.audit(event,{ actor_id:me.id, actor:me.username, action:'update_account',
        entity:'account', entity_id:row?.id, detail:b });
      return L.J(200, { ok: true, account: row });
    }

    /* ── reset a password on the user's behalf ── */
    if(action === 'reset-password'){
      const { id } = b;
      if(!id) return L.J(400, { error:'id is required' });
      const scoped = await scopedTarget(id, true);
      if(scoped.error) return scoped.error;
      const pw = b.password || tempPassword();
      const [row] = await sql`
        UPDATE accounts SET password_hash=${L.hashPassword(pw)}, must_change=TRUE,
               failed_attempts=0, locked_until=NULL, updated_at=NOW()
        WHERE id=${id} RETURNING username`;
      await L.audit(event,{ actor_id:me.id, actor:me.username, action:'reset_password',
        entity:'account', entity_id:id });
      return L.J(200, { ok:true, tempPassword: pw, username: row?.username });
    }

    /* ── turn MFA on / off ── */
    if(action === 'mfa'){
      const { id, enable } = b;
      if(!id) return L.J(400, { error:'id is required' });
      const scoped = await scopedTarget(id, true);
      if(scoped.error) return scoped.error;
      if(enable){
        const secret = L.randomSecret();
        const [row] = await sql`UPDATE accounts SET mfa_secret=${secret}, mfa_enabled=FALSE
                                WHERE id=${id} RETURNING username`;
        await L.audit(event,{ actor_id:me.id, actor:me.username, action:'mfa_reset',
          entity:'account', entity_id:id });
        return L.J(200, { ok:true, secret, otpauth: L.otpauth(row.username, secret),
                          note:'The user completes enrolment at their next sign-in.' });
      }
      const [row] = await sql`UPDATE accounts SET mfa_enabled=FALSE, mfa_secret=NULL
                              WHERE id=${id} RETURNING username`;
      await L.audit(event,{ actor_id:me.id, actor:me.username, action:'mfa_disable',
        entity:'account', entity_id:id });
      return L.J(200, { ok:true });
    }

    /* ── unlock after failed attempts ── */
    if(action === 'unlock'){
      const scoped = await scopedTarget(b.id, true);
      if(scoped.error) return scoped.error;
      const [row] = await sql`UPDATE accounts SET failed_attempts=0, locked_until=NULL
                              WHERE id=${b.id} RETURNING username`;
      await L.audit(event,{ actor_id:me.id, actor:me.username, action:'unlock',
        entity:'account', entity_id:b.id });
      return L.J(200, { ok:true });
    }

    /* ── delete ── */
    if(action === 'delete'){
      const { id } = b;
      const scoped = await scopedTarget(id, true);
      if(scoped.error) return scoped.error;
      const target = scoped.row;
      if(target.username === me.username) return L.J(400, { error:'You cannot delete your own account' });
      if(target.role === 'admin'){
        const [{count}] = await sql`SELECT COUNT(*)::int FROM accounts WHERE role='admin' AND status='active'`;
        if(count <= 1) return L.J(400, { error:'This is the last active administrator' });
      }
      await sql`DELETE FROM accounts WHERE id=${id}`;
      await L.audit(event,{ actor_id:me.id, actor:me.username, action:'delete_account',
        entity:'account', entity_id:id });
      return L.J(200, { ok:true });
    }

    /* ── login hours, for the Track Hours tile ── */
    if(action === 'hours'){
      const days = Math.min(90, parseInt(url.searchParams.get('days')||'30',10));
      const rows = isSiteOwner
        ? await sql`
            SELECT a.id, a.username, a.full_name, a.role, a.last_login,
                   COUNT(*) FILTER (WHERE e.event='login')  AS logins,
                   COUNT(*) FILTER (WHERE e.event='failed') AS failures,
                   MIN(e.at) AS first_seen, MAX(e.at) AS last_seen
            FROM accounts a
            LEFT JOIN login_events e ON e.account_id=a.id AND e.at > NOW() - (${days} || ' days')::interval
            GROUP BY a.id ORDER BY a.full_name`
        : await sql`
            SELECT a.id, a.username, a.full_name, a.role, a.last_login,
                   COUNT(*) FILTER (WHERE e.event='login')  AS logins,
                   COUNT(*) FILTER (WHERE e.event='failed') AS failures,
                   MIN(e.at) AS first_seen, MAX(e.at) AS last_seen
            FROM accounts a
            LEFT JOIN login_events e ON e.account_id=a.id AND e.at > NOW() - (${days} || ' days')::interval
            WHERE a.org_id=${myOrgId}
            GROUP BY a.id ORDER BY a.full_name`;
      return L.J(200, { days, rows });
    }

    /* ── recent audit — the site owner only, since entries aren't tagged
       by organization and an org-scoped caller has no way to be shown only
       their own practice's history ── */
    if(action === 'audit'){
      if(!isSiteOwner) return L.J(403, { error:'Administrator access required' });
      const rows = await sql`SELECT * FROM account_audit ORDER BY at DESC LIMIT 100`;
      return L.J(200, { rows });
    }

    return L.J(400, { error:'Unknown action' });

  }catch(err){
    return L.J(500, { error:'server', message:String(err.message||err) });
  }
};
