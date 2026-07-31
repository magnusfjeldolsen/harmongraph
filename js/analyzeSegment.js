/* ============================================================
   analyzeSegment — the whole note-detection pipeline as a pure
   function. No DOM, no globals, no AudioContext: it takes a
   Float32Array and a sample rate and returns numbers, so the same
   code runs in the browser and under `node test/harness.mjs`.

   js/analysis.js is now only the glue that slices the selection,
   calls this, and hands the result to the renderer.
   ============================================================ */
import {stft,istft,magOf} from './dsp/fft.js';
import {hpssMask,applyMask} from './dsp/hpss.js';
import {NB,NOTE_LO,NN_COUNT,logSpec,whiten,buildDict,nnls} from './dsp/nnls.js';
import {midiName,midiFreq} from './pitch.js';

const now = () => (typeof performance!=='undefined' && performance.now)
  ? performance.now() : Date.now();

/* ---------------- candidate selection ----------------
   Pulled out of ui/panels.js unchanged so that the harness and the
   Result panel can never drift apart. The threshold slider still
   re-runs this alone, with no refit. */
function selectNotes(detN,evid,thr,gate,nms,maxNotes){
  // 1. activation threshold  2. must have energy at its own fundamental
  const pass=new Float64Array(NN_COUNT);
  for(let i=0;i<NN_COUNT;i++)
    if(detN[i]>=thr && (!evid || evid[i]>=gate)) pass[i]=detN[i];
  // 3. non-maximum suppression: adjacent semitones in the bass are usually
  //    FFT smearing, not a real minor 2nd — keep one unless they are comparable
  const out=[];
  for(let i=0;i<NN_COUNT;i++){
    if(!pass[i]) continue;
    let beaten=false;
    for(const d of [-1,1]){ const j=i+d;
      if(j>=0&&j<NN_COUNT&&pass[j]>pass[i]*nms) beaten=true; }
    if(!beaten) out.push(i);
  }
  out.sort((a,b)=>detN[b]-detN[a]);
  const keep=out.slice(0,maxNotes);
  keep.sort((a,b)=>a-b);
  return keep;
}

/* ---------------- the pipeline ----------------
   `onStage` is optional and only exists so the browser can paint a
   status line and yield to the event loop at exactly the points the
   old analyze() did. Omit it and the function is straight-line. */
async function analyzeSegment(sig,sr,opts={}){
  const {a4=440, fftN=16384, decay=0.72, hpss=true,
         thr=0.12, gate=0.08, nms=1.5, maxNotes=12, wfloor=0.3, fund=1,
         onStage=null} = opts;
  const stage = onStage ? (m=>onStage(m)) : null;
  const t0=now();

  // --- stage 1: fine STFT + HPSS ---
  const fn=4096, fh=2048;
  let Sf=null, mask=null, harm=sig, perc=null;
  if(hpss && sig.length>fn*2){
    if(stage) await stage('Separating pitched from percussive …');
    Sf=stft(sig,fn,fh);
    mask=hpssMask(magOf(Sf),Sf.frames,Sf.K,17,17);
    if(stage) await stage(null);
    harm=istft(applyMask(Sf,mask,false),sig.length);
    perc=istft(applyMask(Sf,mask,true),sig.length);
  }

  // --- stage 2: long STFT -> averaged magnitude ---
  if(stage) await stage('Transforming …');
  let n=fftN;
  while(n>harm.length && n>4096) n>>=1;
  const hop=Math.max(1024,n>>2);
  const SL=stft(harm,n,hop), ML=magOf(SL), K=SL.K;
  const avg=new Float32Array(K);
  for(let t=0;t<SL.frames;t++) for(let k=0;k<K;k++) avg[k]+=ML[t*K+k];
  for(let k=0;k<K;k++) avg[k]/=SL.frames;

  // --- stage 3: log-frequency + whitening ---
  if(stage) await stage('Mapping to semitone bins …');
  const yraw=logSpec(avg,sr,n,a4);
  const yw=whiten(yraw,wfloor);

  // --- stage 4: NNLS approximate transcription ---
  if(stage) await stage('Fitting 88 harmonic templates (NNLS) …');
  const {D,fundBin}=buildDict(a4,decay,fund);
  const allCols=[...Array(NN_COUNT).keys()];
  const xdet=nnls(D,allCols,yw,320,0.004);
  if(stage) await stage(null);

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

  // --- the note list, exactly as the Result panel builds it ---
  const keep=selectNotes(detN,evid,thr,gate,nms,maxNotes);
  let amx=0; keep.forEach(i=>{ if(xamp[i]>amx) amx=xamp[i]; });
  const notes=keep.map(i=>{
    const db = amx>0 && xamp[i]>0 ? 20*Math.log10(xamp[i]/amx) : -60;
    return {
      i, midi:NOTE_LO+i, name:midiName(NOTE_LO+i),
      freq:midiFreq(NOTE_LO+i,a4),
      db:Math.max(-60,db),
      pFund:pfund[i], activation:detN[i],
      cents:0                        // Task 6 fills this in
    };
  });

  return {notes, yraw, yw, fundBin, detN, evid, windowSize:n,
          // extras the app needs; the harness ignores them
          xamp, pfund, recon, harm, perc, Sf, mask,
          ms:(now()-t0)|0};
}

export {analyzeSegment,selectNotes};
