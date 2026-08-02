/* ============================================================
   MAIN ANALYSIS — the glue between the fenced selection and the
   DSP, which now runs in a worker (js/analysisRunner.js decides
   whether that is a real worker or the main-thread fallback).

   Nothing here computes anything. It slices the selection, hands
   the signal over, turns the worker's stage messages into the
   status line, and hands the result to the renderer.
   ============================================================ */
import {$,S,setStatus,noteOn,noteVote} from './state.js';
import {runAnalysis,runDetectA4,cancelRun,isAborted} from './analysisRunner.js';
import {renderResult} from './ui/panels.js';

/* ---------------- selection slice ---------------- */
function slice(maxSec){
  const a=Math.max(0,Math.floor((S.selA||0)*S.sr));
  let b=Math.min(S.mono.length,Math.floor((S.selB||S.dur)*S.sr));
  if((b-a)/S.sr>maxSec) b=a+Math.floor(maxSec*S.sr);
  return S.mono.subarray(a,b);
}

/* ---------------- what is in flight ----------------
   One slot, because the runner has one slot: starting either job cancels
   whatever was running. The token is an object rather than a flag so a run
   that has already been superseded cannot clear the state of the run that
   superseded it. */
let job=null;
function setJob(t){
  job=t;
  const b=$('#analyzeBtn');
  const running = t && t.kind==='analyze';
  // the same affordance the transport uses: the button that started the work
  // becomes the one that stops it, so there is no new control to explain
  b.textContent = running ? '■ Cancel' : 'Analyze selection';
  b.classList.toggle('pri',!running);
  b.disabled = !!(t && t.kind==='a4');
  $('#detectA4').disabled = !!t;
}
const done = t => { if(job===t) setJob(null); };

/* ---------------- A4 detection ---------------- */
async function detectA4(){
  if(!S.mono) return;
  const t={kind:'a4'}; setJob(t);
  setStatus('Estimating concert pitch …',true);
  try{
    const R=await runDetectA4(Float32Array.from(slice(6)),S.sr,S.fftN);
    if(!R.est){ setStatus('Not enough tonal content to estimate pitch.',false,true); return; }
    const {a4,dev}=R.est;
    S.a4=a4; $('#a4').value=a4.toFixed(1); S.ana=null;
    setStatus('Concert pitch ≈ <b style="color:var(--cy)">'+a4.toFixed(1)+' Hz</b> ('+(dev>=0?'+':'')+dev.toFixed(0)+' cents from 440).');
  }catch(err){
    if(isAborted(err)) return;                 // superseded; whoever superseded it owns the status
    console.error(err);
    setStatus('Pitch detection failed: '+err.message,false,true);
  }finally{ done(t); }
}

/* ---------------- the analysis ---------------- */
async function analyze(){
  // pressing the button while a run is in flight cancels it. The worker
  // unwinds cooperatively and survives, so the next press reuses it.
  if(job && job.kind==='analyze'){
    cancelRun(); setJob(null);
    setStatus('Analysis cancelled.');
    return;
  }
  if(!S.mono) return;
  const t={kind:'analyze'}; setJob(t);
  const t0=performance.now();
  try{
    setStatus('Reading selection …',true);
    const sig=Float32Array.from(slice(6));
    if(sig.length<2048){ setStatus('Selection too short — fence at least ~0.2 s.',false,true); return; }

    let R;
    try{
      R=await run(sig);
    }catch(err){
      // the worker died rather than declining the job: re-cut the selection
      // and finish on the main thread rather than losing the run
      if(!err || !err.workerFailed) throw err;
      R=await run(Float32Array.from(slice(6)));
    }

    S._fine={Sf:R.Sf,mask:R.mask,sigLen:R.sig.length,sig:R.sig};
    const n=R.windowSize;
    S.ana={detN:R.detN,xamp:R.xamp,pfund:R.pfund,evid:R.evid,
           yraw:R.yraw,yw:R.yw,recon:R.recon,fundBin:R.fundBin,
           ms:(performance.now()-t0)|0,
           hpss:S.hpss,harm:R.harm,perc:R.perc,n};
    // a new fit means a new set of notes to choose from, so the previous
    // chord's picks and the decisions behind them both go. renderResult()
    // rebuilds noteOn from noteVote, so clearing the votes is what actually
    // resets the selection.
    noteOn.clear(); noteVote.clear();
    renderResult();
    setStatus('Done in '+S.ana.ms+' ms · window '+n+' · A₄ '+S.a4.toFixed(1)+' Hz'+(S.hpss?' · percussion stripped':''));
  }catch(err){
    if(isAborted(err)) return;                 // cancelled or superseded
    console.error(err);
    setStatus('Analysis failed: '+err.message,false,true);
  }finally{ done(t); }
}

/* The signal is handed over, not copied — it comes back on the result, which
   is what lets S._fine keep it without ever holding a buffer the worker has
   detached. `m` null is a stage that only exists to yield. */
const run = sig => runAnalysis(sig,S.sr,{
  a4:S.a4, fftN:S.fftN, decay:S.decay, fund:S.fund, hpss:S.hpss,
  thr:S.thr, gate:S.GATE, nms:S.NMS, maxNotes:12
}, m=>{ if(m) setStatus(m,true); });

export {detectA4,analyze};
