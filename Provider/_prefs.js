/* ReviFlow shared preferences — applied on every provider page */
(function(){
  var K='rf_prefs';
  function read(){try{return JSON.parse(localStorage.getItem(K)||'{}');}catch(e){return {};}}
  function hex(c){return [parseInt(c.substr(1,2),16),parseInt(c.substr(3,2),16),parseInt(c.substr(5,2),16)];}
  function shade(c,p){var r=hex(c);return 'rgb('+r.map(function(v){return Math.max(0,Math.min(255,Math.round(v+p)));}).join(',')+')';}
  function tint(c,a){var r=hex(c);return 'rgb('+r.map(function(v){return Math.round(v+(255-v)*a);}).join(',')+')';}

  window.RFPrefs={
    get:read,
    save:function(p){var m=read();for(var k in p)m[k]=p[k];localStorage.setItem(K,JSON.stringify(m));this.apply();return m;},
    apply:function(){
      var p=read(),r=document.documentElement;
      if(p.accent){
        ['--green','--accent'].forEach(function(v){r.style.setProperty(v,p.accent);});
        ['--green-d','--accent-deep'].forEach(function(v){r.style.setProperty(v,shade(p.accent,-34));});
        ['--green-s','--accent-soft'].forEach(function(v){r.style.setProperty(v,tint(p.accent,.88));});
      }
      r.style.fontSize = p.largeText ? '18px' : '';
      document.body && document.body.classList.toggle('rf-large', !!p.largeText);
      if(p.reduceMotion){r.setAttribute('data-rf-reduce','1');}else{r.removeAttribute('data-rf-reduce');}
      if(p.density){r.setAttribute('data-rf-density',p.density);}
    }
  };
  RFPrefs.apply();
  document.addEventListener('DOMContentLoaded',function(){RFPrefs.apply();});
  window.addEventListener('storage',function(e){if(e.key===K)RFPrefs.apply();});
})();
