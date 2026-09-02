/* Shared code sets for typeahead — CPT/ICD-10 pickers show ONLY what an
   administrator has uploaded via Admin/master-data.html. There is no
   built-in sample data for CPT or ICD-10 any more: an empty list here
   means the practice hasn't loaded a code set yet, and the picker should
   show that empty state rather than made-up codes. */
window.RFCodes = {
  cpt: [],
  icd: [],
  pos: [
    {code:'11',desc:'Office'},{code:'02',desc:'Telehealth — other than patient home'},
    {code:'10',desc:'Telehealth — patient home'},{code:'12',desc:'Home'},
    {code:'19',desc:'Off campus outpatient hospital'},{code:'22',desc:'On campus outpatient hospital'},
    {code:'21',desc:'Inpatient hospital'},{code:'23',desc:'Emergency room'},
    {code:'81',desc:'Independent laboratory'},{code:'99',desc:'Other place of service'}
  ],
  /* the 50 states + DC — shared by the payer editor's state picker
     (Admin/payers.html) and the eligibility form's state filter
     (Provider/eligibility.html), so the two never drift apart */
  US_STATES: [
    {code:'AL',name:'Alabama'},{code:'AK',name:'Alaska'},{code:'AZ',name:'Arizona'},
    {code:'AR',name:'Arkansas'},{code:'CA',name:'California'},{code:'CO',name:'Colorado'},
    {code:'CT',name:'Connecticut'},{code:'DE',name:'Delaware'},{code:'DC',name:'District of Columbia'},
    {code:'FL',name:'Florida'},{code:'GA',name:'Georgia'},{code:'HI',name:'Hawaii'},
    {code:'ID',name:'Idaho'},{code:'IL',name:'Illinois'},{code:'IN',name:'Indiana'},
    {code:'IA',name:'Iowa'},{code:'KS',name:'Kansas'},{code:'KY',name:'Kentucky'},
    {code:'LA',name:'Louisiana'},{code:'ME',name:'Maine'},{code:'MD',name:'Maryland'},
    {code:'MA',name:'Massachusetts'},{code:'MI',name:'Michigan'},{code:'MN',name:'Minnesota'},
    {code:'MS',name:'Mississippi'},{code:'MO',name:'Missouri'},{code:'MT',name:'Montana'},
    {code:'NE',name:'Nebraska'},{code:'NV',name:'Nevada'},{code:'NH',name:'New Hampshire'},
    {code:'NJ',name:'New Jersey'},{code:'NM',name:'New Mexico'},{code:'NY',name:'New York'},
    {code:'NC',name:'North Carolina'},{code:'ND',name:'North Dakota'},{code:'OH',name:'Ohio'},
    {code:'OK',name:'Oklahoma'},{code:'OR',name:'Oregon'},{code:'PA',name:'Pennsylvania'},
    {code:'RI',name:'Rhode Island'},{code:'SC',name:'South Carolina'},{code:'SD',name:'South Dakota'},
    {code:'TN',name:'Tennessee'},{code:'TX',name:'Texas'},{code:'UT',name:'Utah'},
    {code:'VT',name:'Vermont'},{code:'VA',name:'Virginia'},{code:'WA',name:'Washington'},
    {code:'WV',name:'West Virginia'},{code:'WI',name:'Wisconsin'},{code:'WY',name:'Wyoming'}
  ],
  findCpt: function(q){
    q=String(q||'').toLowerCase().trim(); if(!q)return this.cpt.slice(0,12);
    return this.cpt.filter(function(c){
      return c.code.toLowerCase().indexOf(q)===0 || c.desc.toLowerCase().indexOf(q)>-1;
    }).slice(0,25);
  },
  findIcd: function(q){
    q=String(q||'').toLowerCase().trim(); if(!q)return this.icd.slice(0,12);
    return this.icd.filter(function(c){
      return c.code.toLowerCase().indexOf(q)===0 || c.desc.toLowerCase().indexOf(q)>-1;
    }).slice(0,25);
  },
  cptFee: function(code){
    var c=this.cpt.filter(function(x){return x.code===code;})[0];
    return c?c.fee:0;
  },
  cptDesc: function(code){
    var c=this.cpt.filter(function(x){return x.code===code;})[0];
    return c?c.desc:'';
  },
  icdDesc: function(code){
    var c=this.icd.filter(function(x){return x.code===code;})[0];
    return c?c.desc:'';
  }
};


/* ═══════════════════════════════════════════════════════════════
   Master data bridge
   Codes entered by an administrator take precedence. The built-in
   lists above are the fallback when a code set has not been loaded.
   Call RFCodes.sync() once per page after RFStore is ready.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  var C = window.RFCodes;
  C._admin = { cpt:null, hcpcs:null, icd:null, pos:null, modifier:null, servicetype:null, payers:null };
  C.ready = false;

  C.sync = async function(){
    if(typeof RFStore === 'undefined') return false;
    try{
      await RFStore.ready();
      var cpt   = await RFStore.master('cpt');
      var hcpcs = await RFStore.master('hcpcs');
      var icd   = await RFStore.master('icd10');
      var pos   = await RFStore.master('pos');
      var mod   = await RFStore.master('modifier');
      var stc   = await RFStore.master('servicetype');
      var fee   = await RFStore.master('fee');
      var pay   = await RFStore.payers();

      var feeMap = {};
      fee.forEach(function(f){ if(f.fee != null) feeMap[String(f.code)] = Number(f.fee); });

      function shape(list){
        return list.filter(function(x){ return x.status !== 'inactive'; })
          .map(function(x){
            return { code:String(x.code), desc:x.description||x.desc||'',
                     fee: feeMap[String(x.code)] != null ? feeMap[String(x.code)]
                          : (x.fee != null ? Number(x.fee) : 0) };
          });
      }

      C._admin.cpt         = cpt.length   ? shape(cpt)   : null;
      C._admin.hcpcs       = hcpcs.length ? shape(hcpcs) : null;
      C._admin.icd         = icd.length   ? shape(icd)   : null;
      C._admin.pos         = pos.length   ? shape(pos)   : null;
      C._admin.modifier    = mod.length   ? shape(mod)   : null;
      C._admin.servicetype = stc.length   ? shape(stc)   : null;
      C._admin.payers      = pay;
      C.ready = true;
      return true;
    }catch(e){ console.warn('code sync skipped', e); return false; }
  };

  /* CPT and HCPCS share one search, since both are procedure codes.
     No fallback to built-in sample data any more — if the admin hasn't
     uploaded a CPT/HCPCS or ICD-10 set yet, the picker is simply empty
     until they do, instead of showing codes nobody entered. */
  function procedures(){
    return (C._admin.cpt||[]).concat(C._admin.hcpcs||[]);
  }
  function diagnoses(){ return C._admin.icd || []; }

  C.findCpt = function(q){
    var list = procedures();
    q = String(q||'').toLowerCase().trim();
    if(!q) return list.slice(0,40);
    return list.filter(function(c){
      return c.code.toLowerCase().indexOf(q) === 0 || c.desc.toLowerCase().indexOf(q) > -1;
    }).slice(0,60);
  };
  C.findIcd = function(q){
    var list = diagnoses();
    q = String(q||'').toLowerCase().trim();
    if(!q) return list.slice(0,40);
    return list.filter(function(c){
      return c.code.toLowerCase().indexOf(q) === 0 || c.desc.toLowerCase().indexOf(q) > -1;
    }).slice(0,60);
  };
  C.cptFee = function(code){
    var c = procedures().filter(function(x){ return x.code === String(code); })[0];
    return c ? (c.fee||0) : 0;
  };
  C.cptDesc = function(code){
    var c = procedures().filter(function(x){ return x.code === String(code); })[0];
    return c ? c.desc : '';
  };
  C.icdDesc = function(code){
    var c = diagnoses().filter(function(x){ return x.code === String(code); })[0];
    return c ? c.desc : '';
  };

  /* place of service and service type, admin-first */
  C.posList = function(){ return C._admin.pos || C.pos; };
  C.posDesc = function(code){
    var p = C.posList().filter(function(x){ return String(x.code) === String(code); })[0];
    return p ? p.desc : '';
  };
  C.modifiers = function(){ return C._admin.modifier || []; };

  /* service types are what the eligibility form offers */
  C.SERVICE_FALLBACK = [
    {code:'30',desc:'Health benefit plan coverage'},
    {code:'98',desc:'Professional visit, office'},
    {code:'MH',desc:'Mental health'},
    {code:'47',desc:'Hospital'},
    {code:'86',desc:'Emergency services'},
    {code:'88',desc:'Pharmacy'},
    {code:'UC',desc:'Urgent care'},
    {code:'35',desc:'Dental care'},
    {code:'AL',desc:'Vision'}
  ];
  C.serviceTypes = function(){ return C._admin.servicetype || C.SERVICE_FALLBACK; };
  C.serviceDesc = function(code){
    var s = C.serviceTypes().filter(function(x){ return String(x.code) === String(code); })[0];
    return s ? s.desc : '';
  };

  /* ── Service Type Category (STC) names and grouping ──
     Shared by the eligibility check page (the instant Copay/Coinsurance
     read right after you submit) and the full eligibility result page (the
     Cost summary), so the two never disagree with each other about what a
     benefit line means or which lines count as "this service". */

  /* Stedi's own Service Type Category table, in full — every code a payer
     might send back gets a real name instead of "Service type XX". */
  C.STC_NAMES = {
    '1':'Medical care','2':'Surgical','3':'Consultation','4':'Diagnostic X-ray',
    '5':'Diagnostic lab','6':'Radiation therapy','7':'Anesthesia','8':'Surgical assistance',
    '9':'Other medical','10':'Blood charges','11':'Used durable medical equipment',
    '12':'Durable medical equipment purchase','13':'Ambulatory service center facility',
    '14':'Renal supplies in the home','15':'Alternate method dialysis',
    '16':'Chronic renal disease (CRD) equipment','17':'Pre-admission testing',
    '18':'Durable medical equipment rental','19':'Pneumonia vaccine',
    '20':'Second surgical opinion','21':'Third surgical opinion','22':'Social work',
    '23':'Diagnostic dental','24':'Periodontics','25':'Restorative','26':'Endodontics',
    '27':'Maxillofacial prosthetics','28':'Adjunctive dental services',
    '30':'Health benefit plan coverage','32':'Plan waiting period','33':'Chiropractic',
    '34':'Chiropractic office visits','35':'Dental care','36':'Dental crowns',
    '37':'Dental accident','38':'Orthodontics','39':'Prosthodontics','40':'Oral surgery',
    '41':'Routine (preventive) dental','42':'Home health care','43':'Home health prescriptions',
    '44':'Home health visits','45':'Hospice','46':'Respite care','47':'Hospital',
    '48':'Hospital inpatient','49':'Hospital room and board','50':'Hospital outpatient',
    '51':'Hospital emergency accident','52':'Hospital emergency medical',
    '53':'Hospital ambulatory surgical','54':'Long term care','55':'Major medical',
    '56':'Medically related transportation','57':'Air transportation','58':'Cabulance',
    '59':'Licensed ambulance','60':'General benefits','61':'In-vitro fertilization',
    '62':'MRI / CAT scan','63':'Donor procedures','64':'Acupuncture','65':'Newborn care',
    '66':'Pathology','67':'Smoking cessation','68':'Well baby care','69':'Maternity',
    '70':'Transplants','71':'Audiology exam','72':'Inhalation therapy',
    '73':'Diagnostic medical','74':'Private duty nursing','75':'Prosthetic device',
    '76':'Dialysis','77':'Otological exam','78':'Chemotherapy','79':'Allergy testing',
    '80':'Immunizations','81':'Routine physical','82':'Family planning','83':'Infertility',
    '84':'Abortion','85':'AIDS','86':'Emergency services','87':'Cancer','88':'Pharmacy',
    '89':'Free standing prescription drug','90':'Mail order prescription drug',
    '91':'Brand name prescription drug','92':'Generic prescription drug','93':'Podiatry',
    '94':'Podiatry office visits','95':'Podiatry nursing home visits',
    '96':'Professional (physician)','97':'Anesthesiologist',
    '98':'Professional visit, office','99':'Professional visit, inpatient',
    'A0':'Professional visit, outpatient','A1':'Professional visit, nursing home',
    'A2':'Professional visit, skilled nursing facility','A3':'Professional visit, home',
    'A4':'Psychiatric','A5':'Psychiatric room and board','A6':'Psychotherapy',
    'A7':'Psychiatric inpatient','A8':'Psychiatric outpatient','A9':'Rehabilitation',
    'AA':'Rehabilitation room and board','AB':'Rehabilitation inpatient',
    'AC':'Rehabilitation outpatient','AD':'Occupational therapy','AE':'Physical medicine',
    'AF':'Speech therapy','AG':'Skilled nursing care','AH':'Skilled nursing room and board',
    'AI':'Substance abuse','AJ':'Alcoholism','AK':'Drug addiction','AL':'Vision',
    'AM':'Frames','AN':'Routine vision exam','AO':'Lenses','AQ':'Nonmedically necessary physical',
    'AR':'Experimental drug therapy','B1':'Burn care',
    'B2':'Brand name prescription drug, formulary','B3':'Brand name prescription drug, non-formulary',
    'BA':'Independent medical evaluation','BB':'Partial hospitalization (psychiatric)',
    'BC':'Day care (psychiatric)','BD':'Cognitive therapy','BE':'Massage therapy',
    'BF':'Pulmonary rehabilitation','BG':'Cardiac rehabilitation','BH':'Pediatric',
    'BI':'Nursery','BJ':'Skin','BK':'Orthopedic','BL':'Cardiac','BM':'Lymphatic',
    'BN':'Gastrointestinal','BP':'Endocrine','BQ':'Neurology','BR':'Eye',
    'BS':'Invasive procedures','BT':'Gynecological','BU':'Obstetrical',
    'BV':'Obstetrical / gynecological','BW':'Mail order prescription drug, brand name',
    'BX':'Mail order prescription drug, generic','BY':'Physician visit, office: sick',
    'BZ':'Physician visit, office: well','C1':'Coronary care',
    'CA':'Private duty nursing, inpatient','CB':'Private duty nursing, home',
    'CC':'Surgical benefits, professional','CD':'Surgical benefits, facility',
    'CE':'Mental health provider, inpatient','CF':'Mental health provider, outpatient',
    'CG':'Mental health facility, inpatient','CH':'Mental health facility, outpatient',
    'CI':'Substance abuse facility, inpatient','CJ':'Substance abuse facility, outpatient',
    'CK':'Screening x-ray','CL':'Screening laboratory','CM':'Mammogram, high risk patient',
    'CN':'Mammogram, low risk patient','CO':'Flu vaccination',
    'CP':'Eyewear and eyewear accessories','CQ':'Case management','DG':'Dermatology',
    'DM':'Durable medical equipment','DS':'Diabetic supplies',
    'GF':'Generic prescription drug, formulary','GN':'Generic prescription drug, non-formulary',
    'GY':'Allergy','IC':'Intensive care','MH':'Mental health','NI':'Neonatal intensive care',
    'ON':'Oncology','PT':'Physical therapy','PU':'Pulmonary','RN':'Renal',
    'RT':'Residential psychiatric treatment','TC':'Transitional care',
    'TN':'Transitional nursery care','UC':'Urgent care'
  };

  /* Which STCs to treat as the same clinical service when matching a
     returned benefit line against the one STC actually requested. Built
     straight from Stedi's own "type of care -> STCs to try" guide: payers
     routinely attach a benefit (a copay, in particular) to a neighbouring
     code from that same recommended group rather than the exact one you
     asked about — checking Mental Health as MH alone and getting no copay,
     then checking again as 98 (Professional visit, office) and finding it,
     is that guide's own documented behaviour, not a data error.
     `keys` — the STCs for which this group is the authoritative family
     (i.e. what to use when THIS is the one code actually requested).
     `accept` — every STC a returned benefit line may carry and still count
     as this same service. A generic, cross-discipline code like 98 or 96
     is deliberately never a `key` anywhere except its own Office visit
     group — it may be *accepted* inside several groups (a copay can land
     there instead of the specific code), but requesting 98 or 96 directly
     gets the Office visit family, never Mental health's wider net, just
     because 98 happens to be one of the codes Mental health will accept. */
  var STC_GROUPS=[
    { keys:['MH','A4','BD','CF','A6','A8','AI','AJ','AK'],
      accept:['MH','96','98','A4','BD','CF','A6','A8','AI','AJ','AK'] },
    { keys:['98','96','BY','BZ'], accept:['98','96','1','BY','BZ'] },
    { keys:['47','48','50','51','52'], accept:['47','48','50','51','52'] },
    { keys:['AL','AM','AN','AO'], accept:['AL','AM','AN','AO'] },
    { keys:['ON','78','87','91'], accept:['ON','78','87','91'] },
    { keys:['PT','AE'], accept:['PT','AE'] },
    { keys:['AD'], accept:['AD','98'] },
    { keys:['AF'], accept:['AF','98'] },
    { keys:['A9','AA','AB','AC'], accept:['A9','AA','AB','AC'] },
    { keys:['93'], accept:['93','98'] },
    { keys:['3'], accept:['3','98'] },
    { keys:['9'], accept:['9','98'] },
    { keys:['AG','AH'], accept:['AG','AH'] },
    { keys:['65','BI'], accept:['65','BI'] },
    { keys:['BT','BU','BV','69'], accept:['BT','BU','BV','69'] },
    { keys:['DM','11','12','18'], accept:['DM','11','12','18'] }
  ];
  var STC_FAMILY=(function(){
    var fam={ '30':null };   /* the whole plan — do not narrow */
    STC_GROUPS.forEach(function(g){
      g.keys.forEach(function(code){
        if(!(code in fam)) fam[code]=g.accept;
      });
    });
    return fam;
  })();
  C.stcName = function(code){ return C.STC_NAMES[code]||null; };
  /* the family (array) a requested STC should also accept, or null for
     '30' (the whole plan — never narrowed), or undefined for a code with
     no defined grouping (caller should then fall back to [code] itself) */
  C.stcFamily = function(code){ return STC_FAMILY[code]; };
  /* does this benefit line's serviceTypeCodes count as a match for the
     STC actually requested? */
  C.stcMatches = function(benefitCodes, stc){
    if(!stc||stc==='30')return true;
    var codes=benefitCodes||[];
    if(!codes.length)return false;
    var fam=C.stcFamily(stc);
    if(fam===null)return true;
    fam=fam||[stc];
    return codes.some(function(c){return fam.indexOf(c)>-1;});
  };
  /* Ranks how well a benefit line's serviceTypeCodes fits the STC actually
     asked about — lower ranks first. Only meant to break a tie among lines
     that already passed stcMatches, where more than one legitimately
     qualifies: e.g. a line reported only for the exact service (['96','98'])
     alongside a payer's own combined line covering several unrelated
     services at once (['4','5','62','96','98']), or a plan-wide line that
     only qualifies because it happens to share a code (like '1') with the
     requested STC's accept list. Both are real, payer-reported numbers —
     this just decides which one actually describes the service being asked
     about.
       A line that literally carries the STC actually requested always beats
     one that only qualifies through the wider accept list — e.g. 98 (Office
     visit) and 96 (Specialist) are grouped together because a payer's copay
     for one can legitimately land under the other, but when a payer reports
     BOTH separately (a real, seen-in-production case: 96 tagged "SPECIALIST"
     at $75, 98 untagged at $35), asking for 98 must not come back with 96's
     figure just because the two tied on array length. Without this, which
     one won was pure array order — correct by luck as often as not.
       Among lines that are equally exact (or equally inexact), when a
     specific service was requested, the narrowest (smallest serviceTypeCodes)
     line is the best description of it. When nothing specific was requested
     ('30'/"All service types"), it's the reverse — the broadest line is the
     one plan-wide figure that makes sense to show, and a narrow per-service
     line would be a misleadingly specific stand-in for "the whole plan". */
  C.stcSpecificity = function(benefitCodes, stc){
    var codes=benefitCodes||[];
    var n=codes.length||999;
    if(!stc||stc==='30')return -n;
    var exact=codes.indexOf(stc)>-1;
    return (exact?0:1000)+n;
  };

  /* payers, for every picker that needs one */
  C.payers = function(){ return C._admin.payers || []; };
  C.findPayers = function(q){
    var list = C.payers();
    q = String(q||'').toLowerCase().trim();
    if(!q) return list.slice(0,40);
    return list.filter(function(p){
      return String(p.name||'').toLowerCase().indexOf(q) > -1 ||
             String(p.payer_id||'').toLowerCase().indexOf(q) === 0;
    }).slice(0,60);
  };
  /* "60054 — Aetna" for the eligibility dropdown */
  C.payerLabel = function(p){
    return (p.payer_id ? p.payer_id + ' — ' : '') + (p.name||'');
  };

  /* state name for a two-letter code, e.g. 'TX' -> 'Texas' */
  C.stateName = function(code){
    var s = C.US_STATES.filter(function(x){ return x.code === String(code||'').toUpperCase(); })[0];
    return s ? s.name : String(code||'');
  };

  /* Which payers are licensed to sell/administer plans in a given state.
     A payer with no states set at all has never been tagged one way or
     the other — treating that as "every state" (rather than hiding it the
     moment anyone filters) is what keeps every payer entered before this
     feature existed visible exactly as before. 'ALL' is the explicit,
     deliberate version of the same thing, set from the payer editor. */
  C.payersForState = function(state){
    var list = C.payers();
    if(!state) return list;
    return list.filter(function(p){
      var st = p.states;
      if(!st || !st.length) return true;
      return st.indexOf('ALL') > -1 || st.indexOf(state) > -1;
    });
  };

  /* fill any <select data-rf-codes="pos|servicetype|payer"> on the page */
  C.fillSelects = function(scope){
    (scope||document).querySelectorAll('[data-rf-codes]').forEach(function(sel){
      var kind = sel.dataset.rfCodes, keep = sel.value;
      var list = kind === 'pos' ? C.posList()
               : kind === 'servicetype' ? C.serviceTypes()
               : kind === 'payer' ? C.payers().map(function(p){
                   return { code:p.payer_id||p.name, desc:p.name, _p:p }; })
               : [];
      if(!list.length) return;
      var ph = sel.dataset.rfPlaceholder || 'Select';
      sel.innerHTML = '<option value="">'+ph+'</option>' + list.map(function(x){
        var label = kind === 'payer' ? C.payerLabel(x._p) : (x.code + ' — ' + x.desc);
        return '<option value="'+String(x.code).replace(/"/g,'&quot;')+'">'+
               String(label).replace(/</g,'&lt;')+'</option>';
      }).join('');
      if(keep) sel.value = keep;
    });
  };
})();
