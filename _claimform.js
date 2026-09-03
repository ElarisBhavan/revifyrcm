/* ═══════════════════════════════════════════════════════════════
   Shared 837P claim editor.

   RFClaimForm.open(claim, {
     title, subtitle, context:{provs, orgs, patient}, onSave(claim){}
   })

   The patient chart and the claims list both call this, so a claim is
   edited in one place and the two screens cannot drift apart.
   ═══════════════════════════════════════════════════════════════ */
(function(){

  /* A second <script> tag would otherwise re-run this and replace RFClaimForm
     with a fresh instance whose markup has not been built, so the editor would
     open empty. Bail out if we are already here. */
  if(window.RFClaimForm) return;

  var C = null;          /* the claim being edited */
  var OPTS = {};
  var SEC = 'payer';
  var BUILT = false;

  /* Set the moment "Edit claim" opens a filed claim back up (see applyLock()
     and the cfSave handler below) — a snapshot of everything except the
     submission-type fields that the edit itself changes, so Save can tell a
     real edit from a click that reopened the claim and closed it again
     without touching anything. */
  var EDIT_SNAPSHOT = null;
  function snapshotForEdit(){
    var copy = JSON.parse(JSON.stringify(C||{}));
    delete copy.frequency; delete copy.orig_ref;
    return JSON.stringify(copy);
  }

  var esc = function(v){
    return String(v==null?'':v).replace(/[&<>"]/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});
  };
  var money = function(n){ return '$'+(Math.round((+n||0)*100)/100).toFixed(2); };
  var num = function(v){ return Math.round((parseFloat(v)||0)*100)/100; };
  var $ = function(id){ return document.getElementById(id); };
  var LETTERS = 'ABCDEFGHIJKL'.split('');

  /* A single bad call while painting the form must not leave the rest of it
     unpainted, or fields locked from a step that never got to run. Each
     step here stands on its own; if one throws, the others still happen and
     the error still reaches the console (and _guard.js's banner) instead of
     silently blanking the editor. */
  function safe(fn, label){
    try{ return fn(); }
    catch(err){ console.error('ReviFlow claim form: '+label+' failed', err); return undefined; }
  }

  /* Matches a payer name against Admin → Payers as forgivingly as
     reasonable. A patient's insurance record and the payer list in Admin
     are typed by different people at different times, so a difference as
     small as an extra space or a trailing "Inc." should not be the reason
     the payer ID is left blank when a person looking at the screen can
     plainly see it is the same payer. */
  function normPayerName(s){
    return String(s||'').trim().toLowerCase().replace(/\s+/g,' ').replace(/[.,]/g,'');
  }
  function findPayer(nameOrId){
    if(!window.RFCodes || !RFCodes.payers) return null;
    var raw = String(nameOrId||'').trim();
    if(!raw) return null;
    var q = normPayerName(raw), qid = raw.toLowerCase();
    var list = RFCodes.payers();
    var hit = list.filter(function(p){
      return normPayerName(p.name) === q || String(p.payer_id||'').toLowerCase() === qid;
    })[0];
    if(!hit && q){
      /* one name contains the other, so "Aetna" still finds "Aetna Inc" */
      hit = list.filter(function(p){
        var pn = normPayerName(p.name);
        return pn && (pn.indexOf(q) > -1 || q.indexOf(pn) > -1);
      })[0];
    }
    return hit || null;
  }

  function fmtShort(d){
    if(!d) return '';
    var p = String(d).split('-');
    if(p.length<3) return d;
    return new Date(+p[0],(+p[1]||1)-1,+p[2]||1,12)
      .toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
  }

  /* ── markup, injected once ── */
  function build(){
    if(BUILT) return;
    BUILT = true;

    var scrim = document.createElement('div');
    scrim.className = 'cf-scrim';
    scrim.id = 'cfScrim';
    document.body.appendChild(scrim);

    var el = document.createElement('div');
    el.className = 'cf';
    el.id = 'cfRoot';
    el.setAttribute('role','dialog');
    el.setAttribute('aria-modal','true');
    el.innerHTML = HTML();
    document.body.appendChild(el);

    scrim.addEventListener('click', close);
    document.addEventListener('keydown', function(e){
      if(e.key==='Escape' && el.classList.contains('on')) close();
    });
    wire();
  }

  function HTML(){
    return ''+
    '<div class="cf-head">'+
      '<span class="cf-ic"><svg viewBox="0 0 24 24"><path d="M7 4h8l4 4v12a1 1 0 01-1 1H7a1 1 0 01-1-1V5a1 1 0 011-1z"/><path d="M9 13l2 2 4-5"/></svg></span>'+
      '<span class="cf-ttl"><h3 id="cfTitle">Create claim</h3><p id="cfSub">—</p></span>'+
      '<span class="cf-ref" id="cfRef" hidden></span>'+
      '<span class="cf-state" id="cfState">DRAFT</span>'+
      '<button class="cf-x" id="cfClose" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'+
    '</div>'+

    '<div class="cf-body" id="cfBody">'+
      '<div class="cf-lock" id="cfLockNote" hidden></div>'+

      build1500()+

      /* ── review: what the payer would object to ──
         Reached only when Save finds something to fix (see cfSave below) —
         there is no longer a manual Next/Back pair in the footer, so this
         link is the way out of it. */
      '<section class="cf-sec" data-sec="review" id="cfReview" hidden>'+
        '<button type="button" class="cf-back-link" id="cfBackToForm">'+
          '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>Back to form</button>'+
        '<div class="cf-issues" id="cf_issues"></div>'+
        '<div class="cf-preview" id="cf_preview"></div>'+
      '</section>'+

    '</div>'+

    '<div class="cf-foot">'+
      '<button class="cf-btn ghost" id="cfCancel">Cancel</button>'+
      '<span class="sp"></span>'+
      '<button class="cf-btn" id="cfPrint"><svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 19H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2"/><path d="M7 15h10v6H7z"/></svg>Print</button>'+
      '<button class="cf-btn" id="cfDownload" title="Download a filled CMS-1500 as a PDF"><svg viewBox="0 0 24 24"><path d="M12 3v13M7 12l5 5 5-5"/><path d="M4 20h16"/></svg>Download PDF</button>'+
      '<button class="cf-btn pri" id="cfSave"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>Save claim</button>'+
    '</div>';
  }

  /* ══════════════════════════════════════════════════════════════
     THE CMS-1500 VIEW
     Boxes carry the numbers the paper form uses, in the order it uses
     them. A payer rejection that says "box 24J is missing" then points
     at something findable instead of something to be translated.
     ══════════════════════════════════════════════════════════════ */

  function bx(n, title, body, opts){
    opts = opts || {};
    return '<div'+(opts.id?' id="'+opts.id+'"':'')+' class="bx'+(opts.span?' span'+opts.span:'')+
      (opts.muted?' muted':'')+'">'+
      '<div class="bxh">'+
        (n ? '<span class="bxn'+(opts.sub?' sub':'')+'">'+n+'</span>' : '')+
        '<h4>'+title+(opts.req?' <span class="req">*</span>':'')+'</h4>'+
        (opts.why?'<button type="button" class="why" title="'+esc(opts.why)+'">?</button>':'')+
      '</div>'+body+'</div>';
  }

  function fld(id, label, opts){
    opts = opts || {};
    var w = opts.w ? ' '+opts.w : '';
    var body;
    if(opts.options){
      body = '<select id="'+id+'">'+opts.options.map(function(o){
        return '<option value="'+esc(o[0])+'">'+esc(o[1])+'</option>'; }).join('')+'</select>';
    }else{
      body = '<input type="'+(opts.type||'text')+'" id="'+id+'"'+
        (opts.ph?' placeholder="'+esc(opts.ph)+'"':'')+
        (opts.mono?' class="mono"':'')+
        (opts.max?' maxlength="'+opts.max+'"':'')+
        (opts.type==='date'?' min="1900-01-01" max="2100-12-31"':'')+'>';
    }
    return '<div class="bxf'+w+'">'+
      (label?'<label for="'+id+'">'+label+(opts.req?' <span class="req">*</span>':'')+'</label>':'')+
      body+
      (opts.hint?'<span class="fh" id="'+id+'_h">'+esc(opts.hint)+'</span>':'')+
      '</div>';
  }

  function row(){ return '<div class="bxr">'+[].slice.call(arguments).join('')+'</div>'; }

  function radios(name, list, opts){
    opts = opts || {};
    return '<div class="opts">'+list.map(function(o){
      return '<label class="opt"><input type="radio" name="'+name+'" value="'+esc(o[0])+'">'+
        '<i></i>'+esc(o[1])+'</label>'; }).join('')+'</div>';
  }

  /* independent checkboxes — unlike radios(), each one is its own field
     rather than mutually exclusive options in a group */
  function checks(list){
    return '<div class="opts">'+list.map(function(o){
      return '<label class="chk"><input type="checkbox" id="'+o[0]+'">'+
        '<i></i>'+esc(o[1])+'</label>'; }).join('')+'</div>';
  }

  var SEX=[['','—'],['M','Male'],['F','Female'],['U','Unknown']];
  var STATES=['','AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
    'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
    'NY','NC','ND','OH','OK','OR','PA','PR','RI','SC','SD','TN','TX','UT','VT','VA','WA',
    'WV','WI','WY'].map(function(x){ return [x, x||'—']; });

  var CUR = 'form';

  function build1500(){
    return '<div class="cf-1500"><div class="grid">'+

    /* ── how it goes, and to whom ── */
    bx('', 'Send', radios('cf_send',[['electronic','Electronically'],['paper','By mail']]),
       {span:1}) +
    bx('', 'Payer', row(
        fld('cf_payer','Payer name',{w:'w3',req:true,hint:'Start typing to fill the ID and address'}),
        fld('cf_payerid','Payer ID',{mono:true,req:true})
      ), {span:1}) +
    bx('', 'Claim identifier', checks([
        ['cf_id_chargeable','Chargeable'],
        ['cf_id_reporting','Reporting'],
        ['cf_id_subrogation','Subrogation']
      ]), {span:1}) +

    /* ── 1 to 13 ── */
    bx('1','Insurance type',
       radios('cf_instype',[['MB','Medicare'],['MC','Medicaid'],['CH','TRICARE'],
        ['CH2','CHAMPVA'],['WC','Workers comp, FECA, Black Lung'],['OT','Other']]),
       {span:2, why:'Which programme this claim goes to'}) +
    bx('1a','Insured ID number', row(
        fld('cf_resp','Payment responsibility',{w:'w2',req:true,options:[
          ['P','P — Primary'],['S','S — Secondary'],['T','T — Tertiary']]}),
        fld('cf_member','Member ID',{w:'w2',mono:true,req:true})
      )) +

    bx('2','Patient name', row(
        fld('cf_patlast','Last',{req:true}), fld('cf_patfirst','First',{req:true}),
        fld('cf_patmid','Middle',{sm:true})
      )) +
    bx('3','Patient date of birth, sex', row(
        fld('cf_patdob','Date of birth',{type:'date',req:true})
      )+'<div class="bxr"><div class="bxf full"><label>Sex</label>'+
        radios('cf_patsex',[['M','Male'],['F','Female'],['U','Unknown']])+'</div></div>') +
    bx('4','Insured name', row(
        fld('cf_sublast','Last'), fld('cf_subfirst','First')
      )+'<span class="fh" id="cf_subhint">Left blank when the patient is the subscriber</span>') +

    bx('5','Patient address',
        row(fld('cf_pataddr','Line 1',{w:'w3'}))+
        row(fld('cf_pataddr2','Line 2',{w:'w3'}))+
        row(fld('cf_patcity','City',{w:'w2'}),
            fld('cf_patstate','State',{sm:true,options:STATES}),
            fld('cf_patzip','ZIP',{sm:true,mono:true,max:10}))+
        row(fld('cf_patphone','Telephone (include area code)',{w:'w2',ph:'(312) 555-1212'}))) +
    bx('6','Patient relationship to insured',
        radios('cf_rel',[['18','Self'],['01','Spouse'],['19','Child'],['G8','Other']]),
        {req:true}) +
    bx('7','Insured address',
        row(fld('cf_subaddr','Line 1',{w:'w3'}))+
        row(fld('cf_subaddr2','Line 2',{w:'w3'}))+
        row(fld('cf_subcity','City',{w:'w2'}),
            fld('cf_substate','State',{sm:true,options:STATES}),
            fld('cf_subzip','ZIP',{sm:true,mono:true,max:10}))+
        row(fld('cf_subphone','Telephone (include area code)',{w:'w2',ph:'(312) 555-1212'}))) +

    bx('9',"Other insured's name",
        row(fld('cf_oi_last','Last',{}), fld('cf_oi_first','First',{}),
            fld('cf_oi_mid','Middle',{sm:true}))+
        row(fld('cf_oi_policy','a. Policy or group number',{w:'w3',mono:true}))+
        row(fld('cf_oi_plan','d. Insurance plan or programme name',{w:'w3'}))+
        '<span class="fh" id="cf_oiNote">Only needed when 11d is Yes.</span>',
        {id:'bx_oi'}) +
    bx('10','Is the condition related to',
        '<div class="bxr"><div class="bxf full"><label>a. Employment</label>'+
          radios('cf_rel_emp',[['Y','Yes'],['N','No']])+'</div></div>'+
        '<div class="bxr"><div class="bxf full"><label>b. Auto accident</label>'+
          radios('cf_rel_auto',[['Y','Yes'],['N','No']])+'</div>'+
          fld('cf_rel_autost','State',{sm:true,options:STATES})+'</div>'+
        '<div class="bxr"><div class="bxf full"><label>c. Other accident</label>'+
          radios('cf_rel_other',[['Y','Yes'],['N','No']])+'</div></div>') +
    bx('11','Insured policy group or FECA number',
        row(fld('cf_group','Group number',{w:'w3',mono:true}))+
        row(fld('cf_subdob','a. Insured date of birth',{type:'date'}),
            fld('cf_subsex','Sex',{sm:true,options:SEX}))+
        row(fld('cf_plan','c. Plan or programme name',{w:'w3'}))+
        '<div class="bxr"><div class="bxf full"><label>d. Another health benefit plan?</label>'+
          radios('cf_otherplan',[['Y','Yes'],['N','No']])+'</div></div>') +

    bx('12',"Patient or authorised person's signature",
        radios('cf_release',[['Y','Yes'],['I','Informed consent']])+
        '<span class="fh">I authorize the release of any medical or other information '+
        'necessary to process this claim. I also request payment of government benefits '+
        'either to myself or to the party who accepts assignment.</span>',
        {span:2, req:true}) +
    bx('13','Insured or authorised signature',
        radios('cf_assign',[['Y','Yes'],['N','No'],['NA','Not applicable']])+
        '<span class="fh">Authorises payment of benefits to the provider.</span>',
        {req:true}) +

    /* ── 14 to 23 ── */
    bx('14','Date of current illness, injury or pregnancy',
        row(fld('cf_ill_qual','Qualifier',{sm:true,options:[
          ['','—'],['431','431 — Onset'],['484','484 — Last menstrual period']]}),
          fld('cf_ill_date','Date',{type:'date',w:'w2'}))) +
    bx('15','Other date',
        row(fld('cf_oth_qual','Qualifier',{sm:true,options:[
          ['','—'],['454','454 — Initial treatment'],['304','304 — Latest visit'],
          ['453','453 — Acute manifestation'],['439','439 — Accident']]}),
          fld('cf_oth_date','Date',{type:'date',w:'w2'}))) +
    bx('16','Dates unable to work',
        row(fld('cf_work_from','From',{type:'date'}), fld('cf_work_to','To',{type:'date'}))) +

    bx('17','Name of referring provider',
        row(fld('cf_ref_qual','Qualifier',{sm:true,options:[
          ['','—'],['DN','DN — Referring'],['DK','DK — Ordering'],['DQ','DQ — Supervising']]}),
          fld('cf_referral','Name',{w:'w2'}))+
        row(fld('cf_ref_npi','17b. NPI',{mono:true,max:10,
          hint:'Ten digits'}))) +
    bx('18','Hospitalisation dates',
        row(fld('cf_adm','Admission',{type:'date'}), fld('cf_dis','Discharge',{type:'date'}))) +
    bx('20','Outside lab',
        '<div class="bxr"><div class="bxf full"><label>Was work done outside?</label>'+
          radios('cf_lab',[['Y','Yes'],['N','No']])+'</div></div>'+
        row(fld('cf_labchg','Charges',{mono:true,ph:'0.00'}))) +

    bx('19','Additional claim information',
        row(fld('cf_addl','Note',{w:'w3',ph:'Anything the payer has asked to be included'})),
        {span:2}) +
    bx('23','Prior authorisation number',
        row(fld('cf_auth','Number',{w:'w3',mono:true}))) +

    /* ── 21, the diagnoses ── */
    bx('21','Diagnosis or nature of illness or injury',
        '<div class="dxgrid" id="cf_dxgrid"></div>'+
        '<span class="fh">A is the primary diagnosis. Up to twelve, lettered A to L, '+
        'and each service line points at up to four of them.</span>',
        {span:2, req:true}) +
    bx('22','Resubmission',
        row(fld('cf_freq','Resubmission type',{w:'w2',options:[
              ['1','1 — Original claim'],['7','7 — Corrected claim'],['8','8 — Void claim']]}),
            fld('cf_origref','Original claim number',{w:'w2',mono:true,
              hint:'Only for a correction or void'}))) +

    /* ── 24, the service lines ── */
    bx('24','Service lines',
        '<div class="svc"><div class="svch">'+
          '<span></span><span>From *</span><span>To</span><span>Place *</span><span>EMG</span>'+
          '<span>CPT / HCPCS *</span><span>Modifiers</span><span>Pointers *</span>'+
          '<span>Charges *</span><span>Units *</span><span>Rendering NPI</span><span></span>'+
        '</div><div id="cf_svclines"></div>'+
        '<div class="svcadd">'+
          '<button type="button" class="cf-btn sec sm" id="cf_addline">'+
            '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Add service line</button>'+
          '<span class="svctot">Total <b id="cf_linetotal">$0.00</b></span>'+
        '</div></div>', {span:3, req:true}) +

    /* ── 25 to 29 ── */
    bx('25','Federal tax ID',
        row(fld('cf_taxid','Number',{w:'w2',mono:true,ph:'12-3456789'}))+
        '<div class="opts">'+
          '<label class="opt"><input type="radio" name="cf_taxkind" value="EIN"><i></i>EIN</label>'+
          '<label class="opt"><input type="radio" name="cf_taxkind" value="SSN"><i></i>SSN</label>'+
        '</div>', {req:true}) +
    bx('26','Patient account number',
        row(fld('cf_ctrl','Number',{w:'w3',mono:true,
          hint:'Yours. It comes back on the remittance, which is how a payment is matched.'})),
        {req:true}) +
    bx('27','Accept assignment',
        radios('cf_acceptassign',[['Y','Yes'],['C','Clinical lab only'],['N','No']]),
        {req:true}) +

    bx('28','Total charge',
        row(fld('cf_total','Total',{w:'w2',mono:true}))+
        '<span class="fh">Added up from the service lines</span>') +
    bx('29','Amount paid',
        row(fld('cf_paid','Paid',{w:'w2',mono:true,ph:'0.00',
          hint:'What the patient has already paid towards this claim'}))) +
    bx('','', '', {muted:true}) +

    /* ── 31 to 33 ── */
    bx('31','Signature of physician or supplier',
        '<span class="fh" style="margin-bottom:9px">I certify that the statements on the '+
        'reverse apply to this bill and are made a part of it.</span>'+
        radios('cf_sig',[['Y','Yes'],['N','No']])+
        row(fld('cf_provlast','Last',{req:true}), fld('cf_provfirst','First',{req:true}))+
        row(fld('cf_provnpi','Rendering NPI',{mono:true,max:10,req:true}),
            fld('cf_provtax','Taxonomy',{mono:true})),
        {req:true}) +

    bx('32','Service facility location',
        row(fld('cf_facname','Organisation name',{w:'w3'}))+
        row(fld('cf_facaddr','Line 1',{w:'w3'}))+
        row(fld('cf_faccity','City',{w:'w2'}),
            fld('cf_facstate','State',{sm:true,options:STATES}),
            fld('cf_faczip','ZIP',{sm:true,mono:true,max:10}))+
        row(fld('cf_facnpi','a. NPI',{mono:true,max:10}))) +

    bx('33','Billing provider info',
        row(fld('cf_orgname','Organisation name',{w:'w3',req:true}))+
        row(fld('cf_orgaddr','Line 1',{w:'w3',req:true}))+
        row(fld('cf_orgcity','City',{w:'w2',req:true}),
            fld('cf_orgstate','State',{sm:true,req:true,options:STATES}),
            fld('cf_orgzip','ZIP',{sm:true,mono:true,max:10,req:true}))+
        row(fld('cf_orgphone','Phone',{ph:'(312) 555-1212'}),
            fld('cf_orgnpi','a. NPI',{mono:true,max:10,req:true}))+
        row(fld('cf_taxonomy','Taxonomy',{mono:true}),
            fld('cf_submitter','Submitter name',{w:'w2'}))) +

    '</div></div>';
  }


  /* ── box 21: twelve diagnoses, lettered ── */
  var DXL='ABCDEFGHIJKL'.split('');

  function paintDx1500(){
    var grid=$('cf_dxgrid');
    if(!grid) return;
    var list=(C.dx&&C.dx.length)?C.dx.slice():[''];
    /* all twelve, A through L, are on screen from the start, laid out as
       their own rounded boxes, three across — the same "each field lives
       in its own bordered card" look box 24's service lines use, sized for
       a single code instead of a full row */
    var out='';
    for(var i=0;i<12;i++){
      var v=list[i]||'';
      var desc=(v&&window.RFCodes&&RFCodes.icdDesc)?RFCodes.icdDesc(v):'';
      out+='<div class="dxc'+(i===0?' primary':'')+'">'+
        '<div class="dxc-top">'+
          '<span class="dxn" title="'+(i===0?'Primary diagnosis':'Diagnosis '+DXL[i])+'">'+DXL[i]+'</span>'+
          '<input type="text" data-dx="'+i+'" value="'+esc(v)+'" maxlength="8" autocomplete="off" '+
            'placeholder="'+(i===0?'F41.1':'—')+'">'+
        '</div>'+
        '<span class="desc'+(desc?'':' dx-blank')+'" title="'+esc(desc)+'">'+
          (desc?esc(desc):(i===0?'Primary diagnosis':'—'))+'</span>'+
        '<div class="dxlist-drop" data-dxdrop="'+i+'"></div>'+
      '</div>';
    }
    grid.innerHTML=out;
    if(typeof applyLock==='function') applyLock();
  }

  /* the dropdown that lists matching ICD-10 codes under a box 21 field */
  function dxDropHTML(q){
    var matches = (window.RFCodes && RFCodes.findIcd) ? RFCodes.findIcd(q) : [];
    if(!matches.length) return '<div class="dxnone">No matching diagnosis codes</div>';
    return matches.slice(0,25).map(function(c){
      return '<button type="button" class="dxi" data-code="'+esc(c.code)+'">'+
        '<b>'+esc(c.code)+'</b><span>'+esc(c.desc||'')+'</span></button>';
    }).join('');
  }
  function openDxDrop(input){
    var wrap = input.closest('.dxc');
    var drop = wrap && wrap.querySelector('[data-dxdrop]');
    if(!drop) return;
    closeDxDrops();
    drop.innerHTML = dxDropHTML(input.value);
    drop.classList.add('on');
  }
  function closeDxDrops(){
    document.querySelectorAll('.dxlist-drop.on').forEach(function(d){ d.classList.remove('on'); });
  }

  /* ── box 24: the service lines ── */
  function paintLines1500(){
    var box=$('cf_svclines');
    if(!box) return;
    var lines=C.lines||[];

    box.innerHTML=lines.length
      ? lines.map(function(l,i){
          return '<div class="svcr">'+
            '<span class="svcn">'+(i+1)+'</span>'+
            '<span data-l="From"><input type="date" data-ln="'+i+'" data-f="from" '+
              'value="'+esc(l.from||l.dos||C.dos||'')+'" min="1900-01-01" max="2100-12-31"></span>'+
            '<span data-l="To"><input type="date" data-ln="'+i+'" data-f="to" '+
              'value="'+esc(l.to||l.from||l.dos||C.dos||'')+'" min="1900-01-01" max="2100-12-31"></span>'+
            '<span data-l="Place"><input type="text" data-ln="'+i+'" data-f="pos" '+
              'value="'+esc(l.pos||C.pos||'')+'" maxlength="2" placeholder="11"></span>'+
            '<span data-l="EMG"><input type="text" data-ln="'+i+'" data-f="emg" '+
              'value="'+esc(l.emg||'')+'" maxlength="1"></span>'+
            '<span data-l="CPT"><input type="text" data-ln="'+i+'" data-f="cpt" '+
              'value="'+esc(l.cpt||'')+'" maxlength="5" placeholder="90834"></span>'+
            '<span data-l="Modifiers"><input type="text" data-ln="'+i+'" data-f="mods" '+
              'value="'+esc([l.mod,l.mod2].filter(Boolean).join(' '))+'" placeholder="95 GT"></span>'+
            '<span data-l="Pointers"><div class="ptrgrid">'+
              DXL.map(function(L,k){
                var p=String(k+1), on=(l.dxptrs||[]).indexOf(p)>-1, code=(C.dx||[])[k]||'';
                var ttl=code ? (L+' — '+code+((window.RFCodes&&RFCodes.icdDesc&&RFCodes.icdDesc(code))?' '+RFCodes.icdDesc(code):''))
                             : (L+' — no diagnosis in this slot');
                return '<label class="ptrchk" title="'+esc(ttl)+'">'+
                  '<input type="checkbox" data-ln="'+i+'" data-f="dxptr" data-p="'+p+'"'+(on?' checked':'')+'>'+
                  '<i></i><b>'+L+'</b></label>';
              }).join('')+
            '</div></span>'+
            '<span data-l="Charges"><input type="text" class="chg" data-ln="'+i+'" data-f="charge" '+
              'value="'+(l.charge!=null?(+l.charge).toFixed(2):'')+'" placeholder="0.00"></span>'+
            '<span data-l="Units"><input type="text" data-ln="'+i+'" data-f="units" '+
              'value="'+esc(l.units||1)+'" maxlength="3"></span>'+
            '<span data-l="Rendering NPI"><input type="text" data-ln="'+i+'" data-f="npi" '+
              'value="'+esc(l.npi||'')+'" maxlength="10" placeholder="'+esc(C.provider_npi||'')+'"></span>'+
            '<span><button type="button" class="cf-rm" data-rmline="'+i+'" '+
              'aria-label="Remove line '+(i+1)+'">'+
              '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>'+
          '</div>';
        }).join('')
      : '<div class="svcr" style="grid-template-columns:1fr"><span style="padding:14px 0;'+
        'color:var(--dim,#8A9A97);font-size:12.4px;text-align:center">'+
        'No service lines yet. A claim needs at least one.</span></div>';

    var total=lines.reduce(function(a,l){ return a+(+l.charge||0)*(+l.units||1); },0);
    C.total=Math.round(total*100)/100;
    $('cf_linetotal').textContent=money(C.total);
    var t=$('cf_total'); if(t) t.value=(+C.total).toFixed(2);
    if(typeof applyLock==='function') applyLock();
  }

  /* ── reading the boxes back ── */
  function read1500(){
    var grid=$('cf_dxgrid');
    if(grid){
      var dx=[];
      grid.querySelectorAll('[data-dx]').forEach(function(el){
        dx[+el.dataset.dx]=el.value.trim().toUpperCase();
      });
      C.dx=dx.filter(function(v,i){ return v || i===0; });
    }

    var box=$('cf_svclines');
    if(box){
      box.querySelectorAll('[data-ln]').forEach(function(el){
        var l=C.lines[+el.dataset.ln];
        if(!l) return;
        var f=el.dataset.f, v=el.value;
        if(f==='dxptr'){
          /* a checkbox per line/letter, gathered in the pass below rather
             than read one at a time here */
          return;
        }else if(f==='mods'){
          var m=v.toUpperCase().split(/[\s,]+/).filter(Boolean);
          l.mod=m[0]||''; l.mod2=m[1]||'';
        }else if(f==='charge'){
          l.charge=Math.round((parseFloat(v)||0)*100)/100;
        }else if(f==='units'){
          l.units=Math.max(1, parseInt(v,10)||1);
        }else if(f==='from'){
          l.from=v; l.dos=v;
        }else if(f==='to'){
          l.to=v;
        }else if(f==='cpt'||f==='pos'||f==='emg'){
          l[f]=v.trim().toUpperCase();
        }else{
          l[f]=v.trim();
        }
      });

      /* box 24's pointers are now checkboxes, up to L, one group per line */
      (C.lines||[]).forEach(function(l,i){
        var ptrs=box.querySelectorAll('[data-f="dxptr"][data-ln="'+i+'"]');
        if(!ptrs.length) return;
        l.dxptrs = Array.prototype.slice.call(ptrs)
          .filter(function(cb){ return cb.checked; })
          .map(function(cb){ return cb.dataset.p; });
      });
    }
  }


  /* ══════════════════════════════════════════════════════════════
     DOWNLOAD — a filled CMS-1500, as its own PDF
     Stedi (and any other clearinghouse) prints a CMS-1500 from the 837
     it is sent, and by X12 convention that omits the whole patient loop
     — box 3, 4 and 5 with it — whenever the patient IS the insured,
     because that loop is genuinely redundant on the wire. That is
     correct EDI, but it is a paper form with blank boxes on it, and this
     is the one place ReviFlow controls the rendering end to end. So this
     PDF always fills box 3/4/5 — mirroring the subscriber when the
     patient is the same person — instead of leaving them blank the way
     an omitted loop would.
     One page, laid out in the same box groups the on-screen review
     uses, numbered the way the paper form numbers them, so a payer
     rejection that names a box points at something on this PDF too. */

  function pdfUp(v){ return String(v==null?'':v).trim().toUpperCase(); }
  function pdfName(last,first,mid){
    var n=[pdfUp(last),pdfUp(first)].filter(Boolean).join(' ');
    return mid?(n+' '+pdfUp(mid).charAt(0)):n;
  }
  /* the patient loop is skipped on the wire when self, but a downloaded
     paper form reads better filled in than blank — mirror the
     subscriber's own answer whenever the patient's own field is empty
     and the patient IS the subscriber */
  function pdfMirror(own, subVal, isSelf){
    var v = String(own==null?'':own).trim();
    if(v) return v;
    return isSelf ? String(subVal==null?'':subVal).trim() : '';
  }
  function pdfAddrLines(line1,line2,city,state,zip){
    var l2 = [line1,line2].filter(Boolean).join(', ');
    var l3 = [city,state,zip].filter(Boolean).join(', ').replace(/, ([A-Z]{2}), /,' $1 ');
    var out=[]; if(l2) out.push(l2); if(l3) out.push(l3);
    return out;
  }
  function pdfPhone(v){
    var d=String(v||'').replace(/\D/g,'');
    if(d.length===10) return '('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6);
    return v||'';
  }

  function downloadClaimPdf(c){
    var jl = window.jspdf;
    if(!jl || !jl.jsPDF){
      notify('Could not build the PDF','The PDF library did not load — try again in a moment');
      return;
    }
    var doc = new jl.jsPDF({unit:'pt',format:'letter'});
    var M=32, PW=612, RX=PW-M;
    var GREEN=[10,92,70], INK=[18,26,23], MUT=[110,118,114], LINE=[176,181,178];
    var y=M;

    /* ── shared drawing helpers ── */
    function setLine(){ doc.setDrawColor(LINE[0],LINE[1],LINE[2]); doc.setLineWidth(0.65); }
    function box(x,yy,w,h){ setLine(); doc.rect(x,yy,w,h); }
    function label(x,yy,n,text){
      doc.setFont('helvetica','bold'); doc.setFontSize(6.1);
      doc.setTextColor(MUT[0],MUT[1],MUT[2]);
      doc.text(((n?n+'. ':'')+text).toUpperCase(), x+4, yy+8);
    }
    function val(x,yy,w,text,opts){
      opts=opts||{};
      doc.setFont(opts.mono?'courier':'helvetica','normal');
      doc.setFontSize(opts.size||8.2);
      doc.setTextColor(INK[0],INK[1],INK[2]);
      var t = (text==null||text==='') ? '—' : String(text);
      var lines = doc.splitTextToSize(t, w-8);
      doc.text(lines.slice(0, opts.maxLines||2), x+4, yy+(opts.top||18));
    }
    function field(x,yy,w,h,n,lbl,text,opts){
      box(x,yy,w,h); label(x,yy,n,lbl); val(x,yy,w,text,opts);
    }
    /* a run of checkbox+label pairs, wrapping to a second line inside its
       own cell rather than overlapping the next one */
    function checkRow(x0,y0,maxX,items,checked){
      var x=x0, yy=y0, s=6, gap=5, lineH=10;
      items.forEach(function(it){
        var w = doc.getTextWidth(it[1])+s+3;
        if(x+w>maxX){ x=x0; yy+=lineH; }
        setLine(); doc.rect(x,yy-s+2,s,s);
        if(checked===it[0]){
          doc.setDrawColor(INK[0],INK[1],INK[2]); doc.setLineWidth(0.9);
          doc.line(x+1,yy-s+3,x+s-1,yy+1); doc.line(x+1,yy+1,x+s-1,yy-s+3);
        }
        doc.setFont('helvetica','normal'); doc.setFontSize(6.4);
        doc.setTextColor(INK[0],INK[1],INK[2]);
        doc.text(it[1], x+s+3, yy);
        x += w+gap;
      });
      return yy+lineH;
    }

    var isSelf = String(c.relationship||'18')==='18';
    var patLast=pdfUp(c.patient_last), patFirst=pdfUp(c.patient_first);
    var subLast=pdfMirror(c.sub_last, c.patient_last, isSelf) || (isSelf?patLast:'');
    var subFirst=pdfMirror(c.sub_first, c.patient_first, isSelf) || (isSelf?patFirst:'');
    var patDob=pdfMirror(c.patient_dob, c.sub_dob, isSelf);
    var patSex=pdfMirror(c.patient_sex, c.sub_sex, isSelf);
    var patAddrLine=pdfMirror(c.pat_addr, c.sub_addr, isSelf);
    var patCity=pdfMirror(c.pat_city, c.sub_city, isSelf);
    var patState=pdfMirror(c.pat_state, c.sub_state, isSelf);
    var patZip=pdfMirror(c.pat_zip, c.sub_zip, isSelf);
    var patPhone=pdfMirror(c.pat_phone, c.sub_phone, isSelf);
    var subAddrLine=pdfMirror(c.sub_addr, c.pat_addr, isSelf);
    var subCity=pdfMirror(c.sub_city, c.pat_city, isSelf);
    var subState=pdfMirror(c.sub_state, c.pat_state, isSelf);
    var subZip=pdfMirror(c.sub_zip, c.pat_zip, isSelf);
    var subPhone=pdfMirror(c.sub_phone, c.pat_phone, isSelf);
    var subDob=pdfMirror(c.sub_dob, c.patient_dob, isSelf);
    var subSex=pdfMirror(c.sub_sex, c.patient_sex, isSelf);

    /* ── header ── */
    doc.setFont('helvetica','bold'); doc.setFontSize(15);
    doc.setTextColor(GREEN[0],GREEN[1],GREEN[2]);
    doc.text('HEALTH INSURANCE CLAIM FORM', M, y+12);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.4);
    doc.setTextColor(MUT[0],MUT[1],MUT[2]);
    doc.text('APPROVED BY NATIONAL UNIFORM CLAIM COMMITTEE (NUCC) 02/12', M, y+23);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.6);
    doc.setTextColor(INK[0],INK[1],INK[2]);
    doc.text('CMS-1500 · '+(c.claim_no||'DRAFT'), RX, y+11, {align:'right'});
    doc.setFont('helvetica','normal'); doc.setFontSize(7.4);
    doc.setTextColor(MUT[0],MUT[1],MUT[2]);
    doc.text('Downloaded '+new Date().toLocaleDateString(), RX, y+22, {align:'right'});
    doc.setDrawColor(GREEN[0],GREEN[1],GREEN[2]); doc.setLineWidth(1.3);
    doc.line(M,y+30,RX,y+30);
    y += 40;

    /* ── row: 1 programme · 1a insured ID ── */
    var h=32, wA=330;
    box(M,y,wA,h); label(M,y,'1','Insurance programme this claim is filed under');
    var KINDS=[['MB','MEDICARE'],['MC','MEDICAID'],['CH','TRICARE'],['CH2','CHAMPVA'],
      ['HM','GROUP HEALTH PLAN'],['WC','FECA / BLACK LUNG'],['OT','OTHER']];
    checkRow(M+4,y+18,M+wA-4,KINDS,c.insurance_type||'OT');
    field(M+wA,y,RX-(M+wA),h,'1a',"Insured's I.D. number",c.member_id,{mono:true});
    y+=h;

    /* ── row: 2 patient name · 3 birth date/sex · 4 insured name ── */
    h=30;
    var w2=(RX-M)/3;
    field(M,y,w2,h,'2','Patient name (Last, First)', pdfName(patLast,patFirst));
    field(M+w2,y,w2,h,'3',"Birth date · sex",
      (patDob?fmtShort(patDob):'—')+(patSex?'  ·  '+pdfUp(patSex):''));
    field(M+2*w2,y,RX-(M+2*w2),h,'4',"Insured's name (Last, First)", pdfName(subLast,subFirst));
    y+=h;

    /* ── row: 5 patient address · 6 relationship · 7 insured address ── */
    h=48;
    var w5=RX-M, colA=w5*0.42, colB=w5*0.16, colC=w5-colA-colB;
    box(M,y,colA,h); label(M,y,'5','Patient address');
    var pLines=pdfAddrLines(patAddrLine,'',patCity,patState,patZip);
    if(patPhone) pLines.push('Tel '+pdfPhone(patPhone));
    val(M,y,colA,pLines.join('\n'),{top:18,maxLines:3});
    box(M+colA,y,colB,h); label(M+colA,y,'6','Relationship');
    checkRow(M+colA+4,y+18,M+colA+colB-4,
      [['18','Self'],['01','Spouse'],['19','Child'],['G8','Other']], c.relationship||'18');
    box(M+colA+colB,y,colC,h); label(M+colA+colB,y,'7',"Insured's address");
    var sLines=pdfAddrLines(subAddrLine,'',subCity,subState,subZip);
    if(subPhone) sLines.push('Tel '+pdfPhone(subPhone));
    val(M+colA+colB,y,colC,sLines.join('\n'),{top:18,maxLines:3});
    y+=h;

    /* ── row: 11 policy group · 11a insured DOB/sex · 11c plan name ── */
    h=28;
    field(M,y,w2,h,'11','Insured policy or group number', c.group_id, {mono:true});
    field(M+w2,y,w2,h,'11a',"Insured's DOB · sex",
      (subDob?fmtShort(subDob):'—')+(subSex?'  ·  '+pdfUp(subSex):''));
    field(M+2*w2,y,RX-(M+2*w2),h,'11c','Insurance plan or programme name', c.payer);
    y+=h;

    /* ── row: 12 patient signature · 13 insured signature · 23 prior auth ── */
    h=26;
    var w3=(RX-M)/3;
    field(M,y,w3,h,'12',"Patient's signature", 'SIGNATURE ON FILE', {size:7.6});
    field(M+w3,y,w3,h,'13',"Insured's signature", 'SIGNATURE ON FILE', {size:7.6});
    field(M+2*w3,y,RX-(M+2*w3),h,'23','Prior authorization number', c.prior_auth, {mono:true});
    y+=h;

    /* ── row: 21 diagnosis · 26 patient account no. ── */
    var dx=(c.dx||[]).filter(Boolean);
    h=58;
    var wDx=RX-M-140;
    box(M,y,wDx,h); label(M,y,'21','Diagnosis or nature of illness or injury (ICD ind. 0)');
    (function(){
      doc.setFont('courier','normal'); doc.setFontSize(7.8);
      doc.setTextColor(INK[0],INK[1],INK[2]);
      var cols=2, perCol=6, colW=(wDx-8)/cols;
      dx.slice(0,12).forEach(function(code,i){
        var col=Math.floor(i/perCol), row=i%perCol;
        var xx=M+4+col*colW, yy=y+20+row*8.6;
        doc.text(String.fromCharCode(65+i)+'. '+pdfUp(code), xx, yy);
      });
      if(!dx.length){ doc.setTextColor(MUT[0],MUT[1],MUT[2]); doc.text('—', M+4, y+20); }
    })();
    field(M+wDx,y,RX-(M+wDx),h,'26','Patient account number', c.control, {mono:true,size:7.6});
    y+=h;

    /* ── 24: the service lines ── */
    var lines=c.lines||[];
    var cols=[
      {t:'24A. DATES OF SERVICE', w:0.17},{t:'24B. POS', w:0.06},
      {t:'24D. CPT/HCPCS · MOD', w:0.20},{t:'24E. DX', w:0.08},
      {t:'24F. CHARGES', w:0.13},{t:'24G. UNITS', w:0.08},
      {t:'24I / 24J. RENDERING ID · NPI', w:0.28}
    ];
    var tW=RX-M, x=M, thH=16;
    doc.setFillColor(244,242,236);
    doc.rect(M,y,tW,thH,'F'); setLine(); doc.rect(M,y,tW,thH);
    doc.setFont('helvetica','bold'); doc.setFontSize(6);
    doc.setTextColor(MUT[0],MUT[1],MUT[2]);
    var cx=M;
    cols.forEach(function(cdef){
      doc.text(cdef.t, cx+3, y+10);
      cx += tW*cdef.w;
    });
    y+=thH;
    var rowH=17;
    (lines.length?lines:[null]).forEach(function(l){
      box(M,y,tW,rowH);
      var cx2=M;
      cols.forEach(function(cdef,ci){
        if(ci>0){ setLine(); doc.line(cx2,y,cx2,y+rowH); }
        cx2 += tW*cdef.w;
      });
      if(l){
        var dxPtrs=(Array.isArray(l.dxptrs)&&l.dxptrs.length?l.dxptrs:['1']);
        var dxTxt=dxPtrs.map(function(p){ return String.fromCharCode(64+(parseInt(p,10)||1)); }).join(',');
        var dateTxt=(l.from?fmtShort(l.from):(c.dos?fmtShort(c.dos):'—'))+
          ((l.to && l.to!==l.from) ? '–'+fmtShort(l.to) : '');
        var cptTxt=pdfUp(l.cpt)+([l.mod,l.mod2].filter(Boolean).length?' '+[l.mod,l.mod2].filter(Boolean).join(' '):'');
        var vals=[dateTxt, l.pos||c.pos||'11', cptTxt, dxTxt,
          money((+l.charge||0)*(+l.units||1)), String(l.units||1),
          (c.provider_npi?'NPI '+c.provider_npi:'—')];
        var cx3=M;
        doc.setFont('helvetica','normal'); doc.setFontSize(7.4);
        doc.setTextColor(INK[0],INK[1],INK[2]);
        cols.forEach(function(cdef,ci){
          var w=tW*cdef.w;
          var lines2=doc.splitTextToSize(String(vals[ci]||'—'), w-6);
          doc.text(lines2.slice(0,2), cx3+3, y+10);
          cx3+=w;
        });
      }else{
        doc.setFont('helvetica','normal'); doc.setFontSize(7.6);
        doc.setTextColor(MUT[0],MUT[1],MUT[2]);
        doc.text('No service lines on this claim', M+6, y+11);
      }
      y+=rowH;
    });

    /* ── row: 25 tax id · 27 accept assignment · 28 total · 29 paid ── */
    h=30;
    var w4=(RX-M)/4;
    field(M,y,w4,h,'25','Federal tax I.D.', c.tax_id, {mono:true});
    box(M+w4,y,w4,h); label(M+w4,y,'27','Accept assignment');
    checkRow(M+w4+4,y+20,M+2*w4-4,[['Y','Yes'],['N','No']], c.accept_assignment==='N'?'N':'Y');
    field(M+2*w4,y,w4,h,'28','Total charge', money(c.total), {mono:true});
    field(M+3*w4,y,RX-(M+3*w4),h,'29','Amount paid', money(c.amount_paid||0), {mono:true});
    y+=h;

    /* ── row: 31 physician signature · 32 service facility · 33 billing provider ── */
    h=62;
    var w6=(RX-M)/3;
    box(M,y,w6,h); label(M,y,'31','Signature of physician or supplier');
    val(M,y,w6,[pdfName(c.prov_last,c.prov_first)||'—',
      (c.dos?fmtShort(c.dos):'')].filter(Boolean).join('\n'),{top:18});

    box(M+w6,y,w6,h); label(M+w6,y,'32','Service facility location');
    var facLines=[c.facility_name||c.org_name||'—']
      .concat(pdfAddrLines(c.facility_addr||c.org_addr,'',
        c.facility_city||c.org_city, c.facility_state||c.org_state, c.facility_zip||c.org_zip));
    facLines.push('a. NPI '+(c.facility_npi||c.org_npi||'—'));
    val(M+w6,y,w6,facLines.join('\n'),{top:16,size:7.4,maxLines:4});

    box(M+2*w6,y,RX-(M+2*w6),h); label(M+2*w6,y,'33','Billing provider info & phone');
    var billLines=[c.org_name||'—'];
    if(c.org_phone) billLines.push(pdfPhone(c.org_phone));
    billLines=billLines.concat(pdfAddrLines(c.org_addr,c.org_addr2,c.org_city,c.org_state,c.org_zip));
    billLines.push('a. NPI '+(c.org_npi||'—')+(c.taxonomy?'  b. '+c.taxonomy:''));
    val(M+2*w6,y,RX-(M+2*w6),billLines.join('\n'),{top:16,size:7.4,maxLines:5});
    y+=h;

    /* ── footer ── */
    y+=14;
    doc.setFont('helvetica','normal'); doc.setFontSize(6.8);
    doc.setTextColor(MUT[0],MUT[1],MUT[2]);
    doc.text('Generated by ReviFlow from the saved claim record, laid out to the NUCC CMS-1500 (02-12) '+
      'box numbering. This copy is for reference, printing or mailing — it is not itself the EDI '+
      'transaction filed with the payer. NUCC Instruction Manual: www.nucc.org', M, y, {maxWidth:RX-M});

    var last = (c.patient_last||'claim').replace(/[^a-z0-9]+/gi,'-').toLowerCase();
    var dos = (c.dos||'').replace(/[^0-9]/g,'') || 'draft';
    doc.save('cms1500-'+last+'-'+dos+'.pdf');
    notify('CMS-1500 downloaded','Every field on the saved claim is included, including patient and insured contact details');
  }


  window.RFClaimForm = {
    open: function(claim, opts){
      build();

      /* Accept the claim as the first argument. If it arrives wrapped in an
         options object instead, unwrap it rather than opening an empty form —
         a silent blank editor is far harder to diagnose than a warning. */
      if(claim && !claim.payer && !claim.lines && !claim.control && claim.claim){
        console.warn('RFClaimForm.open: the claim should be the first argument. '+
          'Unwrapping options.claim for now.');
        opts = Object.assign({}, claim, opts||{});
        claim = claim.claim;
      }
      if(!claim || typeof claim !== 'object'){
        console.error('RFClaimForm.open: no claim was supplied.');
        claim = {};
      }

      C = JSON.parse(JSON.stringify(claim || {}));
      OPTS = opts || {};
      EDIT_SNAPSHOT = null;
      C.dx = (C.dx && C.dx.length) ? C.dx : [''];
      C.lines = C.lines || [];
      C.send_method = C.send_method || 'electronic';
      C.frequency = C.frequency || '1';
      C.tax_kind = C.tax_kind || 'EIN';
      /* Sensible defaults for a fresh claim — only filled in when the field
         is genuinely unset, so an existing saved claim's own answers are
         never overridden. Box 10 (employment/auto/other accident) and box
         20 (outside lab) are "No" far more often than "Yes"; box 13
         (assignment of benefits) is "Yes" for the near-totality of claims,
         since that is what lets the payer pay the practice directly. */
      C.rel_employment = C.rel_employment || 'N';
      C.rel_auto = C.rel_auto || 'N';
      C.rel_other = C.rel_other || 'N';
      C.outside_lab = C.outside_lab || 'N';
      C.assignment = C.assignment || 'Y';
      /* box 27 (accept assignment) is a separate question from box 13, but
         it is answered "Yes" on the near-totality of claims for the same
         reason: it is what lets the payer pay the practice directly rather
         than reimbursing the patient. */
      C.accept_assignment = C.accept_assignment || 'Y';
      normaliseLines();
      fill();
      show(OPTS.section || ((C.rejections && C.rejections.length) ? 'review' : 'payer'));
      $('cfScrim').classList.add('on');
      $('cfRoot').classList.add('on');
      document.body.style.overflow = 'hidden';
    },
    close: close,
    claim: function(){ return C; },
    esc: esc, money: money
  };

  function close(){
    if(!BUILT) return;
    $('cfScrim').classList.remove('on');
    $('cfRoot').classList.remove('on');
    document.body.style.overflow = '';
    if(OPTS.onClose) OPTS.onClose();
  }

  /* ── a line carries up to four diagnosis pointers ── */
  function normaliseLines(){
    C.lines.forEach(function(l){
      if(!l.dxptrs || !l.dxptrs.length){
        /* migrate the single pointer older claims carry */
        l.dxptrs = l.dxptr ? [String(l.dxptr)] : ['1'];
      }
      l.dxptrs = l.dxptrs.map(String).filter(function(p){ return p && +p>0; }).slice(0,4);
      if(!l.dxptrs.length) l.dxptrs = ['1'];
      delete l.dxptr;
    });
  }

  /* radio groups, by the field each one sets */
  var RADIOS = {
    cf_send:'send_method', cf_instype:'insurance_type', cf_patsex:'patient_sex',
    cf_rel:'relationship', cf_release:'release', cf_assign:'assignment',
    cf_sig:'signature', cf_acceptassign:'accept_assignment', cf_taxkind:'tax_kind',
    cf_rel_emp:'rel_employment', cf_rel_auto:'rel_auto', cf_rel_other:'rel_other',
    cf_lab:'outside_lab', cf_otherplan:'other_plan'
  };

  /* independent checkboxes, each its own true/false field rather than a
     mutually exclusive group */
  var CHECKS = {
    cf_id_chargeable:'claim_chargeable',
    cf_id_reporting:'claim_reporting',
    cf_id_subrogation:'claim_subrogation'
  };

  var FIELDS = {
    cf_payer:'payer', cf_payerid:'payer_id', cf_payeraddr:'payer_address',
    cf_filing:'filing', cf_resp:'responsibility', cf_submitter:'submitter_name',
    cf_orgname:'org_name', cf_orgnpi:'org_npi', cf_taxid:'tax_id',
    cf_taxonomy:'taxonomy', cf_orgphone:'org_phone', cf_orgaddr:'org_addr',
    cf_orgcity:'org_city', cf_orgstate:'org_state', cf_orgzip:'org_zip',
    cf_provfirst:'prov_first', cf_provlast:'prov_last', cf_provnpi:'provider_npi',
    cf_provtax:'prov_taxonomy',
    cf_facname:'facility_name', cf_facnpi:'facility_npi', cf_facaddr:'facility_addr',
    cf_faccity:'facility_city', cf_facstate:'facility_state', cf_faczip:'facility_zip',
    cf_rel:'relationship', cf_member:'member_id', cf_group:'group_id',
    cf_subfirst:'sub_first', cf_sublast:'sub_last', cf_subdob:'sub_dob', cf_subsex:'sub_sex',
    cf_subaddr:'sub_addr', cf_subaddr2:'sub_addr2',
    cf_subcity:'sub_city', cf_substate:'sub_state', cf_subzip:'sub_zip',
    cf_patfirst:'patient_first', cf_patlast:'patient_last', cf_patdob:'patient_dob',
    cf_patsex:'patient_sex', cf_pataddr:'pat_addr', cf_pataddr2:'pat_addr2',
    cf_patcity:'pat_city', cf_patstate:'pat_state', cf_patzip:'pat_zip', cf_patphone:'pat_phone',
    cf_subphone:'sub_phone',
    cf_rel_autost:'rel_auto_state',
    cf_oi_last:'oi_last', cf_oi_first:'oi_first', cf_oi_mid:'oi_mid',
    cf_oi_policy:'oi_policy', cf_oi_plan:'oi_plan',
    cf_ctrl:'control', cf_pos:'pos', cf_dos:'dos', cf_freq:'frequency',
    cf_origref:'orig_ref', cf_auth:'prior_auth', cf_referral:'referral',
    cf_sig:'signature', cf_assign:'assignment', cf_release:'release',
    cf_addl:'addl_note'
  };

  function fill(){
    $('cfTitle').textContent = OPTS.title || (C.id ? (C.claim_no||'Claim') : 'Create claim');
    $('cfSub').textContent = OPTS.subtitle || '';

    var rn = C.stedi_claim_no || C.correlationId || '';
    var ref = $('cfRef');
    if(rn){
      ref.hidden = false;
      ref.innerHTML = '<span class="l">'+(C.status==='rejected'?'Rejection reference':'Payer claim number')+
        '</span><span class="v'+(C.status==='rejected'?' bad':'')+'">'+esc(rn)+'</span>';
    }else{ ref.hidden = true; }

    Object.keys(FIELDS).forEach(function(id){
      var el = $(id); if(el) el.value = C[FIELDS[id]] || '';
    });
    Object.keys(CHECKS).forEach(function(id){
      var el = $(id); if(el) el.checked = !!C[CHECKS[id]];
    });
    /* box 28 takes a plain figure, as the printed form does */
    if($('cf_total')) $('cf_total').value = (+(C.total||0)).toFixed(2);

    /* The payer name arrives already filled in — from the patient's policy
       when the claim is built from an encounter, or from a previously saved
       claim — but the matching Payer ID only used to fill in reactively,
       once the person typed into or left the Payer name field themselves.
       That meant a claim opened with the name already present kept an empty
       ID until someone re-triggered the field by hand. Doing the same
       lookup here, once, right after the name is on the page, fills it in
       immediately whenever the practice has that payer on file. */
    if($('cf_payer') && $('cf_payerid') && !String($('cf_payerid').value||'').trim()){
      var payerHit = findPayer($('cf_payer').value);
      if(payerHit && payerHit.payer_id){
        $('cf_payerid').value = payerHit.payer_id;
        C.payer_id = payerHit.payer_id;
      }
    }

    var payers = (window.RFCodes && RFCodes.payers) ? RFCodes.payers() : [];
    if($('cfPayerList')) $('cfPayerList').innerHTML = payers.map(function(p){
      return '<option value="'+esc(p.name)+'">'+esc(p.payer_id||'')+'</option>'; }).join('');

    /* box 1a: which responsibility levels make sense to offer depends on
       how many insurance policies the patient actually has on file. A
       patient with only a primary policy has no secondary or tertiary payer
       to coordinate benefits with, so those choices are just noise; once a
       second policy is on file, this claim is being filed after the
       primary, so it is Secondary or Tertiary that applies. */
    if($('cf_resp')){
      var patIns = OPTS.context && OPTS.context.patient && OPTS.context.patient.insurances;
      var respOpts = [['P','P — Primary'],['S','S — Secondary'],['T','T — Tertiary']];
      if(patIns && patIns.length){
        var ranks = patIns.map(function(i){ return String(i.rank||''); });
        var hasSecondary = ranks.indexOf('2') > -1 || ranks.indexOf('3') > -1;
        respOpts = hasSecondary
          ? [['S','S — Secondary'],['T','T — Tertiary']]
          : [['P','P — Primary']];
      }
      var curResp = C.responsibility || respOpts[0][0];
      $('cf_resp').innerHTML = respOpts.map(function(o){
        return '<option value="'+esc(o[0])+'">'+esc(o[1])+'</option>'; }).join('');
      var respOk = respOpts.some(function(o){ return o[0]===curResp; });
      $('cf_resp').value = respOk ? curResp : respOpts[0][0];
      if(!respOk) C.responsibility = respOpts[0][0];
    }

    /* Place of service now sits on each service line, where box 24B puts it,
       so the single dropdown is gone. */
    if($('cf_pos')){
      var pos = (window.RFCodes && RFCodes.posList) ? RFCodes.posList() : [];
      $('cf_pos').innerHTML = (pos.length?pos:[{code:'11',desc:'Office'}]).map(function(x){
        return '<option value="'+x.code+'">'+x.code+' — '+esc(x.desc)+'</option>'; }).join('');
      $('cf_pos').value = C.pos || '11';
    }

    var provs = (OPTS.context && (OPTS.context.provs || OPTS.context.providers)) ||
                OPTS.providers || [];
    if($('cf_provsel')) $('cf_provsel').innerHTML = '<option value="">—</option>'+provs.map(function(p){
      return '<option value="'+p.id+'"'+(String(C.provider_id)===String(p.id)?' selected':'')+'>'+
        esc(p.full_name)+'</option>'; }).join('');

    Object.keys(RADIOS).forEach(function(name){
      var v = C[RADIOS[name]];
      if(v == null || v === '') return;
      var el = document.querySelector('input[name="'+name+'"][value="'+v+'"]');
      if(el) el.checked = true;
    });

    /* the save button's label (Save claim / Edit claim) is set by applyLock()
       below, which runs on every fill() and already knows about OPTS.saveLabel */
    safe(applySend,'applySend'); safe(applyFreq,'applyFreq');
    safe(applyRel,'applyRel'); safe(applyOtherIns,'applyOtherIns');
    safe(paintDx1500,'paintDx1500'); safe(paintLines1500,'paintLines1500');
    /* the total comes from the lines, so it is set after they paint */
    var t=$('cf_total');
    if(t) t.value=(+(C.total||0)).toFixed(2);
    /* always last, and always run even if a step above threw — this is what
       decides whether every field is enabled, so it must never be skipped */
    safe(applyLock,'applyLock');
  }

  function read(){
    if(!C) return;
    Object.keys(FIELDS).forEach(function(id){
      var el = $(id); if(el) C[FIELDS[id]] = el.value;
    });
    Object.keys(CHECKS).forEach(function(id){
      var el = $(id); if(el) C[CHECKS[id]] = el.checked;
    });
    /* radios carry their own names rather than ids */
    Object.keys(RADIOS).forEach(function(name){
      var el = document.querySelector('input[name="'+name+'"]:checked');
      if(el) C[RADIOS[name]] = el.value;
    });
    read1500();
  }


  /* ── payer ── */
  function applySend(){
    /* the paper-versus-electronic note and the payer address block belong to
       the old layout; the numbered form carries the choice in its own box */
    if(!$('cfPaperNote') && !$('cf_payeraddr')) return;

    var paper = C.send_method==='paper';
    document.querySelectorAll('#cfSend .cf-opt').forEach(function(l){
      var r=l.querySelector('input'); l.classList.toggle('on', !!(r&&r.checked));
    });
    document.querySelectorAll('.cf-sec[data-sec="payer"] .elec').forEach(function(el){
      el.style.display = paper?'none':'';
    });
    document.querySelectorAll('.mreq').forEach(function(u){ u.hidden = !paper; });
    $('cf_addrhint').textContent = paper
      ? 'Required. Stedi posts the printed claim here.'
      : 'Where a paper claim would be posted.';
    $('cfPaperNote').innerHTML = paper
      ? '<div class="cf-issue warn" style="margin-bottom:16px">'+
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>'+
        '<span>Stedi prints this on a CMS-1500 and posts it. No payer ID or trading '+
        'partner routing is used, so those fields are hidden.</span></div>' : '';
  }

  function applyRel(){
    if(!$('cf_patfields') && !$('cf_relnote')) return;

    var self = $('cf_rel').value==='18';
    $('cf_patfields').style.display = self?'none':'';
    $('cf_patskip').innerHTML = self
      ? '<div class="cf-issue ok"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>'+
        '<span>The patient is the subscriber, so this loop is left out of the claim.</span></div>' : '';
    $('cf_relnote').textContent = self
      ? 'The patient is the subscriber, so the patient loop is omitted.'
      : 'The patient is a dependent, so both loops are sent.';
  }


  /* ══════════ LOCKING A FILED CLAIM ══════════
     Once a claim has gone to the payer, what we hold must match what they
     hold. Editing it in place would leave our copy disagreeing with theirs,
     and a remittance would then reconcile against something that no longer
     exists.

     So a filed claim is read-only except for the submission type. Choosing a
     correction or a void opens it again, because those are new submissions
     that replace or cancel the original — which is exactly what frequency
     codes 7 and 8 are for. */

  var FILED_STATUSES = ['submitted','pending','accepted','received','in-process',
                        'paid','denied','rejected','closed'];

  function isFiled(c){
    if(!c) return false;
    if(c.stedi_claim_no || c.correlationId) return true;
    return FILED_STATUSES.indexOf(String(c.status||'draft').toLowerCase()) > -1;
  }

  /* a correction or a void is a fresh submission, so everything opens up */
  function amending(){
    var f = $('cf_freq') ? $('cf_freq').value : (C.frequency||'1');
    return f === '7' || f === '8';
  }

  function applyLock(){
    var filed = isFiled(C), locked = filed && !amending();

    var root = $('cfRoot');
    if(!root) return;
    root.classList.toggle('cf-locked', locked);

    root.querySelectorAll('input, select, textarea, button[data-add], button[data-del], '+
      'button[data-addline], button[data-rmline], button[data-dxadd], button[data-dxdel]')
      .forEach(function(el){
        /* the submission type and its reference stay live, and so do the
           controls that only move around the form */
        if(el.id === 'cf_freq' || el.id === 'cf_orig') return;
        if(el.closest('.cf-tabs') || el.closest('.cf-foot')) return;
        if(el.type === 'button' && !el.dataset.add && !el.dataset.del &&
           !el.dataset.addline && !el.dataset.rmline &&
           !el.dataset.dxadd && !el.dataset.dxdel) return;

        if(el.tagName === 'SELECT' || el.type === 'radio' || el.type === 'checkbox' ||
           el.tagName === 'BUTTON'){
          el.disabled = locked;
        }else{
          el.readOnly = locked;
        }
      });

    var banner = $('cfLockNote');
    if(banner){
      banner.hidden = !filed;
      if(filed){
        banner.className = 'cf-lock' + (locked ? '' : ' open');
        banner.innerHTML = locked
          ? '<svg viewBox="0 0 24 24"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/>'+
            '<path d="M8 10.5V7.5a4 4 0 018 0v3"/></svg>'+
            '<span><b>This claim has gone to the payer</b>'+
            'It cannot be changed, because the payer holds a copy and a remittance '+
            'has to reconcile against it. Click <b>Edit claim</b> below to open it '+
            'for a correction, or set the submission type to <b>8 — Void</b> to '+
            'cancel it.</span>'
          : '<svg viewBox="0 0 24 24"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/>'+
            '<path d="M8 10.5V7.5a4 4 0 018 0"/></svg>'+
            '<span><b>Open for a '+($('cf_freq').value==='8'?'void':'correction')+'</b>'+
            'Change what needs changing and submit. The payer replaces the original '+
            'with this one, so the original claim number goes in the box below.</span>';
      }
    }

    /* Filed and not yet reopened: the button becomes "Edit claim" — clicking
       it is what reopens the fields (see the cfSave handler), rather than
       just disabling Save and pointing someone at a dropdown. Once it is
       reopened (an amending frequency), the button is "Save claim" again,
       same as an ordinary edit. */
    var save = $('cfSave');
    if(save){
      save.disabled = false;
      save.dataset.mode = locked ? 'edit' : 'save';
      save.title = '';
      save.innerHTML = locked
        ? '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Edit claim'
        : '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>'+esc(OPTS.saveLabel||'Save claim');
    }
  }

  function applyFreq(){
    var freqEl = $('cf_freq');
    if(!freqEl) return;
    if(!freqEl.value) freqEl.value = '1';   /* 1 — Original claim, always the default */
    var f = freqEl.value, need = (f==='7'||f==='8');

    var origEl = $('cf_origref');
    if(origEl){
      origEl.required = need;
      /* Once a claim has been out and back — whether the payer's claim
         number came from a status check or was typed in by hand — a
         correction or void carries it automatically instead of asking
         for it to be retyped. */
      var known = C.payer_claim_no || C.stedi_claim_no || C.correlationId || '';
      if(need && known && !String(origEl.value||'').trim()) origEl.value = known;
    }
    var hint = $('cf_origref_h');
    if(hint) hint.textContent = need
      ? "Required. The payer will treat this as a duplicate without the claim number they already have on file."
      : 'Only for a correction or void.';
  }

  /* ── box 9 / 11d: the "other insured" loop only matters when there is
     another health benefit plan ── */
  function applyOtherIns(){
    var box = $('bx_oi');
    if(!box) return;
    var checked = document.querySelector('input[name="cf_otherplan"]:checked');
    var yes = !!(checked && checked.value === 'Y');
    box.classList.toggle('dim-off', !yes);
    var note = $('cf_oiNote');
    if(note) note.textContent = yes
      ? "Complete the other insured's name, policy and plan."
      : 'Only needed when 11d is Yes.';
  }

  /* box 1: the programme this payer files under, so it does not have to
     be picked by hand every time */
  function instypeFromPlan(t){
    t = String(t||'').toLowerCase();
    if(/medicare/.test(t)) return 'MB';
    if(/medicaid/.test(t)) return 'MC';
    if(/champva/.test(t)) return 'CH2';
    if(/tricare/.test(t)) return 'CH';
    if(/workers/.test(t)) return 'WC';
    return 'OT';   /* commercial, PPO/HMO/EPO/POS, behavioural health, or unknown */
  }

  /* ── diagnoses ── */

  /* ── service lines ── */
  function lineHTML(l,i){
    var dxs = (C.dx||[]).filter(function(d){ return d; });
    var chips = LETTERS.slice(0, Math.max(1,dxs.length)).map(function(L,k){
      var p = String(k+1);
      var on = (l.dxptrs||[]).indexOf(p) > -1;
      var full = !on && (l.dxptrs||[]).length >= 4;
      return '<button type="button" class="cf-pchip'+(on?' on':'')+(full?' off':'')+
        '" data-p="'+p+'" title="'+esc(dxs[k]||('Diagnosis '+L))+'">'+L+'</button>';
    }).join('');

    var pos = (window.RFCodes && RFCodes.posList) ? RFCodes.posList() : [];
    var posOpts = (pos.length?pos:[{code:'11',desc:'Office'}]).map(function(x){
      return '<option value="'+x.code+'"'+((l.pos||C.pos)===x.code?' selected':'')+'>'+
        x.code+'</option>'; }).join('');

    return '<div class="cf-line" data-desc="'+esc(l.desc||'')+'">'+
      '<div class="cf-lh">'+
        '<span class="no">'+(i+1)+'</span>'+
        '<span class="dsc">'+esc(l.desc||'New line')+'</span>'+
        '<span class="amt">'+money((l.charge||0)*(l.units||1))+'</span>'+
        '<button type="button" class="cf-rm" data-lnrm="'+i+'" aria-label="Remove line">'+
          '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'+
      '</div>'+
      '<div class="cf-grid">'+
        '<label class="cf-f s3"><span>CPT / HCPCS</span>'+
          '<input class="l_cpt" maxlength="7" value="'+esc(l.cpt||'')+'"></label>'+
        '<label class="cf-f s2"><span>Mod 1</span>'+
          '<input class="l_mod" maxlength="2" value="'+esc(l.mod||'')+'"></label>'+
        '<label class="cf-f s2"><span>Mod 2</span>'+
          '<input class="l_mod2" maxlength="2" value="'+esc(l.mod2||'')+'"></label>'+
        '<label class="cf-f s2"><span>Charge</span>'+
          '<input class="l_charge" inputmode="decimal" value="'+(l.charge||0)+'"></label>'+
        '<label class="cf-f s3"><span>Units</span>'+
          '<input class="l_units" type="number" min="1" value="'+(l.units||1)+'"></label>'+
        '<label class="cf-f s3"><span>From</span>'+
          '<input class="l_from" type="date" min="1900-01-01" max="2100-12-31" value="'+esc(l.from||C.dos||'')+'"></label>'+
        '<label class="cf-f s3"><span>To</span>'+
          '<input class="l_to" type="date" min="1900-01-01" max="2100-12-31" value="'+esc(l.to||l.from||C.dos||'')+'"></label>'+
        '<label class="cf-f s3"><span>Place of service</span>'+
          '<select class="l_pos">'+posOpts+'</select></label>'+
        '<label class="cf-f s3"><span>Unit type</span>'+
          '<select class="l_ut">'+
            '<option value="UN"'+(l.unit_type==='UN'?' selected':'')+'>UN — Units</option>'+
            '<option value="MJ"'+(l.unit_type==='MJ'?' selected':'')+'>MJ — Minutes</option>'+
          '</select></label>'+
        '<div class="cf-f s12"><span>Diagnosis pointers'+
            '<u style="color:#8A9A97;font-weight:600;font-size:9.6px">up to four</u></span>'+
          '<div class="cf-ptrs" data-line="'+i+'">'+chips+'</div>'+
          '<span class="cf-ptrnote">'+
            (dxs.length
              ? 'Select every diagnosis this procedure treats, in order of relevance.'
              : 'Add a diagnosis under Claim first.')+
          '</span></div>'+
      '</div></div>';
  }


  /* ── validation ── */
  function validate(){
    read();
    var out = [], paper = C.send_method==='paper';
    var need = [['payer','Payer name','payer']]
      .concat(paper ? [['payer_address','Payer mailing address','payer']]
                    : [['payer_id','Payer ID','payer']])
      .concat([
        ['org_name','Billing provider name','billing'],['org_npi','Billing NPI','billing'],
        ['tax_id','Tax ID','billing'],['org_addr','Billing address','billing'],
        ['org_city','Billing city','billing'],['org_state','Billing state','billing'],
        ['org_zip','Billing ZIP','billing'],
        ['member_id','Member ID','sub'],['sub_first','Subscriber first name','sub'],
        ['sub_last','Subscriber last name','sub'],['sub_dob','Subscriber date of birth','sub'],
        ['control','Patient control number','claim'],['pos','Place of service','claim']
      ]);

    need.forEach(function(f){
      if(!String(C[f[0]]||'').trim())
        out.push({level:'err',msg:f[1]+' is required',sec:f[2]});
    });

    if(C.relationship!=='18'){
      [['patient_first','Patient first name'],['patient_last','Patient last name'],
       ['patient_dob','Patient date of birth']].forEach(function(f){
        if(!String(C[f[0]]||'').trim())
          out.push({level:'err',msg:f[1]+' is required when the patient is not the subscriber',sec:'pat'});
      });
    }

    var dxs = (C.dx||[]).filter(Boolean);
    if(!dxs.length) out.push({level:'err',msg:'At least one diagnosis is required',sec:'claim'});
    if(!(C.lines||[]).length) out.push({level:'err',msg:'At least one service line is required',sec:'lines'});

    (C.lines||[]).forEach(function(l,i){
      if(!l.cpt) out.push({level:'err',msg:'Line '+(i+1)+' has no procedure code',sec:'lines'});
      if(!l.from) out.push({level:'err',msg:'Line '+(i+1)+' has no service date',sec:'lines'});
      if(l.from&&l.to&&l.to<l.from)
        out.push({level:'err',msg:'Line '+(i+1)+"'s To date is before its From date",sec:'lines'});
      if(!l.charge) out.push({level:'warn',msg:'Line '+(i+1)+' has a zero charge',sec:'lines'});
      if(!(l.dxptrs||[]).length)
        out.push({level:'err',msg:'Line '+(i+1)+' points at no diagnosis',sec:'lines'});
      (l.dxptrs||[]).forEach(function(p){
        if(+p > dxs.length)
          out.push({level:'err',
            msg:'Line '+(i+1)+' points at diagnosis '+LETTERS[+p-1]+', which does not exist',
            sec:'lines'});
      });
      if((l.dxptrs||[]).length>4)
        out.push({level:'err',msg:'Line '+(i+1)+' has more than four diagnosis pointers',sec:'lines'});
    });

    if(C.org_npi && !/^\d{10}$/.test(C.org_npi))
      out.push({level:'err',msg:'The billing NPI must be ten digits',sec:'billing'});
    if(C.provider_npi && !/^\d{10}$/.test(C.provider_npi))
      out.push({level:'err',msg:'The rendering NPI must be ten digits',sec:'billing'});
    if(C.org_zip && !/^\d{5}(-?\d{4})?$/.test(C.org_zip))
      out.push({level:'warn',msg:'Most payers want a nine digit billing ZIP',sec:'billing'});
    if(C.frequency==='7' && !String(C.orig_ref||'').trim())
      out.push({level:'err',
        msg:'A corrected claim must carry the original claim number, or the payer will treat it as a duplicate',
        sec:'claim'});
    if(C.frequency==='8' && !String(C.orig_ref||'').trim())
      out.push({level:'err',msg:'A void must name the claim it cancels',sec:'claim'});

    return out;
  }

  function paintReview(){
    var issues = validate();
    var errs = issues.filter(function(x){ return x.level==='err'; });
    var html = '';

    if(C.rejections && C.rejections.length){
      html += '<div class="cf-issue err" style="flex-direction:column;align-items:stretch">'+
        '<b style="display:flex;gap:8px;align-items:center">'+
        '<svg viewBox="0 0 24 24" style="width:15px;height:15px"><path d="M12 4l9 16H3z"/>'+
        '<path d="M12 10v4M12 17h.01"/></svg>The payer rejected this claim</b>'+
        '<ul>'+C.rejections.map(function(e){
          return '<li>'+(e.code?'<code>'+esc(e.code)+'</code> ':'')+esc(e.message||'')+'</li>';
        }).join('')+'</ul>'+
        '<span style="margin-top:7px;font-size:11px;opacity:.85">Correct the fields, then '+
        'choose <b>Corrected claim</b> if the payer has already processed the original.</span></div>';
    }

    html += issues.length
      ? issues.map(function(x){
          return '<div class="cf-issue '+(x.level==='err'?'err':'warn')+'">'+
            '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>'+
            '<span>'+esc(x.msg)+' · <a data-goto="'+x.sec+'">go to it</a></span></div>';
        }).join('')
      : '<div class="cf-issue ok"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>'+
        '<span><b>Ready to submit.</b> Everything the payer needs is present.</span></div>';

    if($('cf_issues')) $('cf_issues').innerHTML = html;
    if($('cfState')){
      $('cfState').textContent = errs.length ? (errs.length+' TO FIX') : 'READY';
      $('cfState').className = 'cf-state '+(errs.length?'issues':'ready');
    }
    if(OPTS.preview) $('cf_preview').innerHTML = OPTS.preview(C);
  }

  var ORDER = ['payer','billing','sub','pat','claim','lines','review'];
  /* The form is one continuous sheet now, as the paper one is. "Review" is the
     only thing that is genuinely a different view. */
  function show(sec){
    var rev = sec === 'review';
    var form = document.querySelector('.cf-1500');
    var r = $('cfReview');
    /* Build the review content before switching anything's visibility. If
       paintReview() throws — bad data on a field it does not expect — the
       form stays exactly as it was instead of ending up hidden behind an
       empty review pane, which is what an exception here used to look like:
       a blank editor with no way back to the fields. */
    if(rev) safe(paintReview,'paintReview');
    if(form) form.hidden = rev;
    if(r) r.hidden = !rev;
    CUR = sec;
    document.querySelectorAll('.cf-tabs [data-go]').forEach(function(b){
      b.classList.toggle('on', (b.dataset.go === 'review') === rev);
    });
    var body = $('cfBody'); if(body) body.scrollTop = 0;
    return;
  }
  /* ── events, bound once ── */
  function wire(){
    /* The form is one sheet now, so the only thing to switch between is the
       sheet and the review. Bindings are guarded because a missing element
       must not stop the editor opening — that is exactly how "create claim
       does nothing" happens. */
    var on = function(id, ev, fn){
      var el = $(id);
      if(el) el.addEventListener(ev, fn);
      else console.warn('ReviFlow claim form: no element #'+id+' to bind '+ev);
    };

    on('cfBackToForm', 'click', function(){ show('form'); });
    on('cfClose', 'click', close);
    on('cfCancel', 'click', close);

    on('cfSend', 'change', function(e){
      safe(function(){
        if(e.target.name!=='cfSendM') return;
        C.send_method = e.target.value; applySend();
      }, 'cfSend change');
    });
    on('cf_rel', 'change', function(){ safe(function(){ read(); applyRel(); }, 'cf_rel change'); });
    on('cf_freq', 'change', function(){
      safe(function(){ read(); applyFreq(); applyLock(); }, 'cf_freq change');
    });

    /* payer name fills the id, the mailing address behind the scenes, and
       box 1's insurance type from the admin list */
    function fillPayer(){
      safe(function(){
        var hit = findPayer($('cf_payer').value);
        if(!hit) return;
        $('cf_payer').value = hit.name||'';
        if(hit.payer_id) $('cf_payerid').value = hit.payer_id;
        /* the numbered form keeps this box to just a name and an ID, so the
           mailing address a paper claim needs travels on the claim itself */
        if(hit.mailing_address) C.payer_address = hit.mailing_address;
        var kind = instypeFromPlan(hit.plan_type);
        var r = document.querySelector('input[name="cf_instype"][value="'+kind+'"]');
        if(r) r.checked = true;
        C.insurance_type = kind;
        var h = $('cf_payer_h');
        if(h) h.textContent = 'Matched '+(hit.name||'')+' in Admin → Payers.';
        read();
      }, 'fillPayer');
    }
    on('cf_payer', 'change', fillPayer);
    on('cf_payer', 'blur', fillPayer);


    on('cf_issues', 'click', function(e){
      safe(function(){
        var a = e.target.closest('[data-goto]'); if(a) show(a.dataset.goto);
      }, 'cf_issues click');
    });

    on('cfPrint', 'click', function(){
      safe(function(){
        read();
        if(OPTS.preview) $('cf_preview').innerHTML = OPTS.preview(C);
        show('review');
        setTimeout(function(){ window.print(); },180);
      }, 'cfPrint click');
    });

    on('cfDownload', 'click', function(){
      safe(function(){
        read();
        downloadClaimPdf(C);
      }, 'cfDownload click');
    });


  /* ── the numbered form's own controls ── */

  /* everything typed goes straight into the claim, so nothing is lost by
     scrolling away from a box */
  /* Both handlers are wrapped in safe() — a delegated listener on the whole
     body fires on nearly every keystroke and click in the form, so one bad
     field value or a stale reference in a follow-on paint step must not be
     able to leave the editor half-updated or looking blank. */
  on('cfBody', 'input', function(e){
    safe(function(){
      var el = e.target;
      if(!el.matches('input, select, textarea')) return;
      read();
      if(el.dataset.dx != null){
        /* a diagnosis changed: descriptions and the pointer hints follow */
        clearTimeout(window._cfDxT);
        window._cfDxT = setTimeout(function(){ safe(paintDx1500,'paintDx1500'); }, 500);
      }
      if(el.dataset.f === 'charge' || el.dataset.f === 'units'){
        var lines = C.lines || [];
        var total = lines.reduce(function(a,l){ return a+(+l.charge||0)*(+l.units||1); },0);
        C.total = Math.round(total*100)/100;
        $('cf_linetotal').textContent = money(C.total);
        var t = $('cf_total'); if(t) t.value = (+C.total).toFixed(2);
      }
    }, 'cfBody input');
  });

  on('cfBody', 'change', function(e){
    safe(function(){
      if(!e.target.matches('input[type="radio"], select')) return;
      read();
      if(e.target.name === 'cf_send') applySend();
      if(e.target.name === 'cf_rel') applyRel();
      if(e.target.name === 'cf_otherplan') applyOtherIns();
    }, 'cfBody change');
  });

  /* box 21: a dropdown of matching ICD-10 codes under whichever letter
     has focus, or is being typed into */
  on('cf_dxgrid', 'focusin', function(e){
    safe(function(){ var inp = e.target.closest('[data-dx]'); if(inp) openDxDrop(inp); }, 'dxgrid focusin');
  });
  on('cf_dxgrid', 'input', function(e){
    safe(function(){ var inp = e.target.closest('[data-dx]'); if(inp) openDxDrop(inp); }, 'dxgrid input');
  });
  on('cf_dxgrid', 'mousedown', function(e){
    safe(function(){
      var item = e.target.closest('.dxi'); if(!item) return;
      e.preventDefault();
      var wrap = item.closest('.dxc'), inp = wrap && wrap.querySelector('[data-dx]');
      if(!inp) return;
      inp.value = item.dataset.code || '';
      read();
      closeDxDrops();
      clearTimeout(window._cfDxT);
      window._cfDxT = setTimeout(function(){ safe(paintDx1500,'paintDx1500'); }, 120);
    }, 'dxgrid mousedown');
  });
  document.addEventListener('click', function(e){
    safe(function(){ if(!e.target.closest('.dxc')) closeDxDrops(); }, 'dx click-outside');
  });

  on('cf_addline', 'click', function(){
    safe(function(){
      read();
      C.lines = C.lines || [];
      C.lines.push({ cpt:'', mod:'', mod2:'', dxptrs:C.dx && C.dx[0] ? ['1'] : [],
                     charge:0, units:1, unit_type:'UN', from:C.dos||'', pos:C.pos||'' });
      paintLines1500();
      var rows = $('cf_svclines').querySelectorAll('.svcr');
      var last = rows[rows.length-1];
      if(last){ var cpt = last.querySelector('[data-f="cpt"]'); if(cpt) cpt.focus(); }
    }, 'cf_addline click');
  });

  on('cf_svclines', 'click', function(e){
    safe(function(){
      var rm = e.target.closest('[data-rmline]');
      if(!rm) return;
      read();
      C.lines.splice(+rm.dataset.rmline, 1);
      paintLines1500();
    }, 'cf_svclines click');
  });

  /* typing a payer name fills its ID from the payer list */
  on('cf_payer', 'input', function(){
    var self = this;
    safe(function(){
      var v = self.value.trim().toLowerCase();
      if(v.length < 2) return;
      var payers = (window.RFCodes && RFCodes.payers) ? RFCodes.payers() : [];
      var hit = payers.filter(function(p){
        return String(p.name||'').toLowerCase() === v; })[0];
      if(hit){
        if($('cf_payerid') && !$('cf_payerid').value) $('cf_payerid').value = hit.payer_id || '';
        read();
      }
    }, 'cf_payer input');
  });

    on('cfSave', 'click', async function(){
      var btn = this;

      /* "Edit claim" — this same button, relabelled by applyLock() while the
         claim is filed and untouched. Clicking it opens the claim for a
         correction (frequency 7) rather than saving anything; Save proper
         only happens on the next click, once it is unlocked. */
      if(btn.dataset.mode === 'edit'){
        safe(function(){
          read();
          EDIT_SNAPSHOT = snapshotForEdit();
          var freqEl = $('cf_freq');
          if(freqEl) freqEl.value = '7';
          C.frequency = '7';
          applyFreq(); applyLock();
        }, 'cfSave edit');
        notify('Claim opened for editing',
          'Make the correction, then Save to submit it as a corrected claim');
        return;
      }

      /* The button is disabled while locked, but a disabled button is a
         courtesy rather than a guarantee — check the state itself too. */
      if(isFiled(C) && !amending()){
        notify('This claim has already been filed',
          'Click Edit claim to open it for a correction or void');
        return;
      }
      var issues = [];
      var validateOk = safe(function(){
        issues = validate();
        var errs = issues.filter(function(x){ return x.level==='err'; });
        if(errs.length){
          show('review');
          notify(errs.length+' thing'+(errs.length===1?'':'s')+' to fix',
            'The payer would reject this claim as it stands');
        }
        return !errs.length;
      }, 'cfSave validate');
      if(validateOk !== true) return;

      /* Edit claim was clicked, but nothing on the form actually changed —
         submitting this would only relabel an identical claim as a
         "corrected" one and waste a submission on the payer's side. read()
         already ran inside validate() above, so C reflects the form as it
         stands right now. */
      if(EDIT_SNAPSHOT !== null && amending() && snapshotForEdit() === EDIT_SNAPSHOT){
        notify('No changes were made',
          'Edit a field before saving, or Cancel to leave the claim as it was');
        return;
      }

      btn.disabled = true;
      try{
        if(OPTS.onSave) await OPTS.onSave(C);
        EDIT_SNAPSHOT = null;
      }catch(err){
        console.error('ReviFlow claim form: onSave failed', err);
        notify('Could not save', 'Something went wrong saving this claim — your entries are still on screen');
      }finally{ btn.disabled = false; }
    });
  }

  function notify(t,s){
    if(OPTS.onNotify){ OPTS.onNotify(t,s); return; }
    if(window.RFNotify && RFNotify.toast){ RFNotify.toast(t,s); return; }
    console.warn('ReviFlow · '+t+(s?' — '+s:''));
  }

})();
