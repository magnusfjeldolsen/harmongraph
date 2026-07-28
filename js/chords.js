/* ---------------- chord templates ---------------- */
import {NN} from './pitch.js';

const TPL=[
 ['',      {0:1,4:.9,7:.8}],
 ['m',     {0:1,3:.9,7:.8}],
 ['5',     {0:1,7:.95}],
 ['sus4',  {0:1,5:.9,7:.8}],
 ['sus2',  {0:1,2:.9,7:.8}],
 ['dim',   {0:1,3:.9,6:.9}],
 ['aug',   {0:1,4:.9,8:.9}],
 ['6',     {0:1,4:.85,7:.65,9:.8}],
 ['m6',    {0:1,3:.85,7:.65,9:.8}],
 ['7',     {0:1,4:.85,7:.55,10:.85}],
 ['maj7',  {0:1,4:.85,7:.55,11:.85}],
 ['m7',    {0:1,3:.85,7:.55,10:.85}],
 ['mMaj7', {0:1,3:.85,7:.55,11:.85}],
 ['dim7',  {0:1,3:.9,6:.9,9:.9}],
 ['m7♭5',  {0:1,3:.85,6:.85,10:.85}],
 ['7sus4', {0:1,5:.85,7:.55,10:.85}],
 ['add9',  {0:1,2:.7,4:.85,7:.7}],
 ['m add9',{0:1,2:.7,3:.85,7:.7}],
 ['9',     {0:1,2:.7,4:.8,7:.45,10:.8}],
 ['maj9',  {0:1,2:.7,4:.8,7:.45,11:.8}],
 ['m9',    {0:1,2:.7,3:.8,7:.45,10:.8}],
 ['6/9',   {0:1,2:.65,4:.8,7:.55,9:.8}],
 ['7♭9',   {0:1,1:.7,4:.8,7:.45,10:.8}],
 ['7♯9',   {0:1,3:.7,4:.8,7:.45,10:.8}],
 ['7♯11',  {0:1,4:.8,6:.7,7:.45,10:.8}],
 ['13',    {0:1,4:.8,7:.45,9:.7,10:.8}],
];
function idChord(pcv,bassPc){
  let tot=0; for(let i=0;i<12;i++) tot+=pcv[i]*pcv[i];
  tot=Math.sqrt(tot)||1;
  const v=pcv.map(x=>x/tot);
  const out=[];
  for(let root=0;root<12;root++){
    for(const [name,iv] of TPL){
      const t=new Array(12).fill(0);
      for(const k in iv) t[(root+ +k)%12]=iv[k];
      let tn=0; for(let i=0;i<12;i++) tn+=t[i]*t[i];
      tn=Math.sqrt(tn)||1;
      let dot=0, miss=0;
      for(let i=0;i<12;i++){ const tt=t[i]/tn; dot+=v[i]*tt; if(t[i]===0) miss+=v[i]*v[i]; }
      let sc=dot-0.55*Math.sqrt(miss);
      if(root===bassPc) sc+=0.035;                       // root position bonus
      sc-=0.012*Object.keys(iv).length;                  // prefer simpler spelling
      out.push({root,name,sc});
    }
  }
  out.sort((a,b)=>b.sc-a.sc);
  return out.slice(0,4);
}
function chordLabel(c,bassPc){
  const r=NN[c.root];
  const slash=(bassPc!=null&&bassPc!==c.root)?('/'+NN[bassPc]):'';
  return {root:r,q:c.name,slash};
}

export {idChord,chordLabel};
