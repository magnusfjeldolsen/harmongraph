/* ============================================================
   Pass 2 of the voice-clustering study. Reads the profiles written
   by extract.mjs and answers the five questions:

     1  clustering accuracy with k known      (acc, ARI)
     2  choosing k blind                      (false-split rate first)
     3  which fingerprint carries the signal
     4  where it breaks
     5  runtime of the added step

   Every table is produced twice:

     detected  the notes analyzeSegment actually returned — what a
               shipped feature would have to work with, ghosts and
               misses included
     oracle    the same fingerprints read at the true note positions
               whether or not the detector found them — the ceiling
               for the idea, with the detector's errors removed

   The gap between the two columns is the point. A bad `detected`
   number alone cannot distinguish "timbre fingerprints do not
   separate instruments" from "the detector never handed us both
   instruments' notes".

     node test/exp/report.mjs                     the 2.5 s corpus
     node test/exp/report.mjs --in profiles-1.0.json
     node test/exp/report.mjs --json
   ============================================================ */
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FEATURE_SETS,features} from './fingerprint.mjs';
import {kmeans,agglomerative,gmm,silhouette,gapStatistic,eigengap,
        bicSelect,ari,bestAccuracy,kmeansStability,pca,auc,
        rng as clusterRng} from './cluster.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
let inFile='profiles-2.5.json', asJson=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--in') inFile=args[++i];
  else if(args[i]==='--json') asJson=true;
  else { console.error('unknown flag '+args[i]); process.exit(2); }
}
const DB=JSON.parse(readFileSync(resolve(HERE,inFile),'utf8'));

const MIN_NOTES=3;                 // below this there is nothing to cluster
const KMAX=4;
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const pct=v=>v===null||Number.isNaN(v)?'  — ':(100*v).toFixed(1).padStart(5);
const f3=v=>v===null||Number.isNaN(v)?'  —  ':v.toFixed(3);
const prof=n=>({amp:n.amp, ampAttr:n.ampAttr, cents:n.cents, ok:n.ok, H:DB.H});
const rows=(seg,mode)=> mode==='oracle' ? seg.oracle : seg.notes;

/* ---------------- accuracy with k known ---------------- */
/* Only notes the corpus can label unambiguously are scored: a ghost
   belongs to no instrument and a shared pitch belongs to both. Both
   are counted and reported separately. */
function scoreSegment(seg,mode,fname,algo){
  const R=rows(seg,mode);
  if(R.length<MIN_NOTES) return null;
  const idx=[], y=[];
  R.forEach((n,i)=>{ if(n.label==='A'||n.label==='B'){ idx.push(i); y.push(n.label); } });
  if(idx.length<MIN_NOTES || new Set(y).size<2) return null;
  let pred;
  if(algo==='pitch'){
    // the ablation that matters: cluster on MIDI number alone, no timbre
    // information whatsoever. If this scores as well as a fingerprint,
    // the fingerprint is not what is doing the work.
    pred=kmeans(R.map(n=>[n.midi]),2,1,10).labels;
  }else{
    const X=features(R.map(prof),fname);
    if(algo==='kmeans')    pred=kmeans(X,2,1,10).labels;
    else if(algo==='ward') pred=agglomerative(X,2,'ward');
    else if(algo==='avg')  pred=agglomerative(X,2,'average');
    else if(algo==='gmm')  pred=gmm(X[0].length>2?pca(X,2):X,2,5,6).labels;
    else throw new Error('algo '+algo);
  }
  const p=idx.map(i=>pred[i]);
  return {acc:bestAccuracy(p,y), ari:ari(p,y), n:idx.length, pred:p, y};
}

/* The chance baseline for best-permutation accuracy is NOT 50%: with
   n notes and a best-of-2-permutations match, a random split scores
   well above half, and the smaller n is the higher it scores. So the
   null is measured rather than assumed — random relabellings that keep
   the predicted cluster sizes, which is the same null ARI uses. */
function chanceFor(pred,y,draws=200,seed=99){
  const rnd=clusterRng(seed);
  const acc=[], ar=[];
  for(let d=0;d<draws;d++){
    const p=pred.slice();
    for(let i=p.length-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [p[i],p[j]]=[p[j],p[i]]; }
    acc.push(bestAccuracy(p,y)); ar.push(ari(p,y));
  }
  return {acc:mean(acc), ari:mean(ar)};
}

function accuracyTable(mode,algo,segs){
  return FEATURE_SETS.map(f=>{
    const acc=[], ar=[];
    for(const s of segs){
      const r=scoreSegment(s,mode,f,algo);
      if(r){ acc.push(r.acc); ar.push(r.ari); }
    }
    return {feature:f, n:acc.length, acc:mean(acc), ari:mean(ar)};
  });
}

/* ---------------- choosing k blind ---------------- */
function chooseK(X,sel,tau){
  const n=X.length;
  if(n<2) return 1;
  if(sel==='silhouette'){
    let bk=1, bs=-Infinity;
    for(let k=2;k<=Math.min(KMAX,n-1);k++){
      const s=silhouette(X,kmeans(X,k,1,10).labels);
      if(s>bs){ bs=s; bk=k; }
    }
    return bs>=tau ? bk : 1;
  }
  if(sel==='gap')       return gapStatistic(X,KMAX,25,17).k;
  if(sel==='eigengap')  return eigengap(X,KMAX,'median').k;
  if(sel==='eigenlocal')return eigengap(X,KMAX,'local').k;
  if(sel==='bic')       return bicSelect(X,KMAX,5).k;
  throw new Error('selector '+sel);
}

/* ---------------- is blind count selection possible AT ALL? ----------------
   A table of hand-picked thresholds cannot answer that: every threshold
   trades false splits against found mixtures, and if the two rates move
   together the statistic carries no information. So score each selector
   by the raw statistic it thresholds, and take the AUC of that statistic
   between the solo segments and the two-instrument segments. 0.5 is
   chance — the statistic cannot tell a solo from a duet at any
   threshold. */
function evidenceFor2(X){
  const n=X.length;
  if(n<3) return {sil:0, gap:0, bic:0, eig:0, eigL:0};
  let sil=-Infinity;
  for(let k=2;k<=Math.min(KMAX,n-1);k++)
    sil=Math.max(sil,silhouette(X,kmeans(X,k,1,10).labels));
  const g=gapStatistic(X,KMAX,25,17);
  const b=bicSelect(X,KMAX,5);
  const e=eigengap(X,KMAX,'median'), eL=eigengap(X,KMAX,'local');
  return {
    sil,
    gap: (g.gaps[1]??0)-(g.gaps[0]??0),        // Gap(2) − Gap(1)
    bic: (b.curve[0]??0)-(b.curve[1]??0),      // BIC(1) − BIC(2)
    eig: -(e.values[1]??1),                    // small λ₁ ⇒ two components
    eigL:-(eL.values[1]??1)
  };
}

const SELECTORS=[
  {id:'silhouette τ=0.30', sel:'silhouette', tau:0.30},
  {id:'silhouette τ=0.40', sel:'silhouette', tau:0.40},
  {id:'silhouette τ=0.55', sel:'silhouette', tau:0.55},
  {id:'silhouette τ=0.70', sel:'silhouette', tau:0.70},
  {id:'gap statistic',     sel:'gap',        tau:0},
  {id:'eigengap (global σ)',sel:'eigengap',  tau:0},
  {id:'eigengap (local σ)',sel:'eigenlocal', tau:0},
  {id:'GMM BIC',           sel:'bic',        tau:0}
];

function countTable(mode,fname,segs){
  const solos=segs.filter(s=>s.kind==='solo' && rows(s,mode).length>=MIN_NOTES);
  const mixes=segs.filter(s=>s.kind==='mix' && s.dist!=='identical'
                              && rows(s,mode).length>=MIN_NOTES);
  const Xs=solos.map(s=>features(rows(s,mode).map(prof),fname));
  const Xm=mixes.map(s=>features(rows(s,mode).map(prof),fname));
  return SELECTORS.map(S=>{
    const kS=Xs.map(X=>chooseK(X,S.sel,S.tau));
    const kM=Xm.map(X=>chooseK(X,S.sel,S.tau));
    return {
      id:S.id,
      falseSplit: kS.length? kS.filter(k=>k>1).length/kS.length : null,
      soloMeanK: mean(kS),
      mixCorrect: kM.length? kM.filter(k=>k===2).length/kM.length : null,
      mixMeanK: mean(kM),
      nSolo:kS.length, nMix:kM.length
    };
  });
}

/* ---------------- breakdowns ---------------- */
function breakdown(mode,fname,algo,segs,key){
  const g=new Map();
  for(const s of segs){
    if(s.kind!=='mix' || s.dist==='identical') continue;
    const r=scoreSegment(s,mode,fname,algo);
    if(!r) continue;
    const k=String(s[key]);
    if(!g.has(k)) g.set(k,{acc:[],ari:[]});
    g.get(k).acc.push(r.acc); g.get(k).ari.push(r.ari);
  }
  return [...g.entries()].map(([k,v])=>({key:k,n:v.acc.length,acc:mean(v.acc),ari:mean(v.ari)}))
    .sort((a,b)=>a.key<b.key?-1:1);
}

/* ---------------- detection prerequisite ---------------- */
function detectionStats(segs){
  const recA=[],recB=[],ghost=[],ok=[];
  for(const s of segs){
    const uA=s.truthA.filter(m=>!s.truthB.includes(m));
    const uB=s.truthB.filter(m=>!s.truthA.includes(m));
    const det=new Set(s.notes.map(n=>n.midi));
    const fa=uA.filter(m=>det.has(m)).length, fb=uB.filter(m=>det.has(m)).length;
    recA.push(uA.length?fa/uA.length:1);
    if(uB.length) recB.push(fb/uB.length);
    ghost.push(s.notes.filter(n=>n.label==='G').length/Math.max(1,s.notes.length));
    ok.push(fa>0&&fb>0&&(fa+fb)>=MIN_NOTES?1:0);
  }
  return {n:segs.length, recA:mean(recA), recB:mean(recB),
          ghost:mean(ghost), scoreable:mean(ok)};
}

/* ============================================================
   run everything
   ============================================================ */
const segs=DB.segments;
const mixes=segs.filter(s=>s.kind==='mix'&&s.dist!=='identical');
const ALGOS=['kmeans','ward','avg','gmm'];

const acc={};
for(const mode of ['detected','oracle']){
  acc[mode]={};
  for(const a of ALGOS) acc[mode][a]=accuracyTable(mode,a,mixes);
}

/* the two baselines every number above has to beat */
const baselines={};
for(const mode of ['detected','oracle']){
  const chA=[], chR=[], piA=[], piR=[];
  for(const s of mixes){
    const r=scoreSegment(s,mode,'shape','ward');
    if(r){ const c=chanceFor(r.pred,r.y); chA.push(c.acc); chR.push(c.ari); }
    const p=scoreSegment(s,mode,'shape','pitch');
    if(p){ piA.push(p.acc); piR.push(p.ari); }
  }
  baselines[mode]={chance:{acc:mean(chA),ari:mean(chR),n:chA.length},
                   pitch:{acc:mean(piA),ari:mean(piR),n:piA.length}};
}
/* The winning fingerprint is chosen on the oracle, where the detector's
   errors are not part of the measurement, and on ARI *lift over the
   identical-timbre control* rather than on raw accuracy. Raw accuracy
   rewards a fingerprint for exploiting register, which the control
   segments show is worth most of it. */
const ident=segs.filter(s=>s.dist==='identical');
const identByFeature=FEATURE_SETS.map((f,fi)=>{
  const a=[],r=[];
  for(const s of ident){ const q=scoreSegment(s,'oracle',f,'ward'); if(q){ a.push(q.acc); r.push(q.ari); } }
  const real=acc.oracle.ward[fi];
  return {feature:f, n:a.length, acc:mean(a), ari:mean(r),
          realAcc:real.acc, realAri:real.ari,
          lift:real.acc-mean(a), liftAri:real.ari-mean(r)};
});
const WIN=identByFeature.slice().sort((a,b)=>b.liftAri-a.liftAri)[0].feature;

const counts={detected:countTable('detected',WIN,segs), oracle:countTable('oracle',WIN,segs)};
const countsShape={oracle:countTable('oracle','shape',segs)};

const brk={};
for(const key of ['dist','arrKind','db','pair'])
  brk[key]={detected:breakdown('detected',WIN,'ward',segs,key),
            oracle:breakdown('oracle',WIN,'ward',segs,key)};

/* Does the fingerprint add anything over MIDI pitch? Sliced by how the
   two pitch sets sit against each other, because a register-separated
   corpus would hand the pitch baseline a free win and that has to be
   visible rather than averaged away. The identical-timbre column is
   the same slice with no timbre difference to find. */
const vsPitch=['separate','interleave','shared'].map(kind=>{
  const M=mixes.filter(s=>s.arrKind===kind);
  const I=ident.filter(s=>s.arrKind===kind);
  const grab=(set,algo,f)=>{
    const a=[],r=[];
    for(const s of set){ const q=scoreSegment(s,'oracle',f,algo); if(q){ a.push(q.acc); r.push(q.ari); } }
    return {n:a.length, acc:mean(a), ari:mean(r)};
  };
  return {kind,
    fp:   grab(M,'ward',WIN),
    pitch:grab(M,'pitch',WIN),
    ident:grab(I,'ward',WIN),
    identPitch:grab(I,'pitch',WIN)};
});

const identByTimbre=[...new Set(ident.map(s=>s.timbreA))].map(t=>{
  const a=[];
  for(const s of ident.filter(x=>x.timbreA===t)){
    const q=scoreSegment(s,'oracle',WIN,'ward'); if(q) a.push(q.acc);
  }
  return {timbre:t,n:a.length,acc:mean(a)};
});

let nTot=0,nGhost=0,nShared=0;
for(const s of segs) for(const n of s.notes){
  nTot++; if(n.label==='G') nGhost++; if(n.label==='S') nShared++;
}

const instab=[], instab10=[];
for(const s of mixes){
  const X=features(rows(s,'oracle').map(prof),WIN);
  if(X.length>=3){
    instab.push(kmeansStability(X,2,20,1));     // one k-means++ init, as written naively
    instab10.push(kmeansStability(X,2,20,10));  // the 10-restart configuration used above
  }
}

/* AUC of each blind-count statistic, solos vs two-instrument mixtures */
const aucRows=[];
for(const fname of [WIN,'shape','logP']){
  const S=segs.filter(s=>s.kind==='solo');
  const M=segs.filter(s=>s.kind==='mix'&&s.dist!=='identical');
  const I=segs.filter(s=>s.dist==='identical');
  for(const mode of ['oracle','detected']){
    const ev=x=>rows(x,mode).length>=3
      ? evidenceFor2(features(rows(x,mode).map(prof),fname)) : null;
    const es=S.map(ev).filter(Boolean), em=M.map(ev).filter(Boolean), ei=I.map(ev).filter(Boolean);
    const row={feature:fname, mode, nSolo:es.length, nMix:em.length};
    for(const stat of ['sil','gap','bic','eig','eigL']){
      row[stat]=auc(em.map(e=>e[stat]),es.map(e=>e[stat]));
      // the same statistic asked to separate a real duet from two players
      // of the same instrument — the discrimination a feature would need
      row[stat+'Id']=auc(em.map(e=>e[stat]),ei.map(e=>e[stat]));
    }
    aucRows.push(row);
  }
}

const rt=[];
for(const s of segs){
  const R=rows(s,'detected'); if(R.length<2) continue;
  const t0=performance.now();
  const X=features(R.map(prof),WIN);
  agglomerative(X,2,'ward');
  chooseK(X,'silhouette',0.55);
  chooseK(X,'gap',0);
  chooseK(X,'eigengap',0);
  chooseK(X,'bic',0);
  rt.push(performance.now()-t0);
}
const rtNoGap=[];
for(const s of segs){
  const R=rows(s,'detected'); if(R.length<2) continue;
  const t0=performance.now();
  const X=features(R.map(prof),WIN);
  agglomerative(X,2,'ward');
  chooseK(X,'silhouette',0.55);
  rtNoGap.push(performance.now()-t0);
}

const OUT={
  file:inFile, dur:DB.dur, segments:segs.length, mixtures:mixes.length,
  winner:WIN, accuracy:acc, baselines, vsPitch, counts, countsShape, breakdown:brk,
  identical:{n:ident.length, byFeature:identByFeature, byTimbre:identByTimbre},
  auc:aucRows,
  detection:{
    all:detectionStats(mixes),
    byDist:['far','mid','close'].map(d=>({key:d,...detectionStats(mixes.filter(s=>s.dist===d))})),
    byPair:[...new Set(mixes.map(s=>s.pair))].map(p=>({key:p,...detectionStats(mixes.filter(s=>s.pair===p))})),
    byArr:['separate','interleave','shared'].map(k=>({key:k,...detectionStats(mixes.filter(s=>s.arrKind===k))})),
    byDb:[0,-6,-12].map(d=>({key:String(d),...detectionStats(mixes.filter(s=>s.db===d))}))
  },
  notes:{total:nTot, ghost:nGhost, shared:nShared},
  instability:{
    init1:{meanDistinct:mean(instab.map(x=>x.distinct)),
           meanModeShare:mean(instab.map(x=>x.modeShare)),
           unstableFrac:instab.length?instab.filter(x=>x.distinct>1).length/instab.length:null},
    init10:{meanDistinct:mean(instab10.map(x=>x.distinct)),
            meanModeShare:mean(instab10.map(x=>x.modeShare)),
            unstableFrac:instab10.length?instab10.filter(x=>x.distinct>1).length/instab10.length:null}},
  runtime:{clusterMean:mean(rt), clusterMax:Math.max(...rt),
           cheapMean:mean(rtNoGap), cheapMax:Math.max(...rtNoGap),
           profileMean:mean(segs.map(s=>s.msProfile)),
           profileMax:Math.max(...segs.map(s=>s.msProfile)),
           analyzeMean:mean(segs.map(s=>s.msAnalyze))}
};

writeFileSync(resolve(HERE,inFile.replace(/^profiles/,'report')),JSON.stringify(OUT,null,2)+'\n');
if(asJson){ console.log(JSON.stringify(OUT,null,2)); process.exit(0); }

/* ---------------- printing ---------------- */
const H=t=>{ console.log('\n'+t); console.log('='.repeat(t.length)); };

console.log(`voice clustering — ${inFile}  (${DB.dur} s segments, ${segs.length} segments, `+
            `${mixes.length} two-instrument mixtures)`);

H('0. The prerequisite: does the detector even find both instruments?');
console.log('slice                 n   recall A  recall B   ghost frac   both found');
const drow=(name,t)=>console.log(name.padEnd(20)+String(t.n).padStart(4)+'   '+
  pct(t.recA)+'%   '+pct(t.recB)+'%      '+pct(t.ghost)+'%      '+pct(t.scoreable)+'%');
drow('ALL MIXTURES',OUT.detection.all);
for(const r of OUT.detection.byPair) drow('  '+r.key,r);
for(const r of OUT.detection.byArr)  drow('  '+r.key,r);
for(const r of OUT.detection.byDb)   drow('  B at '+r.key+' dB',r);

H('1 + 3. Accuracy with k known = 2, and which fingerprint carries it');
for(const mode of ['oracle','detected']){
  console.log(`\n--- ${mode} notes ---`);
  console.log('fingerprint    n      kmeans          ward          average          GMM');
  console.log('                      acc   ARI      acc   ARI      acc   ARI      acc   ARI');
  for(let i=0;i<FEATURE_SETS.length;i++){
    let line=FEATURE_SETS[i].padEnd(13)+String(acc[mode].kmeans[i].n).padStart(4)+'  ';
    for(const a of ALGOS){ const r=acc[mode][a][i]; line+='  '+pct(r.acc)+' '+f3(r.ari); }
    console.log(line);
  }
}
console.log(`\nwinner (oracle, ward, mean accuracy): ${WIN}`);
console.log('\nthe two baselines every row above has to beat:');
console.log('                       oracle              detected');
for(const b of ['chance','pitch']){
  const label = b==='chance'
    ? 'random relabelling  ' : 'MIDI pitch alone    ';
  console.log('  '+label+
    `n=${String(baselines.oracle[b].n).padStart(3)} acc ${pct(baselines.oracle[b].acc)}% ARI ${f3(baselines.oracle[b].ari)}   `+
    `n=${String(baselines.detected[b].n).padStart(3)} acc ${pct(baselines.detected[b].acc)}% ARI ${f3(baselines.detected[b].ari)}`);
}
console.log('  (best-of-2-permutation accuracy is NOT 50% at chance — with few notes it is much higher,');
console.log('   which is why ARI, whose chance value is 0.000 by construction, is the number to read)');

console.log('\ndoes the fingerprint beat MIDI pitch? (oracle, ward, by how the pitch sets sit)');
console.log('                real pairs                        identical-timbre control');
console.log('voicing        n   fingerprint      pitch        n   fingerprint      pitch');
for(const r of vsPitch)
  console.log('  '+r.kind.padEnd(12)+String(r.fp.n).padStart(3)+
    '  '+pct(r.fp.acc)+'% '+f3(r.fp.ari)+'  '+pct(r.pitch.acc)+'% '+f3(r.pitch.ari)+
    '   '+String(r.ident.n).padStart(3)+'  '+pct(r.ident.acc)+'% '+f3(r.ident.ari)+
    '  '+pct(r.identPitch.acc)+'% '+f3(r.identPitch.ari));

H('2. Choosing the count blind — FALSE-SPLIT RATE FIRST');
const ctab=(title,t)=>{
  console.log('\n'+title);
  console.log('selector             false-split  mean k     2-inst correct  mean k');
  console.log(`                     (n=${String(t[0].nSolo).padStart(3)} solos)             (n=${String(t[0].nMix).padStart(3)} mixtures)`);
  for(const r of t)
    console.log(r.id.padEnd(21)+pct(r.falseSplit)+'%   '+f3(r.soloMeanK)+'      '+
                pct(r.mixCorrect)+'%       '+f3(r.mixMeanK));
};
ctab(`detected notes, fingerprint = ${WIN}`,counts.detected);
ctab(`oracle notes, fingerprint = ${WIN}`,counts.oracle);
ctab(`oracle notes, fingerprint = shape`,countsShape.oracle);

H('4. Where it breaks — ward, k known = 2');
const bt=(title,d)=>{
  console.log('\n'+title+'                oracle              detected');
  const keys=[...new Set([...d.oracle.map(r=>r.key),...d.detected.map(r=>r.key)])];
  for(const k of keys){
    const o=d.oracle.find(r=>r.key===k), e=d.detected.find(r=>r.key===k);
    console.log('  '+k.padEnd(22)+
      (o?`n=${String(o.n).padStart(3)} acc ${pct(o.acc)}% ARI ${f3(o.ari)}`:'  —              ')+'   '+
      (e?`n=${String(e.n).padStart(3)} acc ${pct(e.acc)}% ARI ${f3(e.ari)}`:'  —'));
  }
};
bt('by timbre distance',brk.dist);
bt('by voicing relation',brk.arrKind);
bt('by level of instrument B (dB)',brk.db);
bt('by instrument pair',brk.pair);

H('2b. Can ANY threshold work? AUC of each statistic, solo vs two-instrument');
console.log('   0.500 = the statistic cannot tell a solo from a duet at any threshold\n');
console.log('feature  mode        n     silhouette   gap    GMM BIC   eigen σ   eigen local');
for(const r of OUT.auc)
  console.log(r.feature.padEnd(9)+r.mode.padEnd(10)+
    String(r.nSolo+'/'+r.nMix).padStart(7)+'   '+
    f3(r.sil).padStart(8)+f3(r.gap).padStart(8)+f3(r.bic).padStart(9)+
    f3(r.eig).padStart(10)+f3(r.eigL).padStart(11));
console.log('\nsame statistics asked to separate a real duet from two players of the SAME instrument:');
console.log('feature  mode        silhouette   gap    GMM BIC   eigen σ   eigen local');
for(const r of OUT.auc)
  console.log(r.feature.padEnd(9)+r.mode.padEnd(12)+
    f3(r.silId).padStart(8)+f3(r.gapId).padStart(8)+f3(r.bicId).padStart(9)+
    f3(r.eigId).padStart(10)+f3(r.eigLId).padStart(11));

H('THE CONTROL: two players of the same instrument');
console.log(`n=${OUT.identical.n} segments in which there is no timbre difference to find.`);
console.log('A real pair\'s accuracy only counts insofar as it exceeds this column.\n');
console.log('fingerprint    identical pair    real pairs      lift');
console.log('               acc     ARI       acc     ARI     acc     ARI');
for(const r of OUT.identical.byFeature)
  console.log(r.feature.padEnd(13)+pct(r.acc)+'% '+f3(r.ari)+'    '+
    pct(r.realAcc)+'% '+f3(acc.oracle.ward[FEATURE_SETS.indexOf(r.feature)].ari)+'   '+
    (r.lift>=0?'+':'')+(100*r.lift).toFixed(1)+'pp  '+(r.liftAri>=0?'+':'')+r.liftAri.toFixed(3));
console.log('\nby timbre (fingerprint '+WIN+'):');
for(const r of OUT.identical.byTimbre)
  console.log('  '+r.timbre.padEnd(12)+'n='+String(r.n).padStart(3)+'  acc '+pct(r.acc)+'%');

H('other hygiene');
console.log(`detected notes over the whole corpus: ${OUT.notes.total}, of which `+
  `${OUT.notes.ghost} ghosts (${(100*OUT.notes.ghost/OUT.notes.total).toFixed(1)}%) `+
  `and ${OUT.notes.shared} shared pitches (${(100*OUT.notes.shared/OUT.notes.total).toFixed(1)}%)`);
console.log(`k-means instability over 20 seeds at k=2 (oracle, ${WIN}):`);
console.log(`  1 k-means++ init   ${(100*OUT.instability.init1.unstableFrac).toFixed(1)}% of segments give more than one partition, `+
  `mean modal share ${f3(OUT.instability.init1.meanModeShare)}`);
console.log(` 10 restarts        ${(100*OUT.instability.init10.unstableFrac).toFixed(1)}% of segments give more than one partition, `+
  `mean modal share ${f3(OUT.instability.init10.meanModeShare)}`);

H('5. Runtime of the added step');
console.log(`  partial-profile extraction       mean ${OUT.runtime.profileMean.toFixed(2)} ms, max ${OUT.runtime.profileMax.toFixed(2)} ms`);
console.log(`  features + ward + silhouette     mean ${OUT.runtime.cheapMean.toFixed(2)} ms, max ${OUT.runtime.cheapMax.toFixed(2)} ms`);
console.log(`  features + ward + all 4 selectors mean ${OUT.runtime.clusterMean.toFixed(2)} ms, max ${OUT.runtime.clusterMax.toFixed(2)} ms`);
console.log(`  (analyzeSegment itself           mean ${OUT.runtime.analyzeMean.toFixed(0)} ms, budget 900 ms)`);
