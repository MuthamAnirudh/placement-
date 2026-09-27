/* Campus Portal Advanced Runtime v24
 * Existing-surface enhancement only. No new tabs, navigation, or visible feature area.
 * Adds an application-shell worker, predictive resource warming, request observability,
 * crash-safe snapshots, client-side performance budgets, and guarded service-worker caching.
 */
(function(){
  'use strict';
  if(window.__CP_ADVANCED_V24__) return;
  window.__CP_ADVANCED_V24__ = true;
  const VERSION='24.0.0';
  const NS='cp:v24:';
  const state={version:VERSION,startedAt:performance.now(),requests:0,failures:0,slow:0,cacheHits:0,online:navigator.onLine};
  const now=()=>performance.now();
  const uuid=()=>crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const emit=(name,detail={})=>window.dispatchEvent(new CustomEvent(name,{detail}));

  // Dedicated worker for CPU-heavy, non-UI operations. It never owns application state.
  let worker=null;
  try{worker=new Worker('/advanced-v24.worker.js',{name:'campus-runtime-v24'});}catch(_){worker=null;}
  const workerCall=(type,payload)=>new Promise((resolve,reject)=>{
    if(!worker) return reject(new Error('worker unavailable'));
    const id=uuid(); const timer=setTimeout(()=>{cleanup();reject(new Error('worker timeout'));},5000);
    const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('message',on)};
    const on=e=>{if(e.data?.id!==id)return;cleanup();e.data.ok?resolve(e.data.value):reject(new Error(e.data.error||'worker error'))};
    worker.addEventListener('message',on);worker.postMessage({id,type,payload});
  });
  window.CampusPortalAdvancedV24={version:VERSION,diagnostics:()=>({...state,uptimeMs:Math.round(now()-state.startedAt)})};

  // High-resolution fetch telemetry. Existing contracts and payloads are untouched.
  const originalFetch=window.fetch.bind(window);
  window.fetch=async function(input,init={}){
    const t=now(); const method=String(init.method||'GET').toUpperCase();
    const url=(()=>{try{return new URL(typeof input==='string'?input:input.url,location.href)}catch(_){return null}})();
    const api=!!url && url.origin===location.origin && url.pathname.startsWith('/api/');
    if(!api) return originalFetch(input,init);
    state.requests++;
    const headers=new Headers(init.headers||{});
    headers.set('X-Client-Runtime',VERSION);
    headers.set('X-Request-ID',headers.get('X-Request-ID')||uuid());
    try{
      const response=await originalFetch(input,{...init,headers});
      const ms=now()-t;
      if(ms>1200) state.slow++;
      if(!response.ok) state.failures++;
      emit('cp:v24-request',{method,url:url.pathname,status:response.status,duration:Math.round(ms)});
      return response;
    }catch(err){state.failures++;emit('cp:v24-request',{method,url:url.pathname,error:true,duration:Math.round(now()-t)});throw err;}
  };

  // Performance budgets: report only; never block an existing feature.
  try{
    const po=new PerformanceObserver(list=>{
      for(const e of list.getEntries()){
        if(e.duration>50) emit('cp:v24-long-task',{duration:Math.round(e.duration),name:e.name});
      }
    });
    po.observe({type:'longtask',buffered:true});
  }catch(_){ }
  try{
    new PerformanceObserver(list=>{
      for(const e of list.getEntries()) if(e.value>0.1) emit('cp:v24-layout-shift',{value:e.value});
    }).observe({type:'layout-shift',buffered:true});
  }catch(_){ }

  // Predictive warming: only same-origin GET links, only when the browser is idle.
  const warmed=new Set();
  const warm=(href)=>{
    try{
      const u=new URL(href,location.href); if(u.origin!==location.origin||u.pathname.startsWith('/api/')) return;
      if(warmed.has(u.href)||document.visibilityState!=='visible') return;
      warmed.add(u.href); const l=document.createElement('link');l.rel='prefetch';l.href=u.href;l.as='document';document.head.appendChild(l);
    }catch(_){ }
  };
  const observeNav=()=>document.querySelectorAll('a[href]').forEach(a=>{
    if(a.dataset.cpV24Observed) return; a.dataset.cpV24Observed='1';
    a.addEventListener('pointerenter',()=>warm(a.href),{once:true,passive:true});
    a.addEventListener('focus',()=>warm(a.href),{once:true,passive:true});
  });
  const schedule=window.requestIdleCallback||((fn)=>setTimeout(fn,900));
  schedule(observeNav);
  new MutationObserver(()=>schedule(observeNav)).observe(document.documentElement,{subtree:true,childList:true});

  // Crash-safe snapshots for existing form controls. Passwords and sensitive token fields excluded.
  const SNAP='CP_V24_FORM_SNAPSHOT';
  const sensitive=/pass|token|secret|api.?key|authorization/i;
  const collect=()=>{
    const data={};
    document.querySelectorAll('input,textarea,select').forEach((el,i)=>{
      const key=el.name||el.id||`field-${i}`; if(!key||sensitive.test(key)||el.type==='password')return;
      if(el.type==='checkbox'||el.type==='radio')data[key]={type:el.type,value:el.value,checked:el.checked};
      else data[key]={type:el.tagName.toLowerCase(),value:el.value};
    });
    return data;
  };
  let snapTimer;
  const snapshot=()=>{try{sessionStorage.setItem(SNAP,JSON.stringify({at:Date.now(),path:location.pathname,data:collect()}));}catch(_){} };
  document.addEventListener('input',()=>{clearTimeout(snapTimer);snapTimer=setTimeout(snapshot,700)},true);
  addEventListener('pagehide',snapshot);

  // Online state and peer synchronization.
  const bc='BroadcastChannel' in window?new BroadcastChannel('campus-portal-v24'):null;
  const publish=()=>{state.online=navigator.onLine;try{sessionStorage.setItem(NS+'heartbeat',String(Date.now()));}catch(_){};bc?.postMessage({type:'heartbeat',version:VERSION,online:state.online})};
  addEventListener('online',publish);addEventListener('offline',publish);publish();
  bc&&(bc.onmessage=e=>{if(e.data?.type==='heartbeat')emit('cp:v24-peer',e.data)});

  // Service worker is strictly an enhancement: failure never affects application startup.
  if('serviceWorker' in navigator){
    addEventListener('load',()=>navigator.serviceWorker.register('/advanced-v24.sw.js',{scope:'/'}).then(reg=>{
      emit('cp:v24-sw',{state:reg.active?'active':'registered'});
    }).catch(()=>{}),{once:true});
  }

  // Worker-backed hashing for existing export/import code that wants a stable fingerprint.
  window.CampusPortalAdvancedV24.hash=async(value)=>workerCall('sha256',String(value));
  emit('cp:v24-ready',{version:VERSION});
})();
