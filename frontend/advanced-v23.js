/* Campus Portal Advanced Runtime v23
 * Invisible infrastructure upgrade. No new navigation, tabs, screens, or branding.
 * Builds on v22 and strengthens the existing application surfaces.
 */
(function(){
  'use strict';
  if(window.__CP_ADVANCED_V23__) return;
  window.__CP_ADVANCED_V23__ = true;
  const VERSION='23.0.0';
  const KEY='CP_V23_RUNTIME';
  const RETRIES=2;
  const REQUEST_TIMEOUT=20000;
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('campus-portal-runtime') : null;
  const state={version:VERSION,startedAt:Date.now(),online:navigator.onLine,requests:0,failures:0,retries:0,cacheFallbacks:0};
  try{Object.assign(state,JSON.parse(localStorage.getItem(KEY)||'{}'),{version:VERSION,startedAt:Date.now()});localStorage.setItem(KEY,JSON.stringify(state))}catch(_){ }
  const emit=(name,detail={})=>{try{window.dispatchEvent(new CustomEvent(name,{detail}))}catch(_){}};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const uuid=()=>crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const isApi=(input,init={})=>{
    let url='';try{url=typeof input==='string'?input:input.url||''}catch(_){ }
    return /^\/api\//.test(new URL(url,location.href).pathname) && String(init.method||'GET').toUpperCase()!=='OPTIONS';
  };
  const retryableStatus=s=>[408,425,429,500,502,503,504].includes(s);

  // Adaptive request envelope: trace ID + timeout + bounded retry for transient failures.
  const baseFetch=window.fetch.bind(window);
  window.fetch=async function(input,init={}){
    if(!isApi(input,init)) return baseFetch(input,init);
    const method=String(init.method||'GET').toUpperCase();
    const trace=(init.headers&&new Headers(init.headers).get('X-Request-ID'))||uuid();
    const headers=new Headers(init.headers||{});headers.set('X-Request-ID',trace);headers.set('X-Client-Runtime',VERSION);
    const controller=new AbortController();
    const external=init.signal;
    let onAbort; if(external){onAbort=()=>controller.abort(external.reason);if(external.aborted)controller.abort(external.reason);else external.addEventListener('abort',onAbort,{once:true})}
    state.requests++;
    let last;
    try{
      for(let attempt=0;attempt<=RETRIES;attempt++){
        const timer=setTimeout(()=>controller.abort(new DOMException('Request timeout','TimeoutError')),REQUEST_TIMEOUT*(attempt+1));
        try{
          const response=await baseFetch(input,{...init,headers,signal:controller.signal});
          clearTimeout(timer);
          if(response.ok || !retryableStatus(response.status) || attempt===RETRIES) return response;
          state.retries++; last=new Error(`HTTP ${response.status}`);
        }catch(err){
          clearTimeout(timer);last=err;
          if(attempt===RETRIES || (err.name==='AbortError' && external?.aborted)) throw err;
          state.retries++;
        }
        await sleep(Math.min(2500,300*(2**attempt)+Math.random()*180));
      }
      throw last||new Error('Request failed');
    }catch(err){state.failures++;throw err}finally{if(onAbort)external.removeEventListener('abort',onAbort)}
  };

  // Cross-tab coordination without changing the UI.
  if(channel){channel.onmessage=e=>{if(e.data?.type==='runtime-ping')channel.postMessage({type:'runtime-pong',id:e.data.id,version:VERSION});emit('cp:v23-sync',e.data)}}
  window.addEventListener('storage',e=>{if(e.key===KEY)emit('cp:v23-state-sync')});
  const publish=()=>{try{localStorage.setItem(KEY,JSON.stringify({...state,lastHeartbeat:Date.now()}));channel?.postMessage({type:'runtime-heartbeat',version:VERSION,online:navigator.onLine})}catch(_){}};
  setInterval(publish,15000);publish();

  // Resilient draft snapshots for existing editable fields. No new UI.
  const DB='campus_portal_runtime_v23', STORE='drafts'; let dbp;
  function openDb(){if(dbp)return dbp;dbp=new Promise((resolve,reject)=>{if(!indexedDB)return reject(new Error('no indexeddb'));const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE,{keyPath:'key'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});return dbp}
  async function putDraft(key,value){try{const d=await openDb();await new Promise((res,rej)=>{const q=d.transaction(STORE,'readwrite').objectStore(STORE).put({key,value,updatedAt:Date.now()});q.onsuccess=res;q.onerror=()=>rej(q.error)})}catch(_){}}
  function draftKey(el){return `${location.pathname}|${el.name||el.id||el.getAttribute('data-testid')||''}`}
  let draftTimer;
  document.addEventListener('input',e=>{const el=e.target;if(!el||!['INPUT','TEXTAREA'].includes(el.tagName)||el.type==='password'||!el.id&&!el.name)return;clearTimeout(draftTimer);draftTimer=setTimeout(()=>putDraft(draftKey(el),el.value),350)},true);

  // Network-aware existing controls: mark only, never create panels or tabs.
  const updateOnline=()=>{state.online=navigator.onLine;emit('cp:v23-network',{online:state.online});publish()};
  addEventListener('online',updateOnline);addEventListener('offline',updateOnline);

  // Runtime health surface for existing code/tests; intentionally non-visual.
  window.CampusPortalAdvancedV23={version:VERSION,diagnostics:()=>({...state,uptimeMs:Date.now()-state.startedAt}),pingPeers:()=>{const id=uuid();channel?.postMessage({type:'runtime-ping',id});return id}};

  // Prevent focus traps caused by dynamically replaced disabled controls.
  document.addEventListener('keydown',e=>{
    if(e.key!=='Tab')return;
    const active=document.activeElement;
    if(active?.matches?.('[aria-disabled="true"],button:disabled,[inert]')){try{active.blur()}catch(_){}}
  },true);

  emit('cp:v23-ready',{version:VERSION});
})();
