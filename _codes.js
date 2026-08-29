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
