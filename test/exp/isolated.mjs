/* ============================================================
   The mechanistic diagnostic. Everything else in this study is an
   end-to-end score; this is the measurement that says *why*.

   Three questions, in order:

     1  Do the fingerprints separate the six timbres at all, on
        single notes played completely alone? If not, the idea is
        dead before polyphony is even involved.
     2  How far does a note's fingerprint move when the same
        instrument plays it inside a chord instead of alone? That
        displacement is caused by partials of the *other notes of
        the same instrument* landing on it.
     3  Is that displacement smaller or larger than the distance
        between two different instruments? If it is larger, no
        clusterer can work, because within-instrument scatter
        exceeds between-instrument separation.

     node test/exp/isolated.mjs [--in profiles-2.5.json]
   ============================================================ */
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TIMBRES,ARRANGEMENTS,SR,DUR,synthNote} from '../corpus.mjs';
import {analyzeSegment} from '../../js/analyzeSegment.js';
import {NOTE_LO,NN_COUNT} from '../../js/dsp/nnls.js';
import {partialProfile,rawVector,FEATURE_SETS,H_MAX} from './fingerprint.mjs';
import {dist} from './cluster.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
let inFile='profiles-2.5.json';
for(let i=0;i<args.length;i++){ if(args[i]==='--in') inFile=args[++i]; }

const OPTS={a4:440, fftN:16384, decay:0.72, fund:1, hpss:true,
            thr:0.12, gate:0.08, nms:1.5, maxNotes:12};

/* --- the pitches the mixture corpus actually uses --- */
const PITCHES=[...new Set(ARRANGEMENTS.flatMap(a=>[...a.A,...a.B]))].sort((a,b)=>a-b);

console.log('isolated-note diagnostic');
console.log(`${PITCHES.length} pitches × ${TIMBRES.length} timbres\n`);

const iso=new Map();      // `${timbre}/${midi}` -> {vector per feature set}
let done=0;
for(const t of TIMBRES){
  for(const m of PITCHES){
    const sig=synthNote([m],t,0x77A1+m*7+TIMBRES.indexOf(t)*997,DUR);
    const R=await analyzeSegment(sig,SR,OPTS);
    const c=m-NOTE_LO;
    // a single note alone: it owns every bin, so the share vector is a
    // one-hot and `ampAttr` degenerates to `amp`, which is correct here
    const act=new Float64Array(NN_COUNT); act[c]=1;
    const p=partialProfile(R,c,{a4:OPTS.a4,decay:OPTS.decay,fund:OPTS.fund,H:H_MAX,act});
    const v={};
    for(const f of FEATURE_SETS) v[f]=rawVector(f,p);
    iso.set(`${t}/${m}`,v);
    if(++done%20===0) process.stdout.write(done+' ');
  }
}
process.stdout.write('\n');

/* ---- global standardisation, fitted on the isolated set so that the
   polyphonic fingerprints are measured in the same units ---- */
const scalers={};
for(const f of FEATURE_SETS){
  const X=[...iso.values()].map(v=>v[f]);
  const d=X[0].length, mu=new Array(d).fill(0), sd=new Array(d).fill(0);
  for(const r of X) for(let j=0;j<d;j++) mu[j]+=r[j]/X.length;
  for(const r of X) for(let j=0;j<d;j++) sd[j]+=(r[j]-mu[j])**2/Math.max(1,X.length-1);
  scalers[f]={mu, sd:sd.map(v=>Math.sqrt(v)||1)};
}
const z=(f,v)=>v.map((x,j)=>(x-scalers[f].mu[j])/scalers[f].sd[j]);

const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;

/* ---- 1. can the fingerprints tell the six timbres apart at all? ---- */
const keys=[...iso.keys()];
const timbreOf=k=>k.split('/')[0], midiOf=k=>+k.split('/')[1];

const q1=FEATURE_SETS.map(f=>{
  const V=new Map(keys.map(k=>[k,z(f,iso.get(k)[f])]));
  // leave-one-out 1-NN over all 6 timbres; chance = 1/6
  let hit=0;
  for(const k of keys){
    let bd=Infinity, bk=null;
    for(const j of keys){ if(j===k) continue;
      const d=dist(V.get(k),V.get(j)); if(d<bd){ bd=d; bk=j; } }
    if(timbreOf(bk)===timbreOf(k)) hit++;
  }
  // and pitch-invariance: same timbre across pitches vs same pitch across timbres
  let within=[], between=[];
  for(let a=0;a<keys.length;a++) for(let b=a+1;b<keys.length;b++){
    const d=dist(V.get(keys[a]),V.get(keys[b]));
    if(timbreOf(keys[a])===timbreOf(keys[b])) within.push(d);
    else if(midiOf(keys[a])===midiOf(keys[b])) between.push(d);
  }
  return {feature:f, nn6:hit/keys.length,
          withinTimbre:mean(within), betweenTimbre:mean(between),
          ratio:mean(within)/mean(between)};
});

/* ---- 2 + 3. how far does polyphony move a fingerprint? ---- */
const DB=JSON.parse(readFileSync(resolve(HERE,inFile),'utf8'));
const solos=DB.segments.filter(s=>s.kind==='solo');
const prof=n=>({amp:n.amp, ampAttr:n.ampAttr, cents:n.cents, ok:n.ok, H:DB.H});

const q2=FEATURE_SETS.map(f=>{
  const shift=[], byPoly=new Map();
  for(const s of solos){
    for(const n of s.oracle){
      const ref=iso.get(`${s.timbreA}/${n.midi}`);
      if(!ref) continue;
      const d=dist(z(f,rawVector(f,prof(n))),z(f,ref[f]));
      shift.push(d);
      const p=s.oracle.length;
      if(!byPoly.has(p)) byPoly.set(p,[]);
      byPoly.get(p).push(d);
    }
  }
  const bt=q1.find(r=>r.feature===f).betweenTimbre;
  return {feature:f, polyShift:mean(shift), betweenTimbre:bt,
          snr:bt/mean(shift),
          byPoly:[...byPoly.entries()].sort((a,b)=>a[0]-b[0])
                  .map(([p,v])=>({notes:p,n:v.length,shift:mean(v)}))};
});

/* ---- per-pair: the mean over all 15 timbre pairs hides the close ones,
   and the close ones are the whole question ---- */
const PAIRS_T=[['dark','bright'],['geometric','inharmonic'],
               ['hollow','formant'],['bright','formant'],['geometric','geometric']];
const q3=FEATURE_SETS.map(f=>{
  const V=new Map(keys.map(k=>[k,z(f,iso.get(k)[f])]));
  const shift=q2.find(r=>r.feature===f).polyShift;
  return {feature:f, pairs:PAIRS_T.map(([ta,tb])=>{
    const d=[];
    for(const m of PITCHES){
      const a=V.get(`${ta}/${m}`), b=V.get(`${tb}/${m}`);
      if(a&&b) d.push(dist(a,b));
    }
    return {pair:`${ta}+${tb}`, d:mean(d), snr:mean(d)/shift};
  })};
});

const f3=v=>v===null||Number.isNaN(v)?'  —  ':v.toFixed(3);
const pct=v=>v===null?'  — ':(100*v).toFixed(1).padStart(5);

console.log('\n1. Do the fingerprints separate the six timbres on ISOLATED single notes?');
console.log('   (leave-one-out 1-NN over 6 classes; chance 16.7%)\n');
console.log('fingerprint    1-NN 6-way   d(same timbre,   d(same pitch,    within/between');
console.log('               accuracy     diff pitch)      diff timbre)     <1 is good');
for(const r of q1)
  console.log(r.feature.padEnd(13)+pct(r.nn6)+'%      '+
    f3(r.withinTimbre).padStart(8)+'         '+f3(r.betweenTimbre).padStart(8)+'         '+f3(r.ratio));

console.log('\n2+3. How much does the SAME instrument playing a CHORD move the fingerprint?');
console.log('   (distance from a note\'s in-chord fingerprint to its own isolated one)\n');
console.log('fingerprint    poly shift   between-timbre   SNR = between/shift');
console.log('                            distance         (>1 needed for any clusterer)');
for(const r of q2)
  console.log(r.feature.padEnd(13)+f3(r.polyShift).padStart(8)+'     '+
    f3(r.betweenTimbre).padStart(8)+'         '+f3(r.snr));

const best=q2.slice().sort((a,b)=>b.snr-a.snr)[0];
console.log(`\nshift vs polyphony, ${best.feature} (the best SNR above):`);
for(const b of best.byPoly)
  console.log(`  ${String(b.notes).padStart(2)} notes sounding   n=${String(b.n).padStart(4)}   shift ${f3(b.shift)}`);

console.log('\n4. The same SNR, per instrument pair — the mean above hides the close pairs.');
console.log('   d = distance between the two timbres on the same isolated pitch;');
console.log('   SNR = d / the in-chord displacement of that fingerprint.\n');
{
  const heads=PAIRS_T.map(([a,b])=>`${a.slice(0,4)}+${b.slice(0,4)}`);
  console.log('fingerprint   '+heads.map(h=>h.padStart(14)).join(''));
  console.log('              '+heads.map(()=>'    d    SNR  ').join(''));
  for(const r of q3)
    console.log(r.feature.padEnd(13)+r.pairs.map(p=>
      f3(p.d).padStart(7)+f3(p.snr).padStart(7)).join(''));
}

writeFileSync(resolve(HERE,'isolated.json'),
  JSON.stringify({pitches:PITCHES,timbres:TIMBRES,q1,q2,q3},null,2)+'\n');
console.log('\nwrote '+resolve(HERE,'isolated.json'));
