'use strict';

// Bounded, low-overhead runtime telemetry. It stores aggregates only; request bodies,
// prompts, tokens, cookies and authorization headers are never retained here.
const MAX_ROUTES = 250;
const startedAt = Date.now();
const histogram = [25,50,100,250,500,1000,2000,5000,10000];
const metrics = {requests:0,errors:0,active:0,totalMs:0,maxMs:0,routeCount:0,buckets:Object.fromEntries(histogram.map(n=>[n,0])),routes:new Map()};

function observe(route,statusCode,ms){
  metrics.requests++; metrics.totalMs+=ms; metrics.maxMs=Math.max(metrics.maxMs,ms);
  if(statusCode>=500) metrics.errors++;
  for(const n of histogram){if(ms<=n){metrics.buckets[n]++;break;}}
  if(metrics.routes.size<MAX_ROUTES || metrics.routes.has(route)){
    const x=metrics.routes.get(route)||{requests:0,errors:0,totalMs:0,maxMs:0};
    x.requests++; x.totalMs+=ms; x.maxMs=Math.max(x.maxMs,ms); if(statusCode>=500)x.errors++;
    metrics.routes.set(route,x);
  }
}
function snapshot(){
  const routes={};
  for(const [route,x] of metrics.routes){routes[route]={...x,avgMs:Math.round(x.totalMs/Math.max(1,x.requests))};}
  return {uptimeSec:Math.round((Date.now()-startedAt)/1000),...metrics,routes:routes,avgMs:metrics.requests?Math.round(metrics.totalMs/metrics.requests):0,maxMs:Math.round(metrics.maxMs)};
}
module.exports={metrics,observe,snapshot,startedAt};
