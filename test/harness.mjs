/* ============================================================
   Evaluation harness.

     node test/harness.mjs                     print the table
     node test/harness.mjs --save              print, then write baseline.json
     node test/harness.mjs --compare baseline.json    before/after deltas
     node test/harness.mjs --timbre hollow     restrict to one timbre
     node test/harness.mjs --voicing guitar    restrict to matching voicings
     node test/harness.mjs --json              machine-readable dump

   Zero dependencies, no npm install, Node ESM only.

   Ghost taxonomy. A detected note that is not in the ground truth is
   attributed to the true note it is most plausibly a spectral relative
   of, by pitch-class distance:

     oct   some true note t with (ghost - t) ≡ 0  (mod 12)
     5th   some true note t with (ghost - t) ≡ 7  (mod 12)  fifth / twelfth up
           or                    (ghost - t) ≡ 5  (mod 12)  fifth / twelfth down
     oth   everything else

   Octave takes priority over fifth, and both over other, because an
   octave relation is the stronger claim about where the energy came
   from.

   P(real) hit/ghost is the mean pFund on true positives against the
   mean on ghosts. The gap between them is the number handoff Task 3
   has to move; it is reported per timbre because §2 claims it goes
   negative on `dark`.
   ============================================================ */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {corpus,corpusStats,TIMBRES,SR} from './corpus.mjs';
import {analyzeSegment} from '../js/analyzeSegment.js';

const HERE=dirname(fileURLToPath(import.meta.url));

/* current app defaults — do not tune these here, they are the
   product's settings and the harness only measures them */
const OPTS={a4:440, fftN:16384, decay:0.72, hpss:true,
            thr:0.12, gate:0.08, nms:1.5, maxNotes:12};

const RUNTIME_BUDGET_MS=900;

/* ---------------- args ---------------- */
function parseArgs(argv){
  const a={save:false,compare:null,timbre:null,voicing:null,json:false,quiet:false,opt:{}};
  for(let i=0;i<argv.length;i++){
    const t=argv[i];
    // --opt decay=0.8 : override one pipeline setting for this run only, so a
    // hypothesis can be swept without editing the shipped defaults
    if(t==='--opt'){ const [k,v]=String(argv[++i]||'').split('='); a.opt[k]=(v==='true'||v==='false')?v==='true':+v; }
    else if(t==='--save') a.save=true;
    else if(t==='--compare') a.compare=argv[++i]||'baseline.json';
    else if(t==='--timbre') a.timbre=argv[++i];
    else if(t==='--voicing') a.voicing=argv[++i];
    else if(t==='--json') a.json=true;
    else if(t==='--quiet') a.quiet=true;
    else if(t==='--help'||t==='-h'){ console.log(HELP); process.exit(0); }
    else { console.error('unknown flag '+t); process.exit(2); }
  }
  return a;
}
const HELP=`node test/harness.mjs [--save] [--compare <file>] [--timbre <name>] [--voicing <substr>] [--json]`;

/* ---------------- scoring one chord ---------------- */
function classify(ghost,truth){
  let fifth=false;
  for(const t of truth){
    const d=((ghost-t)%12+12)%12;
    if(d===0) return 'oct';
    if(d===7||d===5) fifth=true;
  }
  return fifth?'5th':'oth';
}

function scoreChord(truth,notes){
  const det=notes.map(n=>n.midi);
  const truthSet=new Set(truth);
  const detSet=new Set(det);
  const r={tp:0,fp:0,fn:0,oct:0,fifth:0,oth:0,
           pfHit:[],pfGhost:[],hits:[],ghosts:[],misses:[]};
  for(const n of notes){
    if(truthSet.has(n.midi)){ r.tp++; r.pfHit.push(n.pFund); r.hits.push(n.midi); }
    else{
      r.fp++; r.pfGhost.push(n.pFund); r.ghosts.push(n.midi);
      const k=classify(n.midi,truth);
      if(k==='oct') r.oct++; else if(k==='5th') r.fifth++; else r.oth++;
    }
  }
  for(const t of truth) if(!detSet.has(t)){ r.fn++; r.misses.push(t); }
  return r;
}

const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const f1=(p,r)=>(p+r)>0?2*p*r/(p+r):0;

/* ---------------- run ---------------- */
async function run(args){
  const stats=corpusStats();
  const byTimbre=new Map();
  const perChord=[];
  const times=[];

  for(const c of corpus()){
    if(args.timbre && c.timbre!==args.timbre) continue;
    if(args.voicing && !c.voicing.includes(args.voicing)) continue;
    const sig=c.signal;
    const t0=performance.now();
    const R=await analyzeSegment(sig,SR,OPTS);
    const ms=performance.now()-t0;
    times.push(ms);

    const s=scoreChord(c.truth,R.notes);
    perChord.push({id:c.id,timbre:c.timbre,voicing:c.voicing,ms:+ms.toFixed(1),
                   truth:c.truth,detected:R.notes.map(n=>n.midi),
                   hits:s.hits,ghosts:s.ghosts,misses:s.misses,
                   oct:s.oct,fifth:s.fifth,oth:s.oth});

    if(!byTimbre.has(c.timbre)) byTimbre.set(c.timbre,
      {tp:0,fp:0,fn:0,oct:0,fifth:0,oth:0,pfHit:[],pfGhost:[],ms:[],chords:0});
    const A=byTimbre.get(c.timbre);
    A.tp+=s.tp; A.fp+=s.fp; A.fn+=s.fn;
    A.oct+=s.oct; A.fifth+=s.fifth; A.oth+=s.oth;
    A.pfHit.push(...s.pfHit); A.pfGhost.push(...s.pfGhost);
    A.ms.push(ms); A.chords++;
    if(!args.quiet && !args.json) process.stdout.write('.');
  }
  if(!args.quiet && !args.json) process.stdout.write('\n');

  const timbres={};
  let T={tp:0,fp:0,fn:0,oct:0,fifth:0,oth:0,pfHit:[],pfGhost:[],chords:0};
  for(const name of TIMBRES){
    const A=byTimbre.get(name); if(!A) continue;
    const recall=A.tp/(A.tp+A.fn||1), prec=A.tp/(A.tp+A.fp||1);
    const h=mean(A.pfHit), g=mean(A.pfGhost);
    timbres[name]={
      recall:+recall.toFixed(4), precision:+prec.toFixed(4), f1:+f1(prec,recall).toFixed(4),
      oct:A.oct, fifth:A.fifth, other:A.oth, miss:A.fn, ghosts:A.fp,
      pfHit:h===null?null:+h.toFixed(4), pfGhost:g===null?null:+g.toFixed(4),
      confGap:(h===null||g===null)?null:+(h-g).toFixed(4),
      msMean:+mean(A.ms).toFixed(1), msMax:+Math.max(...A.ms).toFixed(1), chords:A.chords
    };
    T.tp+=A.tp; T.fp+=A.fp; T.fn+=A.fn; T.oct+=A.oct; T.fifth+=A.fifth; T.oth+=A.oth;
    T.pfHit.push(...A.pfHit); T.pfGhost.push(...A.pfGhost); T.chords+=A.chords;
  }
  const recall=T.tp/(T.tp+T.fn||1), prec=T.tp/(T.tp+T.fp||1);
  const h=mean(T.pfHit), g=mean(T.pfGhost);
  const overall={
    recall:+recall.toFixed(4), precision:+prec.toFixed(4), f1:+f1(prec,recall).toFixed(4),
    oct:T.oct, fifth:T.fifth, other:T.oth, miss:T.fn, ghosts:T.fp,
    pfHit:h===null?null:+h.toFixed(4), pfGhost:g===null?null:+g.toFixed(4),
    confGap:(h===null||g===null)?null:+(h-g).toFixed(4),
    msMean:+mean(times).toFixed(1), msMax:+Math.max(...times).toFixed(1),
    chords:T.chords, notes:T.tp+T.fn
  };
  return {opts:OPTS, corpus:stats, timbres, overall, perChord};
}

/* ---------------- printing ---------------- */
const f3=v=>v===null||v===undefined?'  —  ':v.toFixed(3);
const f2=v=>v===null||v===undefined?' — ':v.toFixed(2);

function printTable(res){
  console.log('');
  console.log('timbre        recall  prec.   oct  5th  oth  miss   P(real) hit/ghost');
  const row=(name,r)=>
    name.padEnd(13)+
    f3(r.recall).padStart(5)+'  '+f3(r.precision).padStart(5)+'  '+
    String(r.oct).padStart(4)+String(r.fifth).padStart(5)+
    String(r.other).padStart(5)+String(r.miss).padStart(6)+'   '+
    f2(r.pfHit)+' / '+f2(r.pfGhost)+
    (r.confGap!==null && r.confGap<0 ? '   <- inverted' : '');
  for(const [name,r] of Object.entries(res.timbres)) console.log(row(name,r));
  const o=res.overall;
  console.log(row('OVERALL',o));
  console.log('');
  console.log('F1 '+f3(o.f1)+
    ' · octave-errors '+o.oct+' · fifth-errors '+o.fifth+
    ' · ghosts '+o.ghosts+' · misses '+o.miss+' · conf-gap '+f2(o.confGap));
  console.log('runtime '+o.msMean.toFixed(0)+' ms/chord mean, '+o.msMax.toFixed(0)+
    ' ms max (budget '+RUNTIME_BUDGET_MS+' ms) '+
    (o.msMax<=RUNTIME_BUDGET_MS?'OK':'OVER BUDGET'));
  console.log(res.corpus.voicings+' voicings × '+res.corpus.timbres+' timbres = '+
    o.chords+' chords, '+o.notes+' notes');
}

function printCompare(base,now){
  const d=(a,b)=>{ if(a===null||b===null||a===undefined||b===undefined) return '   —  ';
    const v=b-a; return (v>=0?'+':'')+v.toFixed(3); };
  const di=(a,b)=>{ const v=b-a; return (v>=0?'+':'')+v; };
  console.log('');
  console.log('compare vs baseline           recall            precision              F1             oct      5th    ghosts  conf-gap');
  const names=[...new Set([...Object.keys(base.timbres),...Object.keys(now.timbres)])];
  let regressions=[];
  for(const n of [...names,'OVERALL']){
    const B = n==='OVERALL'?base.overall:base.timbres[n];
    const A = n==='OVERALL'?now.overall :now.timbres[n];
    if(!B||!A) continue;
    console.log(
      n.padEnd(13)+
      f3(B.recall)+'->'+f3(A.recall)+' '+d(B.recall,A.recall).padStart(7)+'  '+
      f3(B.precision)+'->'+f3(A.precision)+' '+d(B.precision,A.precision).padStart(7)+'  '+
      f3(B.f1)+'->'+f3(A.f1)+' '+d(B.f1,A.f1).padStart(7)+'  '+
      di(B.oct,A.oct).padStart(5)+di(B.fifth,A.fifth).padStart(7)+
      di(B.ghosts,A.ghosts).padStart(8)+' '+d(B.confGap,A.confGap).padStart(8));
    if(n!=='OVERALL' && A.f1 < B.f1-0.001) regressions.push(`${n}  F1 ${B.f1.toFixed(3)} -> ${A.f1.toFixed(3)}`);
    if(n!=='OVERALL' && A.oct > B.oct) regressions.push(`${n}  octave errors ${B.oct} -> ${A.oct}`);
    if(n!=='OVERALL' && A.fifth > B.fifth) regressions.push(`${n}  fifth errors ${B.fifth} -> ${A.fifth}`);
  }
  console.log('');
  console.log('runtime '+base.overall.msMean.toFixed(0)+' -> '+now.overall.msMean.toFixed(0)+
    ' ms/chord mean, max '+now.overall.msMax.toFixed(0)+' ms '+
    (now.overall.msMax<=RUNTIME_BUDGET_MS?'(within budget)':'(OVER BUDGET)'));
  if(regressions.length){
    console.log('\nPER-TIMBRE REGRESSIONS');
    regressions.forEach(r=>console.log('  ! '+r));
  }else{
    console.log('\nno per-timbre regressions');
  }
}

/* ---------------- main ---------------- */
const args=parseArgs(process.argv.slice(2));
if(Object.keys(args.opt).length){
  Object.assign(OPTS,args.opt);
  console.log('overrides: '+JSON.stringify(args.opt));
}
const res=await run(args);

if(args.json){
  console.log(JSON.stringify(res,null,2));
}else{
  printTable(res);
}

if(args.compare){
  // a bare name means "next to this script"; anything with a separator
  // is taken as the user typed it
  const p=/[\\/]/.test(args.compare) ? resolve(args.compare) : resolve(HERE,args.compare);
  const base=JSON.parse(readFileSync(p,'utf8'));
  printCompare(base,res);
}

if(args.save){
  const out=resolve(HERE,'baseline.json');
  mkdirSync(dirname(out),{recursive:true});
  // perChord is kept: it is what lets a later task say *which* chord regressed
  writeFileSync(out,JSON.stringify({
    generated:new Date().toISOString().slice(0,10),
    node:process.version,
    ...res
  },null,2)+'\n');
  console.log('\nwrote '+out);
}
