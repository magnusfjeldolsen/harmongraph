/* ============================================================
   Per-note timbre fingerprints, read out of an analyzeSegment()
   result. Nothing here changes the pipeline: it only reads
   `yraw`, `detN` and `fundBin`, all of which analyzeSegment
   already returns, and re-derives the dictionary through the same
   cached buildDict().

   The one non-obvious point. The NNLS front end *whitens* the
   spectrum, and whitening is a running mean/σ standardisation over
   ±1 octave — that is, it is specifically designed to delete the
   spectral envelope, because the envelope is what makes the same
   chord on two instruments fit the dictionary differently. The
   envelope is also the only thing that tells two instruments
   apart. So every fingerprint here is read off `yraw`, the
   un-whitened log-frequency spectrum, and never off `yw`.

     partialProfile()  observed amplitude + cents deviation for
                       partials 1..H of one detected note
     features()        the candidate fingerprints built from it
   ============================================================ */
import {NB,LO,BPS,NOTE_LO,buildDict} from '../../js/dsp/nnls.js';
import {midiFreq} from '../../js/pitch.js';

export const H_MAX = 12;          // partials per fingerprint
const EPS = 1e-9;

const freqBin = (f,a4) => (69+12*Math.log2(f/a4)-LO)*BPS;
const centsPerBin = 100/BPS;      // 3 bins per semitone -> 33.3 cents

/* linear read of a log-frequency spectrum at a fractional bin */
function at(y,p){
  if(p<0 || p>=NB-1) return 0;
  const b=Math.floor(p), fr=p-b;
  return y[b]*(1-fr)+y[b+1]*fr;
}

/* ---------------- one note's observed partial series ----------------
   For partial h of a note at f0 we look in a ±1 bin (±33 cent) window
   around the ideal position h·f0, take the local maximum, and refine it
   parabolically. The refined offset is what an inharmonicity estimate
   can be fitted to; the refined height is the partial amplitude.

   `share` is the NNLS's own opinion of how much of that bin belongs to
   this note rather than to the other detected notes — the same
   ownership ratio pFund already computes, evaluated at every partial
   instead of only at the fundamental. It is the only handle the
   pipeline gives on partial collision, so `ampAttr` exists to test
   whether using it helps. */
export function partialProfile(R,noteIndex,opts={}){
  const {a4=440, decay=0.72, fund=1, H=H_MAX, act=null} = opts;
  const {D} = buildDict(a4,decay,fund);
  const {yraw} = R;
  // `act` lets the oracle run: the share denominator must be built from
  // the note set being profiled, and in oracle mode that is the true
  // notes, not the detected ones.
  const detN = act || R.detN;
  const f0 = midiFreq(NOTE_LO+noteIndex,a4);

  const amp=new Float64Array(H), ampAttr=new Float64Array(H);
  const cents=new Float64Array(H), ok=new Uint8Array(H);

  for(let h=1;h<=H;h++){
    const p=freqBin(f0*h,a4);
    if(p<1 || p>=NB-2){ continue; }
    const b0=Math.round(p);
    // local max in ±1 bin
    let bm=b0, vm=yraw[b0];
    for(const d of [-1,1]){
      const b=b0+d;
      if(b>=1 && b<NB-1 && yraw[b]>vm){ vm=yraw[b]; bm=b; }
    }
    // parabolic refinement on the three points around the max
    const ym1=yraw[bm-1], y0=yraw[bm], yp1=yraw[bm+1];
    const den=(ym1-2*y0+yp1);
    let delta = den<0 ? 0.5*(ym1-yp1)/den : 0;
    if(!isFinite(delta) || Math.abs(delta)>0.5) delta=0;
    const peak = y0 - 0.25*(ym1-yp1)*delta;

    amp[h-1]=Math.max(0,peak);
    cents[h-1]=((bm+delta)-p)*centsPerBin;
    ok[h-1]=1;

    // ownership share at the nearest integer bin
    let own=0, tot=0;
    for(let j=0;j<D.length;j++){
      const v=detN[j]*D[j][bm];
      if(v<=0) continue;
      tot+=v; if(j===noteIndex) own=v;
    }
    ampAttr[h-1]= tot>1e-12 ? amp[h-1]*(own/tot) : 0;
  }
  return {amp,ampAttr,cents,ok,H};
}

/* ---------------- scalar descriptors of a partial series ---------------- */
function descriptors(amp,cents,ok,H){
  let sum=0, n=0, logSum=0, sumOdd=0, sumEven=0;
  for(let h=1;h<=H;h++){
    if(!ok[h-1]) continue;
    const a=Math.max(amp[h-1],EPS);
    sum+=a; n++; logSum+=Math.log(a);
    if(h%2===1) sumOdd+=a; else sumEven+=a;
  }
  if(!n || sum<=0) return {centroid:1,spread:0,flatness:1,slope:0,oddEven:0,tilt:0,B:0};

  // centroid/spread in *partial index* units, not Hz: an Hz centroid is
  // dominated by the note's own pitch, which would cluster by register
  // rather than by instrument and score well for the wrong reason.
  let c=0;
  for(let h=1;h<=H;h++) if(ok[h-1]) c+=h*Math.max(amp[h-1],EPS);
  c/=sum;
  let v=0;
  for(let h=1;h<=H;h++) if(ok[h-1]) v+=(h-c)*(h-c)*Math.max(amp[h-1],EPS);
  v/=sum;

  const flatness = Math.exp(logSum/n)/(sum/n);

  // OLS slope of log amplitude against partial index — the rolloff
  let sx=0,sy=0,sxx=0,sxy=0;
  for(let h=1;h<=H;h++){
    if(!ok[h-1]) continue;
    const x=h-1, y=Math.log10(Math.max(amp[h-1],EPS));
    sx+=x; sy+=y; sxx+=x*x; sxy+=x*y;
  }
  const den=n*sxx-sx*sx;
  const slope = Math.abs(den)>1e-12 ? (n*sxy-sx*sy)/den : 0;

  // second-order term: does the rolloff bend? separates 'dark' (fast,
  // then nothing) from 'bright' (slow and straight)
  let tilt=0, tn=0;
  for(let h=1;h<=H;h++){
    if(!ok[h-1]) continue;
    const x=h-1, y=Math.log10(Math.max(amp[h-1],EPS));
    tilt += (y-(sy/n)) * ((x-sx/n)*(x-sx/n) - sxx/n + (sx/n)*(sx/n));
    tn++;
  }
  tilt = tn ? tilt/tn : 0;

  const oddEven = Math.log10((sumOdd+EPS)/(sumEven+EPS));

  // inharmonicity: f_h = h f0 sqrt(1+B h²) is, in cents,
  //   dev_h = 600 log2(1+B h²) ≈ (600/ln2) B h²
  // so B falls out of a weighted least squares of dev against h².
  // Weighted by amplitude: a partial that is not there carries no
  // position information.
  let num=0, dnm=0;
  for(let h=2;h<=H;h++){
    if(!ok[h-1]) continue;
    const w=Math.max(amp[h-1],EPS);
    const x=865.617*h*h;                    // 600/ln2 · h²
    num+=w*x*cents[h-1]; dnm+=w*x*x;
  }
  const B = dnm>1e-12 ? num/dnm : 0;

  return {centroid:c, spread:Math.sqrt(v), flatness, slope, tilt, oddEven, B:B*1e4};
}

/* ---------------- the candidate fingerprints ----------------
   Every one of them must be invariant to how loud the note is: a
   quiet note of instrument A must land near a loud note of
   instrument A. So the partial vectors are all offset-removed in
   the log domain. */
export const FEATURE_SETS = [
  'logP',        // log10 partial amplitudes 1..H, mean removed
  'dbFund',      // partials 2..H in dB relative to the fundamental
  'shape',       // centroid, spread, flatness, slope, tilt, odd/even
  'inharmB',     // the inharmonicity coefficient alone
  'shapeB',      // shape + B
  'logPB',       // logP + B
  'logPattr',    // logP built from collision-attributed amplitudes
  'logP6',       // the first 6 partials only
  'all'          // logP + shape + B
];

function vec(name,pr){
  const {amp,ampAttr,cents,ok,H}=pr;
  const d=descriptors(amp,cents,ok,H);
  const logs=(a,hi)=>{
    const v=[]; let s=0,n=0;
    for(let h=1;h<=hi;h++){ const x=Math.log10(Math.max(ok[h-1]?a[h-1]:0,EPS)); v.push(x); s+=x; n++; }
    const m=s/n; return v.map(x=>x-m);          // level-invariant
  };
  const shape=[d.centroid,d.spread,d.flatness,d.slope,d.tilt,d.oddEven];
  switch(name){
    case 'logP':     return logs(amp,H);
    case 'logP6':    return logs(amp,6);
    case 'logPattr': return logs(ampAttr,H);
    case 'dbFund': {
      const a1=Math.max(amp[0],EPS), v=[];
      for(let h=2;h<=H;h++) v.push(20*Math.log10(Math.max(ok[h-1]?amp[h-1]:0,EPS)/a1));
      return v;
    }
    case 'shape':    return shape;
    case 'inharmB':  return [d.B];
    case 'shapeB':   return [...shape,d.B];
    case 'logPB':    return [...logs(amp,H),d.B];
    case 'all':      return [...logs(amp,H),...shape,d.B];
    default: throw new Error('unknown feature set '+name);
  }
}

/* Build the feature matrix for one segment: one row per detected note.
   Standardised per dimension *within the segment*, because clustering
   happens inside one segment and there is no training set to
   standardise against. Zero-variance dimensions are dropped rather
   than blown up. */
export function features(profiles,name){
  const X=profiles.map(p=>vec(name,p));
  const n=X.length, d=X[0].length;
  const mu=new Array(d).fill(0), sd=new Array(d).fill(0);
  for(let j=0;j<d;j++){
    for(let i=0;i<n;i++) mu[j]+=X[i][j];
    mu[j]/=n;
    for(let i=0;i<n;i++) sd[j]+=(X[i][j]-mu[j])**2;
    sd[j]=Math.sqrt(sd[j]/Math.max(1,n-1));
  }
  const keep=[]; for(let j=0;j<d;j++) if(sd[j]>1e-9) keep.push(j);
  if(!keep.length) return X.map(()=>[0]);
  return X.map(r=>keep.map(j=>(r[j]-mu[j])/sd[j]));
}

/* the un-standardised fingerprint, for comparisons that have to be made
   on a common scale across segments rather than within one */
export const rawVector = (name,pr) => vec(name,pr);

export {descriptors};
