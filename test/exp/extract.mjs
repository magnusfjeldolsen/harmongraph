/* ============================================================
   Pass 1 of the voice-clustering study: run the shipped pipeline
   over the two-instrument corpus and write out, per detected note,
   the observed partial series that a timbre fingerprint would be
   built from.

     node test/exp/extract.mjs                 -> test/exp/profiles-2.5.json
     node test/exp/extract.mjs --dur 1.0       -> test/exp/profiles-1.0.json
     node test/exp/extract.mjs --limit 20      short smoke run

   Split from the analysis pass because the DSP is the slow part and
   the clustering questions all want to be asked repeatedly of the
   same detections.
   ============================================================ */
import {writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {voiceCorpus,SR,DUR} from '../corpus.mjs';
import {analyzeSegment} from '../../js/analyzeSegment.js';
import {NOTE_LO,NN_COUNT,buildDict,nnls} from '../../js/dsp/nnls.js';
import {partialProfile,H_MAX} from './fingerprint.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));

/* the shipped defaults, exactly as test/harness.mjs uses them */
const OPTS={a4:440, fftN:16384, decay:0.72, fund:1, hpss:true,
            thr:0.12, gate:0.08, nms:1.5, maxNotes:12};

const args=process.argv.slice(2);
let dur=DUR, limit=Infinity, out=null;
for(let i=0;i<args.length;i++){
  if(args[i]==='--dur') dur=+args[++i];
  else if(args[i]==='--limit') limit=+args[++i];
  else if(args[i]==='--out') out=args[++i];
  else { console.error('unknown flag '+args[i]); process.exit(2); }
}
if(!out) out=`profiles-${dur}.json`;

const r6=v=>+(+v).toPrecision(6);

const segments=[];
let n=0;
for(const seg of voiceCorpus(dur)){
  if(n>=limit) break;
  n++;
  const sig=seg.signal;
  const t0=performance.now();
  const R=await analyzeSegment(sig,SR,OPTS);
  const t1=performance.now();

  const setA=new Set(seg.truthA), setB=new Set(seg.truthB);
  const notes=R.notes.map(nt=>{
    const p=partialProfile(R,nt.i,{a4:OPTS.a4,decay:OPTS.decay,fund:OPTS.fund,H:H_MAX});
    const inA=setA.has(nt.midi), inB=setB.has(nt.midi);
    return {
      midi:nt.midi, name:nt.name, db:r6(nt.db), pFund:r6(nt.pFund),
      act:r6(nt.activation),
      // A / B = uniquely one player's, S = both play it, G = ghost
      label: inA&&inB ? 'S' : inA ? 'A' : inB ? 'B' : 'G',
      amp:Array.from(p.amp,r6), ampAttr:Array.from(p.ampAttr,r6),
      cents:Array.from(p.cents,r6), ok:Array.from(p.ok)
    };
  });
  const t2=performance.now();

  /* --- oracle: the same fingerprints read at the *true* note
     positions, whether or not the detector found them. This is the
     ceiling for the method. Without it a bad clustering number is
     ambiguous between "timbre fingerprints do not separate
     instruments" and "the detector never handed us both
     instruments' notes", and it turns out to be the second. The
     activation vector is refit by NNLS restricted to the true
     columns, so the collision shares are the oracle's own. */
  const truth=[...new Set([...seg.truthA,...seg.truthB])].sort((a,b)=>a-b);
  const cols=truth.map(m=>m-NOTE_LO).filter(i=>i>=0&&i<NN_COUNT);
  const {D}=buildDict(OPTS.a4,OPTS.decay,OPTS.fund);
  const xo=cols.length? nnls(D,cols,R.yw,320,0.004) : [];
  const actO=new Float64Array(NN_COUNT);
  let mx=0; for(const v of xo) if(v>mx) mx=v;
  cols.forEach((c,i)=>{ actO[c]= mx>0 ? xo[i]/mx : 0; });
  const oracle=cols.map(c=>{
    const midi=NOTE_LO+c;
    const p=partialProfile(R,c,{a4:OPTS.a4,decay:OPTS.decay,fund:OPTS.fund,H:H_MAX,act:actO});
    const inA=setA.has(midi), inB=setB.has(midi);
    return {
      midi, label: inA&&inB ? 'S' : inA ? 'A' : 'B',
      detected: R.notes.some(nt=>nt.midi===midi)?1:0,
      act:r6(actO[c]),
      amp:Array.from(p.amp,r6), ampAttr:Array.from(p.ampAttr,r6),
      cents:Array.from(p.cents,r6), ok:Array.from(p.ok)
    };
  });

  segments.push({
    id:seg.id, kind:seg.kind, k:seg.k, pair:seg.pair, dist:seg.dist,
    arrangement:seg.arrangement, arrKind:seg.arrKind, db:seg.db,
    timbreA:seg.timbreA, timbreB:seg.timbreB,
    truthA:seg.truthA, truthB:seg.truthB, shared:seg.shared,
    msAnalyze:+(t1-t0).toFixed(1), msProfile:+(t2-t1).toFixed(2),
    notes, oracle
  });
  process.stdout.write(segments.length%50===0 ? String(segments.length)+' ' : '.');
}
process.stdout.write('\n');

const p=resolve(HERE,out);
writeFileSync(p,JSON.stringify({
  generated:new Date().toISOString().slice(0,10), node:process.version,
  dur, sr:SR, opts:OPTS, H:H_MAX, segments
})+'\n');
console.log(`wrote ${p} — ${segments.length} segments, `+
  `${segments.reduce((s,x)=>s+x.notes.length,0)} detected notes`);
