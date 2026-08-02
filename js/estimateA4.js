/* ============================================================
   estimateA4 — the concert-pitch estimator as a pure function.

   Lifted verbatim out of analysis.js so that it can run in the
   worker beside analyzeSegment(). Same rule as that module: no DOM,
   no globals, no AudioContext, so it imports nothing from state.js
   (which reads `navigator` at load) and keeps its own clamp.

   Returns null when there is not enough tonal content to say
   anything, which is the case the caller has to report differently.
   ============================================================ */
import {stft,magOf} from './dsp/fft.js';

const clamp = (v,a,b) => v<a?a:v>b?b:v;

function estimateA4(sig,sr,fftN){
  const n=Math.min(fftN,1<<Math.floor(Math.log2(Math.max(4096,sig.length))));
  const S1=stft(sig,n,n/2), M=magOf(S1);
  const K=S1.K, avg=new Float32Array(K);
  for(let t=0;t<S1.frames;t++) for(let k=0;k<K;k++) avg[k]+=M[t*K+k];
  for(let k=0;k<K;k++) avg[k]/=S1.frames;
  const df=sr/n;
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
  if(cx===0&&cy===0) return null;
  const dev=Math.atan2(cy,cx)/(2*Math.PI)*100;
  return {a4:clamp(440*Math.pow(2,dev/1200),415,466), dev};
}

export {estimateA4};
