/* ============================================================
   THE RUNNER — the page's side of the DSP worker.

   Owns the worker's lifecycle, the generation token, cancellation,
   and the main-thread fallback. Imports nothing from the DOM, so
   `node test/worker.mjs` can drive it against a stub Worker.

   ---- one run at a time, newest wins -------------------------
   Every request takes the next generation id. Starting a new one
   abandons the previous immediately on this side — its promise
   rejects the moment it is superseded, before the worker has even
   been told — and every message carries the id it belongs to, so a
   reply that arrives late is dropped rather than allowed to
   overwrite a newer result. That is the race this file exists to
   make structurally impossible: the same stale-reply race the
   playback code had to be fixed for twice.

   ---- cancellation -------------------------------------------
   Cooperative first. `cancel` is a message, not terminate(): the
   worker's pipeline checks the token between stages and inside the
   HPSS and FISTA loops, unwinds through its ordinary error path,
   posts `cancelled`, and stays alive with its FFT tables and note
   dictionary still warm. Cancelling costs nothing and the next run
   reuses the same worker.

   terminate() is only the backstop. If a cancelled job has not said
   `cancelled` — or a job posted behind it has not said `started` —
   within CANCEL_GRACE, the worker is presumed wedged in a stretch of
   code that never yields, and it is killed and replaced.

   ---- fallback ------------------------------------------------
   Module workers are not universal (some browsers block them; a
   file:// page has no worker at all), and a worker that constructs
   can still fail to load its module graph. So the worker is probed
   with a ping before it is trusted with any work, and anything short
   of a pong means every run goes down the main-thread path instead —
   which is the code the app shipped with, yields and all, and is
   still cancellable because analyzeSegment() takes the same `check`.
   ============================================================ */
import {analyzeSegment} from './analyzeSegment.js';
import {estimateA4} from './estimateA4.js';
import {tick} from './tick.js';

/* Resolved against this module, not against the document: on a project
   page the document lives at /harmongraph/ and a bare './js/worker.js'
   would be right only by coincidence. */
const WORKER_URL=new URL('./worker.js',import.meta.url);
const PROBE_MS=5000;       // a worker that cannot answer a ping in this long is broken
const CANCEL_GRACE=1500;   // ... and one that cannot unwind in this long gets terminated

class Aborted extends Error{
  constructor(){ super('Analysis cancelled'); this.name='AbortError'; this.aborted=true; }
}
const isAborted = e => !!(e && e.aborted);

let worker=null, ready=null, unsupported=false;
let gen=0, cancelledGen=0;
let active=null;           // the one run whose reply we still want
let watch=null;            // {id,timer} — the terminate() backstop

/* ---------------- worker lifecycle ---------------- */
function ensureWorker(){
  if(ready) return ready;
  ready=new Promise(resolve=>{
    if(unsupported || typeof Worker!=='function'){ resolve(null); return; }
    let w=null;
    try{ w=new Worker(WORKER_URL,{type:'module'}); }
    catch(e){ unsupported=true; resolve(null); return; }   // module workers blocked
    let settled=false;
    const timer=setTimeout(()=>fail(),PROBE_MS);
    function fail(){
      if(settled) return;
      settled=true; clearTimeout(timer); unsupported=true;
      try{ w.terminate(); }catch(e){}
      resolve(null);
    }
    // a module that 404s or throws while loading surfaces here, not at
    // construction, which is exactly why the ping exists
    w.onerror=ev=>{ if(ev&&ev.preventDefault) ev.preventDefault(); settled?lost():fail(); };
    w.onmessageerror=()=>{ settled?lost():fail(); };
    w.onmessage=ev=>{
      if(settled){ onMessage(ev); return; }
      if(ev.data&&ev.data.type==='pong'){
        settled=true; clearTimeout(timer); worker=w; resolve(w);
      }
    };
    w.postMessage({type:'ping',id:0});
  });
  return ready;
}

/* the worker died, or would not unwind. Kill it, fail whatever was in it,
   and build a fresh one for next time. */
function lost(){
  if(worker){ try{ worker.terminate(); }catch(e){} }
  worker=null; ready=null;
  if(watch){ clearTimeout(watch.timer); watch=null; }
  const a=active; active=null;
  if(a){
    const e=new Error('The analysis worker stopped responding.');
    e.workerFailed=true;                   // the caller may retry on the main thread
    a.reject(e);
  }
  if(!unsupported) ensureWorker();
}

function onMessage(ev){
  const d=ev.data; if(!d) return;
  // any word at all from the job we were waiting on clears the backstop
  if(watch && d.id===watch.id){ clearTimeout(watch.timer); watch=null; }
  if(!active || d.id!==active.id) return;  // stale: a run that has already been superseded
  const a=active;
  switch(d.type){
    case 'started': if(watch){ clearTimeout(watch.timer); watch=null; } break;
    case 'stage':   if(a.onStage) a.onStage(d.m); break;
    case 'result':    active=null; a.resolve(d.R); break;
    case 'cancelled': active=null; a.reject(new Aborted()); break;
    case 'error':     active=null; a.reject(new Error(d.message)); break;
  }
}

/* ---------------- cancellation ---------------- */
/* Drop the run in flight. Its promise rejects here and now — the worker is
   merely informed — so nothing downstream can be waiting on a run the user
   has already moved past. */
function abandon(){
  const a=active; if(!a) return;
  active=null;
  a.reject(new Aborted());
  if(a.viaWorker && worker){
    worker.postMessage({type:'cancel',id:a.id});
    if(watch) clearTimeout(watch.timer);
    watch={id:a.id, timer:setTimeout(()=>{ watch=null; lost(); },CANCEL_GRACE)};
  }
}
/* the Cancel affordance. Also marks the generation cancelled, which is what
   a main-thread run reads — it has no `active` entry to drop. */
function cancelRun(){ cancelledGen=gen; abandon(); }

/* which path the last/next run takes — for the status line and the tests */
const usingWorker = () => !!worker;

/* ---------------- the main-thread fallback ---------------- */
async function runLocal(id,kind,payload,onStage){
  const stale=()=>id!==gen||id<=cancelledGen;
  const check=async()=>{ if(stale()) throw new Aborted(); await tick(); if(stale()) throw new Aborted(); };
  /* a real timer at each stage, which is what yield_() bought: the browser
     gets to repaint the status line at exactly the six points it used to */
  const stage=async m=>{
    if(onStage) onStage(m);
    await new Promise(r=>setTimeout(r,0));
    if(stale()) throw new Aborted();
  };
  if(kind==='analyze'){
    const R=await analyzeSegment(payload.sig,payload.sr,{...payload.opts,onStage:stage,check});
    if(stale()) throw new Aborted();
    return {...R, sig:payload.sig};
  }
  await stage(null);
  return {est:estimateA4(payload.sig,payload.sr,payload.fftN), sig:payload.sig};
}

/* ---------------- the one entry point ----------------
   Takes ownership of payload.sig: it is transferred to the worker rather
   than copied, so the caller must not read it again. It comes back on the
   result as `sig`, which is what keeps S._fine from ever holding a detached
   buffer — the classic way this refactor goes wrong. */
async function start(kind,payload,onStage){
  abandon();                               // newest wins
  const id=++gen;
  const w=await ensureWorker();
  if(id!==gen || id<=cancelledGen) throw new Aborted();
  if(w){
    return new Promise((resolve,reject)=>{
      active={id,resolve,reject,onStage,viaWorker:true};
      w.postMessage({type:kind,id,...payload},[payload.sig.buffer]);
    });
  }
  return runLocal(id,kind,payload,onStage);
}

const runAnalysis = (sig,sr,opts,onStage) => start('analyze',{sig,sr,opts},onStage);
const runDetectA4 = (sig,sr,fftN)        => start('a4',{sig,sr,fftN},null);

/* Warm the worker on load: it has its own module graph to fetch, and doing
   that while the user is still choosing a file means the first Analyze does
   not wait for it. Browser only — under Node this module is imported by the
   link check and by the tests, which supply their own Worker. */
if(typeof document!=='undefined') ensureWorker();

export {runAnalysis,runDetectA4,cancelRun,isAborted,Aborted,
        usingWorker,ensureWorker,WORKER_URL};
