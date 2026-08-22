/* Electronic remittance (835) from Stedi.
   Lists what the payer has sent, and returns one in a shape the application
   can post against its encounters. Posting itself happens in the browser,
   against the same billing fields a person would edit by hand. */

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': process.env.SITE_URL || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

const BASE = process.env.STEDI_REPORTS_URL ||
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2';

function apiKey(){
  return String(process.env.STEDI_API_KEY || '')
    .trim().replace(/^["']|["']$/g,'').trim().replace(/^Bearer\s+/i,'');
}

const money = v => Math.round((Number(v)||0) * 100) / 100;
const d8 = v => {
  const s = String(v||'').replace(/\D/g,'');
  return s.length===8 ? s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8) : '';
};

/* Reduce a remittance to what actually posts: per claim, what the payer
   allowed, paid, adjusted, and left with the patient. */
function summarise(era){
  const out = {
    payer: (era.payer && (era.payer.name || era.payer.organizationName)) || '',
    payment_method: era.paymentMethod || era.paymentMethodCode || '',
    reference: era.checkNumber || era.traceNumber || era.checkOrEFTTraceNumber || '',
    paid_on: d8(era.paymentEffectiveDate || era.checkIssueOrEFTEffectiveDate || era.productionDate),
    total_paid: money(era.totalActualProviderPaymentAmount || era.paymentAmount),
    claims: []
  };

  const claims = era.claims || era.claimPayments ||
    (era.detailInfo || []).flatMap(d => d.paymentInfo || d.claims || []) || [];

  claims.forEach(c => {
    const paid = money(c.claimPaymentAmount || c.paidAmount);
    const charge = money(c.totalClaimChargeAmount || c.chargeAmount);
    const patient = money(c.patientResponsibilityAmount);

    /* Adjustments explain the gap between charged and paid. Contractual
       write-offs (group CO) are ours to absorb; the rest are not. */
    let contractual = 0, otherAdj = 0;
    const adjustments = [];
    (c.claimAdjustments || []).forEach(a => {
      const grp = String(a.claimAdjustmentGroupCode || a.adjustmentGroupCode || '').toUpperCase();
      (a.adjustmentDetails || a.adjustments || [a]).forEach(d => {
        const amt = money(d.adjustmentAmount || d.amount);
        if(!amt) return;
        if(grp === 'CO') contractual += amt; else otherAdj += amt;
        adjustments.push({ group:grp, reason:String(d.adjustmentReasonCode || d.reasonCode || ''), amount:amt });
      });
    });

    out.claims.push({
      patient_control_number: c.patientControlNumber || c.claimNumber || '',
      payer_claim_number: c.payerClaimControlNumber || '',
      status: c.claimStatusCode || c.statusCode || '',
      charge, paid,
      patient_responsibility: patient,
      contractual: money(contractual),
      other_adjustments: money(otherAdj),
      adjustments,
      patient: [c.patientName && c.patientName.lastName, c.patientName && c.patientName.firstName]
        .filter(Boolean).join(', '),
      service_lines: (c.serviceLines || c.serviceLineInfo || []).map(l => ({
        cpt: (l.servicePaymentInformation && l.servicePaymentInformation.procedureCode) ||
             l.procedureCode || '',
        charge: money(l.lineItemChargeAmount || (l.servicePaymentInformation||{}).lineItemChargeAmount),
        paid: money(l.lineItemProviderPaymentAmount || (l.servicePaymentInformation||{}).lineItemProviderPaymentAmount),
        date: d8(l.serviceDate)
      }))
    });
  });

  return out;
}

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode:204, headers:CORS, body:'' };

  const key = apiKey();
  if(!key) return { statusCode:503, headers:CORS, body: JSON.stringify({
    error:'not_configured', message:'STEDI_API_KEY is not set on this deployment.' }) };

  const qs = event.queryStringParameters || {};
  const action = (qs.action || 'list').toLowerCase();

  try{
    /* What the nightly job has already collected. The page reads this first,
       so remittances are there on opening rather than after a wait. */
    if(action === 'waiting'){
      let store;
      try{ store = await require('./_queue-store.js').open(); }
      catch(e){ return { statusCode:200, headers:CORS, body: JSON.stringify({
        ok:true, collected:[], note:'No storage configured; use Check for remittances.' }) }; }

      const keys = await store.list();
      const out = [];
      for(const k of keys){
        if(String(k).indexOf('era_') !== 0) continue;
        const v = await store.get(k).catch(()=>null);
        if(v && v.status === 'waiting') out.push({ key:k, ...v });
      }
      out.sort((a,b) => String(b.collected_at||'').localeCompare(String(a.collected_at||'')));
      return { statusCode:200, headers:CORS, body: JSON.stringify({
        ok:true, count:out.length, collected:out }) };
    }

    /* mark one as dealt with, so it stops being offered */
    if(action === 'done'){
      const k = (event.queryStringParameters||{}).key;
      if(!k) return { statusCode:400, headers:CORS, body: JSON.stringify({ error:'no_key' }) };
      try{
        const store = await require('./_queue-store.js').open();
        const v = await store.get(k);
        if(v){ v.status = 'posted'; v.posted_at = new Date().toISOString(); await store.set(k, v); }
      }catch(e){}
      return { statusCode:200, headers:CORS, body: JSON.stringify({ ok:true }) };
    }

    /* which remittances are waiting */
    if(action === 'list'){
      const r = await fetch(BASE + '?reportTypeCode=835', {
        headers:{ 'Authorization': key }
      });
      const text = await r.text();
      let data = {}; try{ data = JSON.parse(text); }catch{ data = { raw:text.slice(0,300) }; }
      if(!r.ok) return { statusCode:r.status, headers:CORS, body: JSON.stringify({
        error:'stedi', status:r.status, message:data.message || data.error || 'Could not list remittances',
        raw:data.raw }) };

      const reports = data.reports || data.items || [];
      return { statusCode:200, headers:CORS, body: JSON.stringify({
        ok:true, count:reports.length,
        reports: reports.map(x => ({
          id: x.reportId || x.fileName || x.id,
          received: x.receivedDate || x.createdAt,
          payer: x.payerName || '',
          type: x.reportTypeCode || '835'
        })) }) };
    }

    /* one remittance, reduced to what posts */
    if(action === 'get'){
      const id = qs.id;
      if(!id) return { statusCode:400, headers:CORS, body: JSON.stringify({ error:'no_id' }) };

      const r = await fetch(BASE + '/' + encodeURIComponent(id) + '/835', {
        headers:{ 'Authorization': key }
      });
      const text = await r.text();
      let data = {}; try{ data = JSON.parse(text); }catch{ data = { raw:text.slice(0,400) }; }
      if(!r.ok) return { statusCode:r.status, headers:CORS, body: JSON.stringify({
        error:'stedi', status:r.status,
        message:data.message || data.error || 'Could not fetch the remittance',
        raw:data.raw }) };

      return { statusCode:200, headers:CORS, body: JSON.stringify({
        ok:true, remittance: summarise(data), raw: qs.raw ? data : undefined }) };
    }

    return { statusCode:400, headers:CORS, body: JSON.stringify({ error:'Unknown action' }) };
  }catch(err){
    return { statusCode:502, headers:CORS, body: JSON.stringify({
      error:'upstream', message:String(err.message || err) }) };
  }
};

module.exports.summarise = summarise;
