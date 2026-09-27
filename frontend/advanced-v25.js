/* Campus Portal Advanced Runtime v25
 * Existing-surface enhancement only. No new tabs, navigation, or visible feature area.
 * Adds deterministic request deduplication, adaptive resource scheduling, tab-state
 * continuity, cross-tab leadership, and resilient runtime diagnostics.
 */
(function(){
  'use strict';
  if(window.__CP_ADVANCED_V25__) return;
  window.__CP_ADVANCED_V25__ = true;
  const VERSION='25.0.0';
  const KEY='cp:v25:';
  const started=performance.now();
  const state={version:VERSION,requests:0,deduped:0,failures:0,slow:0,online:navigator.onLine,
    visible:document.visibilityState==='visible',leader:false,tabTransitions:0,layoutShifts:0,longTasks:0};
  const pendingGET=new Map();
  const emit=(name,detail={})=>window.dispatchEvent(new CustomEvent(name,{detail}));
  const id=()=>crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const adaptive=()=>{
    const c=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
    const save=!!(c?.saveData);
    const slow=/2g|slow-2g/.test(c?.effectiveType||'');
    return {save,slow,type:c?.effectiveType||'unknown',cores:navigator.hardwareConcurrency||2};
  };

  // Deduplicate concurrent same-origin GET API calls without changing response contracts.
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init={}){
    const method=String(init.method||((input&&input.method)||'GET')).toUpperCase();
    let url;
    try{url=new URL(typeof input==='string'?input:input.url,location.href)}catch(_){return nativeFetch(input,init)}
    const api=url.origin===location.origin&&url.pathname.startsWith('/api/');
    if(!api||method!=='GET'||init.signal) return nativeFetch(input,init);
    const key=`${method} ${url.href}`;
    if(pendingGET.has(key)){
      state.deduped++;
      const base=await pendingGET.get(key);
      return base.clone();
    }
    state.requests++;
    const headers=new Headers(init.headers||{});
    headers.set('X-Client-Runtime',VERSION);
    headers.set('X-Request-ID',headers.get('X-Request-ID')||id());
    const startedAt=performance.now();
    const promise=nativeFetch(input,{...init,headers}).then(res=>{
      const ms=performance.now()-startedAt;
      if(ms>1500)state.slow++;
      if(!res.ok)state.failures++;
      emit('cp:v25-request',{method,url:url.pathname,status:res.status,duration:Math.round(ms)});
      return res;
    }).catch(err=>{state.failures++;emit('cp:v25-request',{method,url:url.pathname,error:true});throw err;});
    pendingGET.set(key,promise);
    try{return (await promise).clone()}finally{pendingGET.delete(key)}
  };

  // Preserve scroll position per existing route. This does not alter navigation.
  const scrollKey=()=>`${KEY}scroll:${location.pathname}${location.search}`;
  const saveScroll=()=>{try{sessionStorage.setItem(scrollKey(),String(Math.round(scrollY)))}catch(_){} };
  addEventListener('scroll',()=>{
    clearTimeout(saveScroll.t); saveScroll.t=setTimeout(saveScroll,180);
  },{passive:true});
  addEventListener('pagehide',saveScroll);
  addEventListener('load',()=>{
    try{const y=Number(sessionStorage.getItem(scrollKey()));if(Number.isFinite(y)&&y>20)setTimeout(()=>scrollTo({top:y,behavior:'instant'}),80)}catch(_){}
  },{once:true});

  // Adaptive resource scheduler: defer non-critical media on constrained connections.
  const tuneMedia=()=>{
    const net=adaptive();
    document.querySelectorAll('img[loading="eager"]').forEach((img,i)=>{
      if(i>2&&(net.save||net.slow))img.loading='lazy';
    });
    document.querySelectorAll('video').forEach(v=>{if(net.save||net.slow){v.preload='metadata';}});
    emit('cp:v25-network',net);
  };
  tuneMedia();
  addEventListener('online',()=>{state.online=true;tuneMedia();emit('cp:v25-online',{online:true})});
  addEventListener('offline',()=>{state.online=false;emit('cp:v25-online',{online:false})});
  addEventListener('visibilitychange',()=>{state.visible=document.visibilityState==='visible';emit('cp:v25-visibility',state.visible)});

  // Cross-tab single-leader coordination for maintenance work.
  let channel=null;
  try{channel=new BroadcastChannel('campus-portal-v25');}catch(_){channel=null}
  const claim=()=>{
    const token=id();
    try{localStorage.setItem(KEY+'leader',JSON.stringify({token,at:Date.now()}))}catch(_){}
    state.leader=true;
    channel?.postMessage({type:'leader-claim',token,at:Date.now()});
  };
  const evaluateLeader=()=>{
    try{
      const current=JSON.parse(localStorage.getItem(KEY+'leader')||'null');
      if(!current||Date.now()-current.at>8000)claim();
      else state.leader=false;
    }catch(_){state.leader=true}
  };
  evaluateLeader();
  setInterval(()=>{if(state.leader){try{localStorage.setItem(KEY+'leader',JSON.stringify({token:'active',at:Date.now()}))}catch(_){} }else evaluateLeader()},4000);
  addEventListener('storage',e=>{if(e.key===KEY+'leader')evaluateLeader()});
  channel&&(channel.onmessage=e=>{if(e.data?.type==='leader-claim'&&e.data.token!=='active')state.leader=false});

  // Observe existing navigation labels/classes and retain a lightweight transition history.
  const transitions=[]; const navHistory=()=>{
    const active=document.querySelector('[aria-current="page"],button[aria-selected="true"]');
    const label=(active?.textContent||'').trim().replace(/\s+/g,' ').slice(0,100);
    if(!label)return;
    const last=transitions[transitions.length-1];
    if(!last||last.label!==label){transitions.push({label,at:Date.now()});if(transitions.length>30)transitions.shift();state.tabTransitions++;try{sessionStorage.setItem(KEY+'navigation',JSON.stringify(transitions))}catch(_){};emit('cp:v25-navigation',{label})}
  };
  new MutationObserver(navHistory).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-current','aria-selected','class']});
  setTimeout(navHistory,500);

  // Runtime performance signals remain observational and never block an existing feature.
  try{new PerformanceObserver(list=>{for(const e of list.getEntries()){if(e.duration>50){state.longTasks++;emit('cp:v25-long-task',{duration:Math.round(e.duration)})}}}).observe({type:'longtask',buffered:true})}catch(_){}
  try{new PerformanceObserver(list=>{for(const e of list.getEntries()){if(e.value>.1){state.layoutShifts+=e.value;emit('cp:v25-layout-shift',{value:e.value})}}}).observe({type:'layout-shift',buffered:true})}catch(_){}

  window.CampusPortalAdvancedV25={version:VERSION,diagnostics:()=>({...state,uptimeMs:Math.round(performance.now()-started),network:adaptive(),pendingGets:pendingGET.size})};
  emit('cp:v25-ready',{version:VERSION});
})();
