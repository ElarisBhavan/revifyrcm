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
    try{ fn(); }
    catch(err){ console.error('ReviFlow claim form: '+label+' failed', err); }
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

      /* ── review: what the payer would object to ── */
      '<section class="cf-sec" data-sec="review" id="cfReview" hidden>'+
        '<div class="cf-issues" id="cf_issues"></div>'+
        '<div class="cf-preview" id="cf_preview"></div>'+
      '</section>'+

    '</div>'+

    '<div class="cf-foot">'+
      '<button class="cf-btn ghost" id="cfCancel">Cancel</button>'+
      '<button class="cf-btn" id="cfPrev"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>Back</button>'+
      '<span class="sp"></span>'+
      '<button class="cf-btn" id="cfPrint"><svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 19H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2"/><path d="M7 15h10v6H7z"/></svg>Print</button>'+
      '<button class="cf-btn" id="cfNext">Next<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>'+
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
            fld('cf_patzip','ZIP',{sm:true,mono:true,max:10}))) +
    bx('6','Patient relationship to insured',
        radios('cf_rel',[['18','Self'],['01','Spouse'],['19','Child'],['G8','Other']]),
        {req:true}) +
    bx('7','Insured address',
        row(fld('cf_subaddr','Line 1',{w:'w3'}))+
        row(fld('cf_subaddr2','Line 2',{w:'w3'}))+
        row(fld('cf_subcity','City',{w:'w2'}),
            fld('cf_substate','State',{sm:true,options:STATES}),
            fld('cf_subzip','ZIP',{sm:true,mono:true,max:10}))) +

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
        '<div class="dxtbl" id="cf_dxgrid"></div>'+
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
          '<span></span><span>Dates of service *</span><span>Place *</span><span>EMG</span>'+
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
    /* all twelve, A through L, are on screen from the start, laid out as a
       table row per letter — the same look box 24's service lines use */
    var out='<div class="dxtblh"><span></span><span>ICD-10 code *</span><span>Description</span></div>';
    for(var i=0;i<12;i++){
      var v=list[i]||'';
      var desc=(v&&window.RFCodes&&RFCodes.icdDesc)?RFCodes.icdDesc(v):'';
      out+='<div class="dxrow1500'+(i===0?' primary':'')+'">'+
        '<span class="dxn" title="'+(i===0?'Primary diagnosis':'Diagnosis '+DXL[i])+'">'+DXL[i]+'</span>'+
        '<span class="dxcell">'+
          '<input type="text" data-dx="'+i+'" value="'+esc(v)+'" maxlength="8" autocomplete="off" '+
            'placeholder="'+(i===0?'F41.1':'—')+'">'+
          '<div class="dxlist-drop" data-dxdrop="'+i+'"></div>'+
        '</span>'+
        '<span class="desc'+(desc?'':' empty')+'" title="'+esc(desc)+'">'+
          (desc?esc(desc):(i===0?'Primary diagnosis':'—'))+'</span>'+
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
    var drop = input.parentElement && input.parentElement.querySelector('[data-dxdrop]');
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
            '<span data-l="Dates"><input type="date" data-ln="'+i+'" data-f="dos" '+
              'value="'+esc(l.from||l.dos||C.dos||'')+'" min="1900-01-01" max="2100-12-31"></span>'+
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
        }else if(f==='dos'){
          l.from=v; l.dos=v;
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
    cf_patcity:'pat_city', cf_patstate:'pat_state', cf_patzip:'pat_zip',
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
      var payerName = String($('cf_payer').value||'').trim().toLowerCase();
      if(payerName && window.RFCodes && RFCodes.payers){
        var payerHit = RFCodes.payers().filter(function(p){
          return String(p.name||'').toLowerCase() === payerName; })[0];
        if(payerHit && payerHit.payer_id){
          $('cf_payerid').value = payerHit.payer_id;
          C.payer_id = payerHit.payer_id;
        }
      }
    }

    var payers = (window.RFCodes && RFCodes.payers) ? RFCodes.payers() : [];
    if($('cfPayerList')) $('cfPayerList').innerHTML = payers.map(function(p){
      return '<option value="'+esc(p.name)+'">'+esc(p.payer_id||'')+'</option>'; }).join('');

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

    if(OPTS.saveLabel){
      $('cfSave').innerHTML='<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>'+
        esc(OPTS.saveLabel);
    }
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
            'has to reconcile against it. To change something, set the submission '+
            'type below to <b>7 — Corrected</b>, or <b>8 — Void</b> to cancel it.</span>'
          : '<svg viewBox="0 0 24 24"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/>'+
            '<path d="M8 10.5V7.5a4 4 0 018 0"/></svg>'+
            '<span><b>Open for a '+($('cf_freq').value==='8'?'void':'correction')+'</b>'+
            'Change what needs changing and submit. The payer replaces the original '+
            'with this one, so the original claim number goes in the box below.</span>';
      }
    }

    var save = $('cfSave');
    if(save){
      save.disabled = locked;
      save.title = locked
        ? 'Set the submission type to 7 or 8 to change this claim' : '';
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

    on('cfNext', 'click', function(){ show(CUR === 'review' ? 'form' : 'review'); });
    on('cfPrev', 'click', function(){ show('form'); });
    on('cfClose', 'click', close);
    on('cfCancel', 'click', close);

    on('cfSend', 'change', function(e){
      if(e.target.name!=='cfSendM') return;
      C.send_method = e.target.value; applySend();
    });
    on('cf_rel', 'change', function(){ read(); applyRel(); });
    on('cf_freq', 'change', function(){
      read(); applyFreq(); applyLock();
    });

    /* payer name fills the id, the mailing address behind the scenes, and
       box 1's insurance type from the admin list */
    function fillPayer(){
      if(!window.RFCodes || !RFCodes.payers) return;
      var q = String($('cf_payer').value||'').trim().toLowerCase();
      if(!q) return;
      var hit = RFCodes.payers().filter(function(p){
        return String(p.name||'').toLowerCase()===q ||
               String(p.payer_id||'').toLowerCase()===q; })[0];
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
    }
    on('cf_payer', 'change', fillPayer);
    on('cf_payer', 'blur', fillPayer);


    on('cf_issues', 'click', function(e){
      var a = e.target.closest('[data-goto]'); if(a) show(a.dataset.goto);
    });

    on('cfPrint', 'click', function(){
      read();
      if(OPTS.preview) $('cf_preview').innerHTML = OPTS.preview(C);
      show('review');
      setTimeout(function(){ window.print(); },180);
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
    var inp = e.target.closest('[data-dx]'); if(inp) openDxDrop(inp);
  });
  on('cf_dxgrid', 'input', function(e){
    var inp = e.target.closest('[data-dx]'); if(inp) openDxDrop(inp);
  });
  on('cf_dxgrid', 'mousedown', function(e){
    var item = e.target.closest('.dxi'); if(!item) return;
    e.preventDefault();
    var wrap = item.closest('.dxcell'), inp = wrap && wrap.querySelector('[data-dx]');
    if(!inp) return;
    inp.value = item.dataset.code || '';
    read();
    closeDxDrops();
    clearTimeout(window._cfDxT);
    window._cfDxT = setTimeout(paintDx1500, 120);
  });
  document.addEventListener('click', function(e){
    if(!e.target.closest('.dxcell')) closeDxDrops();
  });

  on('cf_addline', 'click', function(){
    read();
    C.lines = C.lines || [];
    C.lines.push({ cpt:'', mod:'', mod2:'', dxptrs:C.dx && C.dx[0] ? ['1'] : [],
                   charge:0, units:1, unit_type:'UN', from:C.dos||'', pos:C.pos||'' });
    paintLines1500();
    var rows = $('cf_svclines').querySelectorAll('.svcr');
    var last = rows[rows.length-1];
    if(last){ var cpt = last.querySelector('[data-f="cpt"]'); if(cpt) cpt.focus(); }
  });

  on('cf_svclines', 'click', function(e){
    var rm = e.target.closest('[data-rmline]');
    if(!rm) return;
    read();
    C.lines.splice(+rm.dataset.rmline, 1);
    paintLines1500();
  });

  /* typing a payer name fills its ID from the payer list */
  on('cf_payer', 'input', function(){
    var v = this.value.trim().toLowerCase();
    if(v.length < 2) return;
    var payers = (window.RFCodes && RFCodes.payers) ? RFCodes.payers() : [];
    var hit = payers.filter(function(p){
      return String(p.name||'').toLowerCase() === v; })[0];
    if(hit){
      if($('cf_payerid') && !$('cf_payerid').value) $('cf_payerid').value = hit.payer_id || '';
      read();
    }
  });

    on('cfSave', 'click', async function(){
      /* The button is disabled while locked, but a disabled button is a
         courtesy rather than a guarantee — check the state itself too. */
      if(isFiled(C) && !amending()){
        notify('This claim has already been filed',
          'Set the submission type to 7 or 8 to change it');
        return;
      }
      var issues = validate();
      var errs = issues.filter(function(x){ return x.level==='err'; });
      if(errs.length){
        show('review');
        notify(errs.length+' thing'+(errs.length===1?'':'s')+' to fix',
          'The payer would reject this claim as it stands');
        return;
      }
      this.disabled = true;
      try{
        if(OPTS.onSave) await OPTS.onSave(C);
      }finally{ this.disabled = false; }
    });
  }

  function notify(t,s){
    if(OPTS.onNotify){ OPTS.onNotify(t,s); return; }
    if(window.RFNotify && RFNotify.toast){ RFNotify.toast(t,s); return; }
    console.warn('ReviFlow · '+t+(s?' — '+s:''));
  }

})();
