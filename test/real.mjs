/* Real-audio benchmark — `node test/real.mjs <dataset-dir>`
   No dependencies. The dataset is not in this repo; see docs/BENCHMARK.md.

   The synthetic corpus in test/corpus.mjs is generated from the same model
   buildDict() assumes, so it cannot expose a timbre-mismatch failure — that
   is the flaw RESEARCH.md §10 identified in the original accuracy figures,
   and it applies to our own corpus too. This runs the same pipeline against
   recordings of a real instrument, annotated by someone else.

   Two window kinds, answering two different questions:
     comp — one strum, fenced from its onset to the next. The app's actual
            use case.
     solo — one note, with nothing else sounding across it. This is the
            reported complaint stated as a measurement: play one note, how
            often do you get exactly one note back? */

import {readFileSync} from 'node:fs';
import {analyzeSegment} from '../js/analyzeSegment.js';

const DIR=process.argv[2];
if(!DIR){ console.error('usage: node test/real.mjs <dataset-dir>'); process.exit(2); }
const only=process.argv.includes('--comp')?'comp':process.argv.includes('--solo')?'solo':null;

/* ---- minimal 16-bit PCM WAV reader ---- */
function readWav(path){
  const b=readFileSync(path);
  if(b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WAVE') throw new Error('not a WAV: '+path);
  let p=12, fmt=null, data=null;
  while(p+8<=b.length){
    const id=b.toString('ascii',p,p+4), sz=b.readUInt32LE(p+4);
    if(id==='fmt ') fmt={ch:b.readUInt16LE(p+10), sr:b.readUInt32LE(p+12), bits:b.readUInt16LE(p+22)};
    else if(id==='data') data={off:p+8, len:sz};
    p+=8+sz+(sz&1);
  }
  if(!fmt||!data) throw new Error('missing chunk in '+path);
  if(fmt.bits!==16) throw new Error('expected 16-bit, got '+fmt.bits);
  const n=Math.floor(data.len/2/fmt.ch), out=new Float32Array(n);
  for(let i=0;i<n;i++){                       // downmix if ever stereo
    let s=0;
    for(let c=0;c<fmt.ch;c++) s+=b.readInt16LE(data.off+(i*fmt.ch+c)*2);
    out[i]=s/fmt.ch/32768;
  }
  return {pcm:out, sr:fmt.sr};
}

const wins=JSON.parse(readFileSync(DIR+'/windows.json','utf8'))
  .filter(w=>!only||w.kind===only);

/* ---- scoring ---- */
const rel=(g,t)=>{                            // how a ghost relates to a true note
  for(const x of t){
    const d=g-x;
    if(d!==0&&d%12===0) return 'oct';
    if(d===7||d===-7||d===19||d===-19) return '5th';
  }
  return 'oth';
};
const acc={};
const bucket=k=>acc[k]||(acc[k]={n:0,tp:0,fp:0,fn:0,oct:0,fifth:0,oth:0,exact:0,extra:0,ms:0,
                                 pfHit:0,pfHitN:0,pfGho:0,pfGhoN:0});

let cache={path:null,wav:null}, done=0;
for(const w of wins){
  const path=DIR+'/audio/'+w.file+'_mic.wav';
  if(cache.path!==path){ cache={path,wav:readWav(path)}; }
  const {pcm,sr}=cache.wav;
  const a=Math.max(0,Math.round(w.start*sr));
  const b=Math.min(pcm.length,Math.round((w.start+w.dur)*sr));
  if(b-a<2048) continue;

  const t0=Date.now();
  const R=await analyzeSegment(Float32Array.from(pcm.subarray(a,b)),sr,{});
  const ms=Date.now()-t0;

  const got=R.notes.map(n=>n.midi), truth=w.truth;
  const B=bucket(w.kind);
  B.n++; B.ms+=ms;
  const hit=got.filter(g=>truth.includes(g));
  const ghost=got.filter(g=>!truth.includes(g));
  B.tp+=hit.length; B.fp+=ghost.length; B.fn+=truth.filter(t=>!got.includes(t)).length;
  for(const g of ghost){ const k=rel(g,truth); B[k==='oct'?'oct':k==='5th'?'fifth':'oth']++; }
  for(const n of R.notes){
    if(truth.includes(n.midi)){ B.pfHit+=n.pFund; B.pfHitN++; }
    else { B.pfGho+=n.pFund; B.pfGhoN++; }
  }
  if(w.kind==='solo'){
    if(got.length===1&&got[0]===truth[0]) B.exact++;
    B.extra+=Math.max(0,got.length-1);
  }else{
    if(hit.length===truth.length&&ghost.length===0) B.exact++;
  }
  if(++done%100===0) process.stderr.write('.');
}
process.stderr.write('\n');

const f=(x,d=3)=>x.toFixed(d);
console.log('\nGuitarSet — real acoustic guitar, mono mic, annotated per string\n');
console.log('kind   wins   recall  prec.    F1     oct  5th  oth   P(real) hit/ghost   ms');
for(const k of ['comp','solo']){
  const B=acc[k]; if(!B) continue;
  const rc=B.tp/(B.tp+B.fn||1), pr=B.tp/(B.tp+B.fp||1);
  console.log(`${k.padEnd(6)} ${String(B.n).padStart(4)}   ${f(rc)}  ${f(pr)}  ${f(2*rc*pr/(rc+pr||1))}  `+
    `${String(B.oct).padStart(4)} ${String(B.fifth).padStart(4)} ${String(B.oth).padStart(4)}   `+
    `${f(B.pfHit/(B.pfHitN||1),2)} / ${f(B.pfGho/(B.pfGhoN||1),2)}        ${(B.ms/B.n).toFixed(0)}`);
}
if(acc.solo){
  const B=acc.solo;
  console.log(`\nsingle notes: exactly one note returned, and correct, ${B.exact}/${B.n} = ${f(B.exact/B.n)}`);
  console.log(`              mean spurious extra notes per single note: ${f(B.extra/B.n,2)}`);
}
if(acc.comp){
  const B=acc.comp;
  console.log(`chords:       every note right and no ghosts, ${B.exact}/${B.n} = ${f(B.exact/B.n)}`);
}
