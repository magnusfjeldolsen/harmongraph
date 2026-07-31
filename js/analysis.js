/* ============================================================
   MAIN ANALYSIS — the pipeline that runs on the fenced selection,
   plus the concert-pitch estimator that shares its slicing.
   ============================================================ */
import {$,S,clamp,setStatus,yield_,noteOn,noteVote} from './state.js';
import {stft,magOf} from './dsp/fft.js';
import {analyzeSegment} from './analyzeSegment.js';
import {renderResult} from './ui/panels.js';

/* ---------------- selection slice ---------------- */
function slice(maxSec){
  const a=Math.max(0,Math.floor((S.selA||0)*S.sr));
  let b=Math.min(S.mono.length,Math.floor((S.selB||S.dur)*S.sr));
  if((b-a)/S.sr>maxSec) b=a+Math.floor(maxSec*S.sr);
  return S.mono.subarray(a,b);
}

/* ---------------- A4 detection ---------------- */
async function detectA4(){
  if(!S.mono){ return; }
  setStatus('Estimating concert pitch …',true); await yield_();
  const sig=slice(6), n=Math.min(S.fftN,1<<Math.floor(Math.log2(Math.max(4096,sig.length))));
  const S1=stft(sig,n,n/2), M=magOf(S1);
  const K=S1.K, avg=new Float32Array(K);
  for(let t=0;t<S1.frames;t++) for(let k=0;k<K;k++) avg[k]+=M[t*K+k];
  for(let k=0;k<K;k++) avg[k]/=S1.frames;
  const df=S.sr/n;
  let mx=0; for(let k=0;k<K;k++) if(avg[k]>mx) mx=avg[k];
  let cx=0, cy=0;
  for(let k=2;k<K-2;k++){
    if(avg[k]<=avg[k-1]||avg[k]<avg[k+1]||avg[k]<0.03*mx) continue;
    const d=0.5*(avg[k-1]-avg[k+1])/(avg[k-1]-2*avg[k]+avg[k+1]||1e-9);
    const f=(k+clamp(d,-.5,.5))*df;
    if(f<55||f>2200) continue;
    const cents=1200*Math.log2(f/440);
    const dev=cents-100*Math.round(cents/100);
    const w=avg[k];
    cx+=w*Math.cos(2*Math.PI*dev/100); cy+=w*Math.sin(2*Math.PI*dev/100);
  }
  if(cx===0&&cy===0){ setStatus('Not enough tonal content to estimate pitch.',false,true); return; }
  let dev=Math.atan2(cy,cx)/(2*Math.PI)*100;
  const a4=clamp(440*Math.pow(2,dev/1200),415,466);
  S.a4=a4; $('#a4').value=a4.toFixed(1); S.ana=null;
  setStatus('Concert pitch ≈ <b style="color:var(--cy)">'+a4.toFixed(1)+' Hz</b> ('+(dev>=0?'+':'')+dev.toFixed(0)+' cents from 440).');
}

async function analyze(){
  if(!S.mono) return;
  $('#analyzeBtn').disabled=true;
  try{
    const t0=performance.now();
    setStatus('Reading selection …',true); await yield_();
    const sig=Float32Array.from(slice(6));
    if(sig.length<2048){ setStatus('Selection too short — fence at least ~0.2 s.',false,true); return; }

    // the whole pipeline lives in analyzeSegment(); onStage keeps the status
    // line and the event-loop yields exactly where they used to be
    const R=await analyzeSegment(sig,S.sr,{
      a4:S.a4, fftN:S.fftN, decay:S.decay, fund:S.fund, hpss:S.hpss,
      thr:S.thr, gate:S.GATE, nms:S.NMS, maxNotes:12,
      onStage: async m=>{ if(m) setStatus(m,true); await yield_(); }
    });

    S._fine={Sf:R.Sf,mask:R.mask,sigLen:sig.length,sig};
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
    console.error(err);
    setStatus('Analysis failed: '+err.message,false,true);
  }finally{
    $('#analyzeBtn').disabled=false;
  }
}

export {detectA4,analyze};
