/* Campus Portal Advanced Runtime v22
 * Additive only: strengthens existing tabs/features without creating navigation.
 */
(function(){
  'use strict';
  if(window.__CP_ADVANCED_V22__) return;
  window.__CP_ADVANCED_V22__ = true;

  const VERSION='22.0.0';
  const DB_NAME='campus_portal_runtime';
  const DB_VERSION=1;
  const CACHE_STORE='http_cache';
  const STATE_KEY='CP_V22_STATE';
  const MAX_CACHE=120;
  const TTL=5*60*1000;
  const state=(()=>{try{return JSON.parse(localStorage.getItem(STATE_KEY)||'{}')}catch(_){return {}}})();
  state.version=VERSION; state.sessions=(state.sessions||0)+1; state.startedAt=Date.now();
  try{localStorage.setItem(STATE_KEY,JSON.stringify(state))}catch(_){}

  const emit=(name,detail={})=>{try{window.dispatchEvent(new CustomEvent(name,{detail}))}catch(_){}};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const redact=s=>String(s||'').replace(/(authorization|token|password|secret|api[-_]?key|cookie)=?[^&\s]+/gi,'$1=[redacted]');

  // ---------- IndexedDB cache for existing GET requests ----------
  let dbPromise;
  function db(){
    if(dbPromise) return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      if(!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const r=indexedDB.open(DB_NAME,DB_VERSION);
      r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains(CACHE_STORE)){const s=d.createObjectStore(CACHE_STORE,{keyPath:'key'});s.createIndex('updatedAt','updatedAt')}};
      r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
    });
    return dbPromise;
  }
  async function cacheGet(key){try{const d=await db();return await new Promise((res,rej)=>{const q=d.transaction(CACHE_STORE,'readonly').objectStore(CACHE_STORE).get(key);q.onsuccess=()=>res(q.result||null);q.onerror=()=>rej(q.error)})}catch(_){return null}}
  async function cachePut(entry){try{const d=await db();await new Promise((res,rej)=>{const q=d.transaction(CACHE_STORE,'readwrite').objectStore(CACHE_STORE).put(entry);q.onsuccess=()=>res();q.onerror=()=>rej(q.error)});pruneCache()}catch(_){}
  }
  async function pruneCache(){try{const d=await db();const all=await new Promise((res,rej)=>{const q=d.transaction(CACHE_STORE,'readonly').objectStore(CACHE_STORE).getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>rej(q.error)});if(all.length<=MAX_CACHE)return;all.sort((a,b)=>a.updatedAt-b.updatedAt);const tx=d.transaction(CACHE_STORE,'readwrite'),s=tx.objectStore(CACHE_STORE);all.slice(0,all.length-MAX_CACHE).forEach(x=>s.delete(x.key))}catch(_){}
  }

  const originalFetch=window.fetch.bind(window);
  const inflight=new Map();
  const isApiGet=(input,init)=>{
    const method=String(init?.method||'GET').toUpperCase();
    let url=''; try{url=typeof input==='string'?input:input.url}catch(_){}
    return method==='GET' && /\/api\//.test(url) && !/\/api\/(health|usage)$/.test(url);
  };
  function keyFor(input,init){
    let u='';try{u=typeof input==='string'?input:input.url}catch(_){}
    return `${String(init?.method||'GET').toUpperCase()}:${u}`;
  }

  window.fetch=async function(input,init={}){
    const key=keyFor(input,init);
    if(!isApiGet(input,init)) return originalFetch(input,init);
    if(inflight.has(key)) return inflight.get(key);
    const run=(async()=>{
      const cached=await cacheGet(key);
      const fresh=cached && Date.now()-cached.updatedAt<TTL;
      if(cached && fresh){
        emit('cp:v22-cache',{type:'hit',url:redact(key),stale:false});
        return new Response(cached.body,{status:cached.status,headers:cached.headers});
      }
      try{
        const response=await originalFetch(input,init);
        if(response.ok){
          const clone=response.clone(); const body=await clone.text();
          await cachePut({key,body,status:response.status,headers:Object.fromEntries(response.headers.entries()),updatedAt:Date.now()});
        } else if(cached){
          emit('cp:v22-cache',{type:'stale-fallback',url:redact(key),status:response.status});
          return new Response(cached.body,{status:cached.status,headers:cached.headers});
        }
        return response;
      }catch(err){
        if(cached){emit('cp:v22-cache',{type:'offline-fallback',url:redact(key)});return new Response(cached.body,{status:cached.status,headers:cached.headers})}
        throw err;
      }
    })();
    inflight.set(key,run); try{return await run}finally{inflight.delete(key)}
  };

  // ---------- Transactional form snapshots / undo for existing editable controls ----------
  const history=new WeakMap();
  function editable(el){return el && el.matches && el.matches('textarea,input:not([type="password"]),[contenteditable="true"]') && !el.disabled && !el.readOnly}
  document.addEventListener('focusin',e=>{
    if(!editable(e.target))return;
    if(!history.has(e.target))history.set(e.target,{items:[e.target.isContentEditable?e.target.innerHTML:e.target.value],index:0});
  },true);
  document.addEventListener('input',e=>{
    if(!editable(e.target))return;
    const h=history.get(e.target)||{items:[],index:-1};
    const v=e.target.isContentEditable?e.target.innerHTML:e.target.value;
    if(h.items[h.index]===v)return;
    h.items=h.items.slice(0,h.index+1);h.items.push(v);if(h.items.length>40)h.items.shift();h.index=h.items.length-1;history.set(e.target,h);
  },true);
  document.addEventListener('keydown',e=>{
    if(!(e.ctrlKey||e.metaKey)||e.altKey)return;
    const el=document.activeElement;if(!editable(el))return;
    const h=history.get(el);if(!h)return;
    if(e.key.toLowerCase()==='z' && !e.shiftKey && h.index>0){e.preventDefault();h.index--;applyHistory(el,h)}
    else if((e.key.toLowerCase()==='y'||(e.key.toLowerCase()==='z'&&e.shiftKey)) && h.index<h.items.length-1){e.preventDefault();h.index++;applyHistory(el,h)}
  },true);
  function applyHistory(el,h){const v=h.items[h.index];if(el.isContentEditable)el.innerHTML=v;else el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));emit('cp:v22-history',{direction:h.index?'restore':'reset'})}

  // ---------- Smart accessibility and interaction hardening ----------
  function harden(){
    document.querySelectorAll('button,a,[role="button"]').forEach(el=>{
      if(!el.getAttribute('aria-label') && !(el.textContent||'').trim()) el.setAttribute('aria-label','Action');
      if(el.tagName==='BUTTON' && el.type==='submit' && !el.getAttribute('aria-disabled')) el.setAttribute('aria-disabled',el.disabled?'true':'false');
    });
    document.querySelectorAll('img').forEach(img=>{if(!img.loading)img.loading='lazy';if(!img.decoding)img.decoding='async';});
  }
  let lastFocus=0;
  document.addEventListener('focusin',e=>{lastFocus=Date.now();if(e.target?.scrollIntoView && matchMedia('(prefers-reduced-motion: reduce)').matches) e.target.scrollIntoView({block:'nearest',behavior:'auto'})},true);

  // ---------- Existing-tab performance telemetry (local only) ----------
  const perf={version:VERSION,startedAt:Date.now(),navigation:null,longTasks:0,errors:0,api:{calls:0,failures:0}};
  try{
    const nav=performance.getEntriesByType('navigation')[0]; if(nav) perf.navigation={dom:Math.round(nav.domContentLoadedEventEnd),load:Math.round(nav.loadEventEnd),transfer:nav.transferSize||0};
    if('PerformanceObserver' in window){
      try{new PerformanceObserver(list=>{perf.longTasks+=list.getEntries().length}).observe({type:'longtask',buffered:true})}catch(_){ }
    }
  }catch(_){ }
  window.addEventListener('error',()=>{perf.errors++;emit('cp:v22-error',{count:perf.errors})});
  window.addEventListener('unhandledrejection',()=>{perf.errors++;emit('cp:v22-error',{count:perf.errors})});
  const oldFetch=window.fetch;
  window.fetch=async function(input,init){perf.api.calls++;try{const r=await oldFetch(input,init);if(!r.ok)perf.api.failures++;return r}catch(e){perf.api.failures++;throw e}};

  // ---------- Preserve the user's current position when React rerenders ----------
  let scrollKey='';
  const readTab=()=>{
    try{return window.__CP_ADVANCED_TAB__||document.querySelector('[aria-current="page"]')?.dataset?.tab||'current'}catch(_){return 'current'}
  };
  function snapshot(){try{scrollKey=readTab();sessionStorage.setItem('CP_V22_SCROLL',JSON.stringify({tab:scrollKey,y:scrollY,t:Date.now()}))}catch(_){}
  }
  function restore(){try{const x=JSON.parse(sessionStorage.getItem('CP_V22_SCROLL')||'null');if(x&&x.tab===readTab()&&Date.now()-x.t<300000)requestAnimationFrame(()=>scrollTo({top:x.y,behavior:'auto'}))}catch(_){}
  }
  addEventListener('pagehide',snapshot);addEventListener('beforeunload',snapshot);

  // ---------- Expose a non-visual diagnostics API for the existing portal ----------
  window.CampusPortalAdvanced={
    version:VERSION,
    diagnostics:()=>({...perf,uptimeMs:Date.now()-perf.startedAt,lastFocus}),
    clearRuntimeCache:async()=>{try{const d=await db();await new Promise((res,rej)=>{const q=d.transaction(CACHE_STORE,'readwrite').objectStore(CACHE_STORE).clear();q.onsuccess=()=>res();q.onerror=()=>rej(q.error)});emit('cp:v22-cache',{type:'cleared'});return true}catch(_){return false}},
    getRuntimeState:()=>({...state})
  };

  const observer=new MutationObserver(()=>harden());
  function init(){harden();restore();const root=document.getElementById('root')||document.body;observer.observe(root,{subtree:true,childList:true});emit('cp:v22-ready',{version:VERSION})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
