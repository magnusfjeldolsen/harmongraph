/* ============================================================
   NNLS approximate note transcription (Mauch & Dixon, ISMIR 2010):
   log-frequency front end, whitening, the 88-column note dictionary,
   and the FISTA solver that fits it.
   ============================================================ */
import {midiFreq} from '../pitch.js';

/* ---------------- log-frequency spectrum ---------------- */
const BPS=3, LO=21, HI=132, NB=(HI-LO)*BPS;      // 3 bins/semitone, A0 .. C10
const NOTE_LO=21, NOTE_HI=108, NN_COUNT=NOTE_HI-NOTE_LO+1;   // 88 keys
const binMidi = k => LO + k/BPS;
const binFreq = (k,a4) => midiFreq(binMidi(k),a4);
const freqBin = (f,a4) => (69+12*Math.log2(f/a4)-LO)*BPS;

let kern=null, kernKey='';
function buildKernel(sr,n,a4){
  const key=sr+'|'+n+'|'+a4.toFixed(3);
  if(kernKey===key) return kern;
  const K=n/2+1, df=sr/n;
  const idx=[], wts=[];
  for(let k=0;k<NB;k++){
    const fc=binFreq(k,a4);
    let hw=Math.max(fc*(Math.pow(2,1/(12*BPS))-1), 1.2*df);
    let lo=Math.max(1,Math.ceil((fc-hw)/df)), hi=Math.min(K-1,Math.floor((fc+hw)/df));
    const ii=[], ww=[];
    let sum=0;
    for(let j=lo;j<=hi;j++){
      const w=0.5+0.5*Math.cos(Math.PI*(j*df-fc)/hw);
      if(w>0){ ii.push(j); ww.push(w); sum+=w; }
    }
    if(sum<=0){ const j=Math.round(fc/df); if(j>0&&j<K){ ii.push(j); ww.push(1); sum=1; } }
    for(let q=0;q<ww.length;q++) ww[q]/=sum||1;
    idx.push(Int32Array.from(ii)); wts.push(Float32Array.from(ww));
  }
  kern={idx,wts}; kernKey=key; return kern;
}
function logSpec(magAvg,sr,n,a4){
  const {idx,wts}=buildKernel(sr,n,a4);
  const y=new Float32Array(NB);
  for(let k=0;k<NB;k++){ let s=0; const ii=idx[k],ww=wts[k]; for(let q=0;q<ii.length;q++) s+=magAvg[ii[q]]*ww[q]; y[k]=s; }
  return y;
}
/* Running standardisation over ±1 octave -> spectral whitening.

   The local σ is floored at a fraction of the whole spectrum's RMS. Without
   that floor it was floored only at 1e-12, which is a guard against dividing
   by zero, not a statement about audio: in a band holding no chord energy the
   local σ collapses to the noise floor and that band's noise standardises up
   to a real partial's z-score. Because the fundamental-evidence gate reads
   the whitened spectrum, the gate meant to reject invented notes was running
   in the coordinate system that invented them.

   Measured: this was 38% of all ghosts, essentially all of them below the
   chord's bass. Flooring at 0.3 takes F1 0.658 -> 0.790 with recall
   unchanged. The curve is broad — a factor of ten in the constant moves F1
   by ~0.04 — which is what you want from a noise floor.

   Known risk: a genuinely quiet low bass more than ~40 dB below the spectral
   RMS would be suppressed. The corpus has low bass but never quiet low bass,
   so this is untested rather than ruled out. */
function whiten(y,wfloor=0.3){
  const W=12*BPS, out=new Float32Array(NB);
  const c=new Float64Array(NB+1), c2=new Float64Array(NB+1);
  let en=0;
  for(let i=0;i<NB;i++){ c[i+1]=c[i]+y[i]; c2[i+1]=c2[i]+y[i]*y[i]; en+=y[i]*y[i]; }
  const fl=Math.pow(wfloor*Math.sqrt(en/NB),2);
  for(let i=0;i<NB;i++){
    const a=Math.max(0,i-W), b=Math.min(NB,i+W+1), m=b-a;
    const mu=(c[b]-c[a])/m, va=Math.max(fl,1e-12,(c2[b]-c2[a])/m-mu*mu);
    out[i]=Math.max(0,(y[i]-mu)/Math.sqrt(va));
  }
  return out;
}

/* ---------------- note dictionary ---------------- */
/* `fund` scales the first partial only. With the plain s^(h-1) profile the
   fundamental is always the strongest component of a template, so a note
   whose fundamental is genuinely weaker than its second partial cannot be
   represented at all — and the cheapest way for the fit to explain such a
   spectrum is to put the note an octave up, where the strong 2f0 becomes a
   fundamental it can model. That is the octave-up error, and it is why the
   `formant` timbre (fundamental deliberately not the loudest partial) is the
   worst case in the corpus. fund<1 lets the dictionary say what real strings,
   small speakers and most microphones do to a low fundamental. */
let dict=null, dictKey='';
function buildDict(a4,s,fund=1){
  const key=a4.toFixed(3)+'|'+s+'|'+fund;
  if(dictKey===key) return dict;
  const D=[], fundBin=new Float32Array(NN_COUNT);
  for(let i=0;i<NN_COUNT;i++){
    const midi=NOTE_LO+i, f0=midiFreq(midi,a4);
    const col=new Float32Array(NB);
    fundBin[i]=freqBin(f0,a4);
    for(let h=1;h<=20;h++){
      const p=freqBin(f0*h,a4);
      if(p>=NB-1) break;
      const a=Math.pow(s,h-1)*(h===1?fund:1);
      const b0=Math.floor(p);
      let tot=0; const w=[];
      for(let d=-1;d<=2;d++){ const u=Math.abs(p-(b0+d)); const v=Math.max(0,1-u/1.5); w.push(v); tot+=v; }
      for(let d=-1;d<=2;d++){ const b=b0+d; if(b>=0&&b<NB&&tot>0) col[b]+=a*w[d+1]/tot; }
    }
    let nrm=0; for(let k=0;k<NB;k++) nrm+=col[k]*col[k];
    nrm=Math.sqrt(nrm)||1;
    for(let k=0;k<NB;k++) col[k]/=nrm;
    D.push(col);
  }
  dict={D,fundBin}; dictKey=key; return dict;
}

/* ---------------- NNLS via FISTA + non-negative projection ---------------- */
function nnls(D,cols,y,iters,l1){
  const m=cols.length;
  const G=new Float64Array(m*m), b=new Float64Array(m);
  for(let i=0;i<m;i++){
    const ci=D[cols[i]];
    let s=0; for(let k=0;k<NB;k++) s+=ci[k]*y[k];
    b[i]=s;
    for(let j=i;j<m;j++){
      const cj=D[cols[j]];
      let g=0; for(let k=0;k<NB;k++) g+=ci[k]*cj[k];
      G[i*m+j]=g; G[j*m+i]=g;
    }
  }
  // Lipschitz constant by power iteration
  let v=new Float64Array(m).fill(1/Math.sqrt(m)), L=1;
  for(let it=0;it<40;it++){
    const w=new Float64Array(m);
    for(let i=0;i<m;i++){ let s=0; for(let j=0;j<m;j++) s+=G[i*m+j]*v[j]; w[i]=s; }
    let nr=0; for(let i=0;i<m;i++) nr+=w[i]*w[i];
    nr=Math.sqrt(nr); if(nr<1e-12) break;
    L=nr; for(let i=0;i<m;i++) v[i]=w[i]/nr;
  }
  L=Math.max(L,1e-9);
  let x=new Float64Array(m), z=new Float64Array(m), t=1;
  for(let it=0;it<iters;it++){
    const xn=new Float64Array(m);
    for(let i=0;i<m;i++){
      let g=0; for(let j=0;j<m;j++) g+=G[i*m+j]*z[j];
      xn[i]=Math.max(0, z[i]-(g-b[i]+l1)/L);
    }
    const tn=(1+Math.sqrt(1+4*t*t))/2, r=(t-1)/tn;
    for(let i=0;i<m;i++) z[i]=xn[i]+r*(xn[i]-x[i]);
    x=xn; t=tn;
  }
  return x;
}

export {BPS,LO,NB,NOTE_LO,NN_COUNT,logSpec,whiten,buildDict,nnls};
