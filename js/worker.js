/* ============================================================
   THE DSP WORKER

   A real module worker — `new Worker(url,{type:'module'})` — not a
   Blob-URL shim. The app is already ES modules on a static host and
   analyzeSegment() was already pure and DOM-free, so this file is
   only a mailbox: it owns no state beyond the cancellation token and
   computes nothing itself.

   PROTOCOL
     in   {type:'ping',    id}                  liveness probe
          {type:'analyze', id, sig, sr, opts}   sig is transferred in
          {type:'a4',      id, sig, sr, fftN}
          {type:'cancel',  id}                  cancel id and everything older
     out  {type:'pong',      id}
          {type:'started',   id}                this job now owns the thread
          {type:'stage',     id, m}             one progress stage; m may be null
          {type:'result',    id, R}             R.sig is the signal, handed back
          {type:'cancelled', id}                unwound cleanly, worker still alive
          {type:'error',     id, message}

   CANCELLATION
     Cooperative, not terminate(). `cancelledUpTo` is a generation
     token; check() compares the running job against it and throws the
     ABORT sentinel, which unwinds the pipeline through its ordinary
     error path and leaves this worker idle and reusable. The page
     keeps terminate() as a backstop for a job that never yields.

     check() yields before it re-reads the token, and that yield is the
     load-bearing part: a `cancel` posted from the page is a task, and
     a task cannot run while a synchronous loop is running. See
     js/tick.js for why the yield is not simply setTimeout(0).

   ONE JOB AT A TIME
     Messages are chained rather than handled concurrently. Two
     overlapping runs would not corrupt anything — the pipeline is pure
     and the dictionary caches are replaced, never mutated — but they
     would thrash those caches and split the CPU between a run nobody
     wants any more and the one that replaced it.
   ============================================================ */
import {analyzeSegment} from './analyzeSegment.js';
import {estimateA4} from './estimateA4.js';
import {tick} from './tick.js';

const ABORT={aborted:true};        // sentinel, deliberately not an Error
let cancelledUpTo=0;
let chain=Promise.resolve();

function post(msg,transfer){ self.postMessage(msg,transfer||[]); }

/* Every typed array in the reply is handed over rather than copied. The
   list has to be deduplicated by ArrayBuffer: with HPSS off `harm` IS
   `sig`, and naming one buffer twice in a transfer list is a DataCloneError. */
function buffersOf(...views){
  const seen=new Set();
  for(const v of views) if(v && v.buffer && !seen.has(v.buffer)) seen.add(v.buffer);
  return [...seen];
}

async function handle(d){
  const id=d.id;
  /* the token can already have moved past a job that was still queued */
  if(id<=cancelledUpTo){ post({type:'cancelled',id}); return; }
  const check=async()=>{
    if(id<=cancelledUpTo) throw ABORT;
    await tick();
    if(id<=cancelledUpTo) throw ABORT;
  };
  post({type:'started',id});
  try{
    if(d.type==='analyze'){
      const R=await analyzeSegment(d.sig,d.sr,{
        ...d.opts,
        // the six progress stages become messages, posted at exactly the
        // points the main-thread pipeline used to update the status line
        onStage: async m=>{ post({type:'stage',id,m}); await check(); },
        check
      });
      const out={
        notes:R.notes, yraw:R.yraw, yw:R.yw, fundBin:R.fundBin,
        detN:R.detN, evid:R.evid, windowSize:R.windowSize,
        xamp:R.xamp, pfund:R.pfund, recon:R.recon,
        harm:R.harm, perc:R.perc, Sf:R.Sf, mask:R.mask, ms:R.ms,
        // the signal goes back the way it came, so the page can keep it in
        // S._fine without ever holding a buffer this worker has detached
        sig:d.sig
      };
      post({type:'result',id,R:out}, buffersOf(
        out.yraw,out.yw,out.fundBin,out.detN,out.evid,out.xamp,out.pfund,
        out.recon,out.harm,out.perc,out.mask,
        out.Sf&&out.Sf.re, out.Sf&&out.Sf.im, out.sig));
    }else if(d.type==='a4'){
      const est=estimateA4(d.sig,d.sr,d.fftN);
      post({type:'result',id,R:{est,sig:d.sig}}, buffersOf(d.sig));
    }else{
      post({type:'error',id,message:'unknown job '+d.type});
    }
  }catch(e){
    if(e===ABORT) post({type:'cancelled',id});
    else post({type:'error',id,message:(e&&e.message)||String(e)});
  }
}

function onMessage(e){
  const d=e.data;
  if(!d) return;
  if(d.type==='cancel'){ if(d.id>cancelledUpTo) cancelledUpTo=d.id; return; }
  if(d.type==='ping'){ post({type:'pong',id:d.id}); return; }
  chain=chain.then(()=>handle(d));
}

/* Registered only when this really is a worker. `node test/modules.mjs`
   imports every module in js/ to prove it compiles, and a bare reference to
   `self` at load would turn that check into a false alarm. */
if(typeof self!=='undefined' && typeof self.postMessage==='function') self.onmessage=onMessage;

export {onMessage};
