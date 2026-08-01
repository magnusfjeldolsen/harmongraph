/* ============================================================
   Segment length sweep. Reads the report-*.json files that
   report.mjs writes and pulls the handful of numbers that
   actually move, so the degradation is one table rather than four
   full reports.

     node test/exp/report.mjs --in profiles-2.5.json     (etc.)
     node test/exp/duration.mjs
   ============================================================ */
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE=dirname(fileURLToPath(import.meta.url));
// note: `${1.0}` is "1" in JS, so the 1 s files are report-1.json
const DURS=[2.5,1.5,1,0.5];
const R=[];
for(const d of DURS){
  const p=resolve(HERE,`report-${d}.json`);
  if(existsSync(p)) R.push(JSON.parse(readFileSync(p,'utf8')));
  else console.error(`missing report-${d}.json — run report.mjs --in profiles-${d}.json`);
}
if(!R.length) process.exit(1);

const pct=v=>v===null||v===undefined||Number.isNaN(v)?'  — ':(100*v).toFixed(1).padStart(5);
const f3=v=>v===null||v===undefined||Number.isNaN(v)?'  —  ':v.toFixed(3);
const ward=r=>r.accuracy.oracle.ward.find(x=>x.feature===r.winner);
const wardD=r=>r.accuracy.detected.ward.find(x=>x.feature===r.winner);
const idf=r=>r.identical.byFeature.find(x=>x.feature===r.winner);
const sil55=r=>r.counts.detected.find(x=>x.id==='silhouette τ=0.55');
const aucRow=r=>r.auc.find(x=>x.feature===r.winner&&x.mode==='detected');

console.log('\nsegment length sweep — every column is the winning fingerprint of that run\n');
console.log('dur   winner    detection      oracle k=2        detected k=2      lift over');
console.log('      feature   recall B  both  acc     ARI      acc     ARI       identical (ARI)');
for(const r of R)
  console.log(String(r.dur).padEnd(6)+String(r.winner).padEnd(10)+
    pct(r.detection.all.recB)+'%  '+pct(r.detection.all.scoreable)+'%  '+
    pct(ward(r).acc)+'% '+f3(ward(r).ari)+'   '+
    pct(wardD(r).acc)+'% '+f3(wardD(r).ari)+'    '+
    (idf(r).liftAri>=0?'+':'')+idf(r).liftAri.toFixed(3));

console.log('\nblind count selection as the segment shortens (detected notes)\n');
console.log('dur   false-split  2-inst found   AUC solo-vs-duet');
console.log('      silh τ=0.55  silh τ=0.55    silh    eigen local');
for(const r of R)
  console.log(String(r.dur).padEnd(6)+pct(sil55(r).falseSplit)+'%       '+
    pct(sil55(r).mixCorrect)+'%        '+
    f3(aucRow(r).sil)+'   '+f3(aucRow(r).eigL));

console.log('\nruntime of the added step (ms)\n');
console.log('dur   profile extraction   ward+silhouette   all 4 selectors   analyzeSegment');
for(const r of R)
  console.log(String(r.dur).padEnd(6)+
    r.runtime.profileMean.toFixed(2).padStart(8)+' mean       '+
    r.runtime.cheapMean.toFixed(2).padStart(6)+'          '+
    r.runtime.clusterMean.toFixed(2).padStart(6)+'           '+
    r.runtime.analyzeMean.toFixed(0).padStart(5));
console.log('');
