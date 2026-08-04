/* Shows the signed-in person on every provider page and guards access. */
(function(){
  function paint(){
    var s=null;
    try{s=JSON.parse(sessionStorage.getItem('rf_session')||'null');}catch(e){}
    if(!s){
      if(!/provider-login|admin-login|reviflow|index|resources|insights/i.test(location.pathname)){
        location.href=(location.pathname.indexOf('/Patient/')>-1?'../Provider/':'')+'provider-login.html';
      }
      return;
    }
    var ROLE={admin:'Administrator',supervisor:'Supervisor / Practice Manager',
              provider:'Provider',scheduler:'Scheduler',employee:'Employee'};
    var name=[s.first,s.last].filter(Boolean).join(' ')||s.name||s.username;

    document.querySelectorAll('[data-me-name]').forEach(function(el){el.textContent=name;});
    document.querySelectorAll('[data-me-role]').forEach(function(el){
      el.textContent=(ROLE[s.role]||s.role)+(s.title?' · '+s.title:'');});
    document.querySelectorAll('[data-me-initials]').forEach(function(el){
      el.textContent=s.initials||name.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();});

    // fill the identity slot on any page that has the header pattern
    var slot=document.getElementById('rfWho');
    if(slot&&!slot.dataset.done){
      slot.dataset.done='1';
      slot.innerHTML='<span class="rf-av">'+
        (s.initials||name.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase())+
        '</span><span class="rf-id"><b>'+name+'</b><small>'+(ROLE[s.role]||s.role)+'</small></span>';
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',paint);
  else paint();
  window.RFSession={
    get:function(){try{return JSON.parse(sessionStorage.getItem('rf_session')||'null');}catch(e){return null;}},
    out:function(){sessionStorage.removeItem('rf_session');}
  };
})();
