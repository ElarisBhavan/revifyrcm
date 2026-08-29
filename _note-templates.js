/* ═══════════════════════════════════════════════════════════════
   RFNoteTemplates — structured progress-note templates
   One encounter -> one progress note -> one template -> many fields.
   Mirrors the note-taking pattern used by mainstream EHR/practice-
   management tools: pick a template for the visit type, fill in
   checklist + narrative fields, save as a draft, then sign & lock.
   Adding a specialty just means adding another template below —
   nothing else in the app needs to change.
   ═══════════════════════════════════════════════════════════════ */
(function(){

  var MEDICAL_NECESSITY_BH =
    'The service being offered is both necessary and suitable for treating the diagnosed condition, with the goal of alleviating symptoms, reducing functional limitations, minimizing interference with daily activities, preventing the need for hospitalization or more intensive care, or improving emotional and behavioral well-being in accordance with established standards of care.\n\n'+
    'Current level of treatment is necessary as the client continues to meet diagnostic criteria and identifies symptoms that impair functioning. Without continued care at this level the client may deteriorate, be unable to maintain improvements or continue to make gains.';

  var MEDICAL_NECESSITY_CHIRO =
    'Continued chiropractic care is medically necessary to address the diagnosed subluxation, joint dysfunction and/or soft-tissue findings documented above, reduce pain and muscle spasm, restore range of motion and function, and prevent progression to a more chronic or disabling condition, consistent with the documented treatment plan.';

  var MEDICAL_NECESSITY_MED =
    'The services rendered were medically necessary to evaluate, diagnose and manage the patient\u2019s condition, consistent with generally accepted standards of medical practice and the documented plan of care.';

  var TEMPLATES = [

    /* ── fallback, works for any specialty ── */
    {
      id:'simple_soap', name:'Simple Progress Note', specialties:[],
      sections:[
        {type:'textarea', key:'subjective', label:'Subjective', rows:4, placeholder:'What the patient reports.'},
        {type:'textarea', key:'objective', label:'Objective', rows:4, placeholder:'What was observed, measured or examined.'},
        {type:'textarea', key:'assessment', label:'Assessment \u00b7 clinical impression', rows:4, placeholder:'Clinical impression, diagnosis, response to treatment.'},
        {type:'textarea', key:'plan', label:'Plan', rows:4, placeholder:'Next steps, orders, follow-up.'}
      ]
    },

    /* ── behavioral health ── */
    {
      id:'behavioral_health', name:'Behavioral Health Progress Note', specialties:['Behavioral Health'],
      sections:[
        {type:'text', key:'session_time', label:'Session start and stop time', placeholder:'e.g. 9:00 AM \u2013 9:50 AM'},
        {type:'checkbox_group', key:'necessity_reason', label:'Reason for session duration and medical necessity', options:[
          'Rapport building with new client','Time necessary to address intense emotional content',
          'Necessary for the therapeutic intervention utilized in session','Addressing new or re-emerging symptoms',
          'Client is unable to share content with others in support system due to nature of topic',
          'Bi-weekly session, needing longer time','Monthly session to maintain acquired skills',
          'Symptoms are affecting multiple domains of life (home, school, work, relationships)',
          'Significant trauma history necessitates additional time for disclosure and containment',
          'Gathering client data from client/parent/caregiver','Prevent escalation to intensive level of care']},
        {type:'checkbox_group', key:'session_type', label:'Type of session', options:['Individual','Group','Family','Couple','Consult']},
        {type:'checkbox_group', key:'therapy_delivered', label:'Therapy delivered', options:[
          'In person','Telehealth audio & visual \u2014 client at home','Telehealth audio & visual \u2014 client at other location']},
        {type:'checkbox_group', key:'telehealth_consents', label:'Telehealth consents', options:[
          'Client consents to treatment by telehealth platform',
          'Client acknowledges the limits of confidentiality for telehealth treatment',
          'Clinician and client have agreed upon an emergency plan and a disconnect plan']},
        {type:'checkbox_group', key:'others_present', label:'Additional individuals present', options:[
          'None','Parent(s)','Spouse','Sibling','Other']},
        {type:'checkbox_group', key:'mood', label:'Mood', options:[
          'Euthymic','Happy/cheerful','Calm/serene','Sad/depressed','Anxious','Angry','Irritable','Tearful/upset','Other']},
        {type:'checkbox_group', key:'behavior', label:'Behavior', options:[
          'Appropriate/cooperative','Aggressive','Hyperactive','Defiant','Disrespectful','Agitated','Guarded/nervous','Uncooperative']},
        {type:'checkbox_group', key:'speech', label:'Speech', options:['Normal','Slow','Rapid','Disorganized','Quiet']},
        {type:'checkbox_group', key:'presenting_issues', label:'Presenting issues', options:[
          'ADHD/ADD','Adjusting to change','Anger','Anxiety','Body image','Depression','Disruptive behavior',
          'Executive functioning deficits','Family relationships','Grief','Parenting','Poor concentration',
          'School/academics','Self-esteem','Social relationships','Trauma history','Stress']},
        {type:'textarea', key:'presenting_notes', label:'Presenting issue notes', rows:3},
        {type:'checkbox_group', key:'interventions', label:'Therapeutic interventions', options:[
          'Accelerated Resolution Therapy (ART)','CBT','Child-Parent Relationship Therapy/Training (CPRT)','DBT','EMDR',
          'Goal setting','Gottman','Internal Family Systems','Motivational interviewing','Person-centered',
          'Play therapy','Parent consult/coaching','Psycho-education','Solution-focused therapy','Skill development']},
        {type:'textarea', key:'intervention_notes', label:'Intervention notes (what happened in session, client response)', rows:3},
        {type:'checkbox_group', key:'risk', label:'Risk assessment', options:[
          'None','Suicidal ideation (passive)','Suicidal ideation (active)','Self-harm ideation (passive)',
          'Self-harm ideation (active)','Runaway','Substance use','Homicidal ideation','Delusions','Intent','Means','Access','Plan']},
        {type:'checkbox_group', key:'medication', label:'Medication', options:[
          'None','No change from previous medication report','Change']},
        {type:'radio_group', key:'progress', label:'Progress toward goals/objectives', options:[
          'None','Worse','Slight','Moderate','Significant','Stable']},
        {type:'textarea', key:'self_report', label:'Self-report of progress towards goals/objectives', rows:3},
        {type:'radio_group', key:'next_session', label:'Next session', options:[
          '1 week','2 weeks','Next month','This is the last session','Other']},
        {type:'static', key:'medical_necessity', label:'Medical necessity', body:MEDICAL_NECESSITY_BH}
      ]
    },

    /* ── chiropractic ── */
    {
      id:'chiropractic', name:'Chiropractic SOAP Note', specialties:['Chiropractic'],
      sections:[
        {type:'radio_group', key:'visit_type', label:'Visit type', options:['Initial visit','Re-exam','Routine adjustment','Discharge visit']},
        {type:'checkbox_group', key:'chief_complaint', label:'Chief complaint / region', options:[
          'Cervical','Thoracic','Lumbar','Sacroiliac','Extremity \u2014 upper','Extremity \u2014 lower','Headache','Other']},
        {type:'radio_group', key:'symptom_change', label:'Symptom change since last visit', options:['Improved','Same','Worse','New complaint']},
        {type:'text', key:'pain_scale', label:'Pain scale (0\u201310)', placeholder:'e.g. 4/10'},
        {type:'textarea', key:'subjective_notes', label:'Subjective \u2014 history, symptoms, aggravating/relieving factors', rows:3},
        {type:'checkbox_group', key:'exam_findings', label:'Objective \u2014 exam findings', options:[
          'Postural asymmetry','Muscle spasm/hypertonicity','Tenderness to palpation','Decreased range of motion',
          'Positive orthopedic test','Positive neurological test','Edema/inflammation','Antalgia']},
        {type:'checkbox_group', key:'spinal_levels', label:'Spinal levels/segments involved', options:[
          'Occiput/C1','C2\u2013C4','C5\u2013C7','T1\u2013T4','T5\u2013T8','T9\u2013T12','L1\u2013L3','L4\u2013L5','Sacrum/SI joint','Pelvis']},
        {type:'textarea', key:'objective_notes', label:'Additional objective notes', rows:3},
        {type:'textarea', key:'assessment', label:'Assessment \u2014 clinical impression / diagnosis', rows:3},
        {type:'checkbox_group', key:'technique', label:'Adjustment technique', options:[
          'Diversified','Gonstead','Activator','Thompson drop','Flexion-distraction','SOT','Extremity adjustment']},
        {type:'checkbox_group', key:'modalities', label:'Modalities/therapies performed', options:[
          'Electrical stimulation','Ultrasound','Heat/cold therapy','Mechanical traction','Therapeutic exercise',
          'Manual therapy/soft tissue','Kinesio taping']},
        {type:'textarea', key:'home_care', label:'Home care / exercise instructions', rows:2},
        {type:'radio_group', key:'response_to_care', label:'Response to today\u2019s treatment', options:[
          'Tolerated well','Mild soreness expected','Adverse reaction \u2014 see notes']},
        {type:'radio_group', key:'progress', label:'Progress toward treatment-plan goals', options:[
          'None','Minimal','Moderate','Significant','Goals met']},
        {type:'radio_group', key:'next_visit', label:'Next visit', options:[
          '1\u20132 days','Within 1 week','2 weeks','Re-evaluate in 30 days','Discharge']},
        {type:'static', key:'medical_necessity', label:'Medical necessity', body:MEDICAL_NECESSITY_CHIRO}
      ]
    },

    /* ── general medical / primary care and most physician specialties ── */
    {
      id:'general_medical', name:'Medical SOAP Note',
      specialties:['Family Medicine','Internal Medicine','Pediatrics','Cardiology','Endocrinology','Orthopedics',
        'Obstetrics and Gynecology','Urgent Care','Primary Care'],
      sections:[
        {type:'text', key:'chief_complaint', label:'Chief complaint', placeholder:'Reason for visit, in the patient\u2019s words'},
        {type:'text', key:'vitals', label:'Vitals', placeholder:'BP, HR, Temp, RR, SpO2, Wt, Ht, BMI'},
        {type:'textarea', key:'hpi', label:'History of present illness (Subjective)', rows:3},
        {type:'checkbox_group', key:'ros', label:'Review of systems', options:[
          'Constitutional','Cardiovascular','Respiratory','GI','GU','Musculoskeletal','Neurological','Skin',
          'Psychiatric','Endocrine','All systems reviewed and negative except as noted']},
        {type:'textarea', key:'exam', label:'Physical exam (Objective)', rows:3},
        {type:'textarea', key:'assessment', label:'Assessment \u2014 diagnosis / clinical impression', rows:3},
        {type:'textarea', key:'plan', label:'Plan \u2014 treatment, medications, orders, referrals', rows:3},
        {type:'checkbox_group', key:'patient_education', label:'Patient education / counseling provided', options:[
          'Diagnosis and prognosis discussed','Medication instructions given','Diet/lifestyle counseling',
          'Return precautions reviewed','Follow-up plan discussed']},
        {type:'radio_group', key:'follow_up', label:'Follow up', options:[
          '1 week','2\u20134 weeks','3 months','6 months','PRN / as needed']},
        {type:'static', key:'medical_necessity', label:'Medical necessity', body:MEDICAL_NECESSITY_MED}
      ]
    }
  ];

  function byId(id){ return TEMPLATES.filter(function(t){return t.id===id;})[0] || TEMPLATES[0]; }

  /* Default template for a provider's specialty; falls back to the simple note. */
  function forSpecialty(specialty){
    var hit = TEMPLATES.filter(function(t){
      return (t.specialties||[]).some(function(s){ return s.toLowerCase()===String(specialty||'').toLowerCase(); });
    })[0];
    return hit ? hit.id : 'simple_soap';
  }

  function esc(v){ return String(v==null?'':v).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  /* fieldId: stable, unique per template+section so the DOM can be read back reliably */
  function fid(tpl,key){ return 'ntf_'+tpl.id+'_'+key; }

  /* ── build the editable form for a template, pre-filled from `answers` ── */
  function renderForm(tpl, answers, locked){
    answers = answers || {};
    return tpl.sections.map(function(sec){
      var val = answers[sec.key];
      if(sec.type==='text'){
        return '<label class="f ntf-field"><span>'+esc(sec.label)+'</span>'+
          '<input type="text" id="'+fid(tpl,sec.key)+'" data-ntkey="'+sec.key+'" value="'+esc(val||'')+'" '+
          (sec.placeholder?'placeholder="'+esc(sec.placeholder)+'" ':'')+(locked?'readonly':'')+'></label>';
      }
      if(sec.type==='textarea'){
        return '<label class="f ntf-field full"><span>'+esc(sec.label)+'</span>'+
          '<textarea id="'+fid(tpl,sec.key)+'" data-ntkey="'+sec.key+'" rows="'+(sec.rows||3)+'" '+
          (sec.placeholder?'placeholder="'+esc(sec.placeholder)+'" ':'')+(locked?'readonly':'')+'>'+esc(val||'')+'</textarea></label>';
      }
      if(sec.type==='checkbox_group' || sec.type==='radio_group'){
        var isRadio = sec.type==='radio_group';
        var selected = isRadio ? val : (Array.isArray(val)?val:[]);
        var groupName = fid(tpl,sec.key);
        var opts = sec.options.map(function(o,i){
          var checked = isRadio ? (selected===o) : selected.indexOf(o)>-1;
          return '<label class="chk'+(locked?' ro':'')+'"><input type="'+(isRadio?'radio':'checkbox')+'" '+
            'name="'+groupName+'" data-ntkey="'+sec.key+'" value="'+esc(o)+'" '+(checked?'checked':'')+' '+(locked?'disabled':'')+'>'+
            '<span class="bx"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></span>'+esc(o)+'</label>';
        }).join('');
        return '<div class="ntf-group full"><b>'+esc(sec.label)+'</b><div class="ntf-options">'+opts+'</div></div>';
      }
      if(sec.type==='static'){
        return '<div class="ntf-group full ntf-static"><b>'+esc(sec.label)+'</b><p>'+esc(sec.body).replace(/\n/g,'<br>')+'</p></div>';
      }
      return '';
    }).join('');
  }

  /* ── read the current DOM state of a rendered form back into an answers object ── */
  function collectForm(tpl, root){
    var answers = {};
    tpl.sections.forEach(function(sec){
      if(sec.type==='text' || sec.type==='textarea'){
        var el = root.querySelector('#'+fid(tpl,sec.key));
        answers[sec.key] = el ? el.value.trim() : '';
      } else if(sec.type==='radio_group'){
        var picked = root.querySelector('input[name="'+fid(tpl,sec.key)+'"]:checked');
        answers[sec.key] = picked ? picked.value : '';
      } else if(sec.type==='checkbox_group'){
        var boxes = root.querySelectorAll('input[name="'+fid(tpl,sec.key)+'"]:checked');
        answers[sec.key] = Array.prototype.map.call(boxes, function(b){ return b.value; });
      }
    });
    return answers;
  }

  /* True once at least one field carries real content \u2014 used to stop an
     empty note from being signed. */
  function hasContent(tpl, answers){
    answers = answers || {};
    return tpl.sections.some(function(sec){
      if(sec.type==='static') return false;
      var v = answers[sec.key];
      if(Array.isArray(v)) return v.length>0;
      return !!(v && String(v).trim());
    });
  }

  /* ── read-only rendering, used once a note is signed & locked ── */
  function renderReadOnly(tpl, answers){
    answers = answers || {};
    var parts = tpl.sections.map(function(sec){
      var v = answers[sec.key];
      var display;
      if(sec.type==='static'){ display = esc(sec.body).replace(/\n/g,'<br>'); }
      else if(Array.isArray(v)){ if(!v.length) return ''; display = v.map(esc).join(', '); }
      else { if(!v) return ''; display = esc(v).replace(/\n/g,'<br>'); }
      return '<div class="ntv-row"><b>'+esc(sec.label)+'</b><p>'+display+'</p></div>';
    }).filter(Boolean);
    return parts.join('');
  }

  window.RFNoteTemplates = {
    list: TEMPLATES,
    byId: byId,
    forSpecialty: forSpecialty,
    renderForm: renderForm,
    collectForm: collectForm,
    renderReadOnly: renderReadOnly,
    hasContent: hasContent
  };
})();
