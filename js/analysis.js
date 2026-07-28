/* ============================================================
   MAIN ANALYSIS — the pipeline that runs on the fenced selection,
   plus the concert-pitch estimator that shares its slicing.
   ============================================================ */
import {$,S,clamp,setStatus,yield_} from './state.js';
import {stft,istft,magOf} from './dsp/fft.js';
import {hpssMask,applyMask} from './dsp/hpss.js';
import {NB,NN_COUNT,logSpec,whiten,buildDict,nnls} from './dsp/nnls.js';
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

    // --- stage 1: fine STFT + HPSS ---
    const fn=4096, fh=2048;
    let Sf=null, mask=null, harm=sig, perc=null;
    if(S.hpss && sig.length>fn*2){
      setStatus('Separating pitched from percussive …',true); await yield_();
      Sf=stft(sig,fn,fh);
      mask=hpssMask(magOf(Sf),Sf.frames,Sf.K,17,17);
      await yield_();
      harm=istft(applyMask(Sf,mask,false),sig.length);
      perc=istft(applyMask(Sf,mask,true),sig.length);
    }
    S._fine={Sf,mask,sigLen:sig.length,sig};

    // --- stage 2: long STFT -> averaged magnitude ---
    setStatus('Transforming …',true); await yield_();
    let n=S.fftN;
    while(n>harm.length && n>4096) n>>=1;
    const hop=Math.max(1024,n>>2);
    const SL=stft(harm,n,hop), ML=magOf(SL), K=SL.K;
    const avg=new Float32Array(K);
    for(let t=0;t<SL.frames;t++) for(let k=0;k<K;k++) avg[k]+=ML[t*K+k];
    for(let k=0;k<K;k++) avg[k]/=SL.frames;

    // --- stage 3: log-frequency + whitening ---
    setStatus('Mapping to semitone bins …',true); await yield_();
    const yraw=logSpec(avg,S.sr,n,S.a4);
    const yw=whiten(yraw);

    // --- stage 4: NNLS approximate transcription ---
    setStatus('Fitting 88 harmonic templates (NNLS) …',true); await yield_();
    const {D,fundBin}=buildDict(S.a4,S.decay);
    const allCols=[...Array(NN_COUNT).keys()];
    const xdet=nnls(D,allCols,yw,320,0.004);
    await yield_();

    let xm=0; for(let i=0;i<NN_COUNT;i++) if(xdet[i]>xm) xm=xdet[i];
    const detN=new Float64Array(NN_COUNT);
    for(let i=0;i<NN_COUNT;i++) detN[i]=xm>0?xdet[i]/xm:0;

    // fundamental evidence: is there real energy at the note's own f0?
    // without this the fit happily invents a note an octave below the true one,
    // because that phantom note's 2nd partial can explain everything above it.
    let ym=0; for(let k=0;k<NB;k++) if(yw[k]>ym) ym=yw[k];
    const evid=new Float64Array(NN_COUNT);
    for(let i=0;i<NN_COUNT;i++){
      const p=fundBin[i], b0=Math.floor(p), fr=p-b0;
      const o=((b0>=0&&b0<NB?yw[b0]:0)*(1-fr))+((b0+1>=0&&b0+1<NB?yw[b0+1]:0)*fr);
      evid[i]= ym>0 ? o/ym : 0;
    }

    // --- stage 5: amplitudes on the un-whitened spectrum ---
    const cand=[]; for(let i=0;i<NN_COUNT;i++) if(detN[i]>0.03) cand.push(i);
    const xampS = cand.length? nnls(D,cand,yraw,260,0) : [];
    const xamp=new Float64Array(NN_COUNT);
    cand.forEach((c,i)=>xamp[c]=xampS[i]);

    // --- stage 6: reconstruction + per-note overtone accounting ---
    const recon=new Float32Array(NB);
    for(let i=0;i<NN_COUNT;i++){ if(xdet[i]<=0) continue; const col=D[i];
      for(let k=0;k<NB;k++) recon[k]+=xdet[i]*col[k]; }
    const pfund=new Float64Array(NN_COUNT);
    for(let i=0;i<NN_COUNT;i++){
      const p=fundBin[i], b0=Math.floor(p), fr=p-b0;
      const at=(col,b)=> (b>=0&&b<NB)?col[b]:0;
      const own=xdet[i]*(at(D[i],b0)*(1-fr)+at(D[i],b0+1)*fr);
      let oth=0;
      for(let j=0;j<NN_COUNT;j++){
        if(j===i||xdet[j]<=0) continue;
        oth+=xdet[j]*(at(D[j],b0)*(1-fr)+at(D[j],b0+1)*fr);
      }
      pfund[i]= (own+oth)>1e-12 ? own/(own+oth) : 0;
    }

    S.ana={detN,xamp,pfund,evid,yraw,yw,recon,fundBin,ms:(performance.now()-t0)|0,
           hpss:S.hpss,harm,perc,n};
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
