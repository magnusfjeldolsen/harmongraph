/* ============================================================
   Clustering and cluster-count selection, from scratch.
   Zero dependencies, seeded, deterministic.

     kmeans / agglomerative / gmm      the three clusterers
     silhouette / gap / eigengap / bic the four ways to pick k
     ari / bestAccuracy                the two ways to score a
                                       labelling against truth

   Everything here operates on n × d arrays of plain numbers with
   n in the single digits, so nothing is optimised: the O(n³)
   agglomerative and the O(n²) silhouette are the readable
   implementations on purpose.
   ============================================================ */

/* ---------------- deterministic PRNG (mulberry32) ---------------- */
export function rng(seed){
  let a=seed>>>0;
  return function(){
    a=(a+0x6D2B79F5)>>>0;
    let t=a;
    t=Math.imul(t^(t>>>15),t|1);
    t^=t+Math.imul(t^(t>>>7),t|61);
    return ((t^(t>>>14))>>>0)/4294967296;
  };
}

const sqd=(a,b)=>{ let s=0; for(let i=0;i<a.length;i++){ const d=a[i]-b[i]; s+=d*d; } return s; };
export const dist=(a,b)=>Math.sqrt(sqd(a,b));

export function pairwise(X){
  const n=X.length, D=[];
  for(let i=0;i<n;i++){ D.push(new Float64Array(n)); }
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){ const d=dist(X[i],X[j]); D[i][j]=d; D[j][i]=d; }
  return D;
}

/* ---------------- k-means (k-means++ init, Lloyd) ---------------- */
export function kmeans(X,k,seed=1,restarts=10){
  const n=X.length, d=X[0].length;
  if(k>=n) return {labels:X.map((_,i)=>Math.min(i,k-1)), inertia:0, centres:X.map(r=>r.slice())};
  let best=null;
  for(let r=0;r<restarts;r++){
    const rand=rng(seed*1000003+r*7919);
    // k-means++ seeding
    const C=[X[Math.floor(rand()*n)%n].slice()];
    while(C.length<k){
      const w=new Float64Array(n); let tot=0;
      for(let i=0;i<n;i++){
        let m=Infinity; for(const c of C) m=Math.min(m,sqd(X[i],c));
        w[i]=m; tot+=m;
      }
      let t=rand()*tot, pick=n-1;
      for(let i=0;i<n;i++){ t-=w[i]; if(t<=0){ pick=i; break; } }
      C.push(X[pick].slice());
    }
    const lab=new Int32Array(n).fill(-1);
    for(let it=0;it<100;it++){
      let moved=false;
      for(let i=0;i<n;i++){
        let bi=0, bd=Infinity;
        for(let c=0;c<k;c++){ const v=sqd(X[i],C[c]); if(v<bd){ bd=v; bi=c; } }
        if(lab[i]!==bi){ lab[i]=bi; moved=true; }
      }
      const cnt=new Int32Array(k), sum=[];
      for(let c=0;c<k;c++) sum.push(new Float64Array(d));
      for(let i=0;i<n;i++){ cnt[lab[i]]++; for(let j=0;j<d;j++) sum[lab[i]][j]+=X[i][j]; }
      for(let c=0;c<k;c++){
        if(!cnt[c]) continue;                       // keep an empty centre put
        for(let j=0;j<d;j++) C[c][j]=sum[c][j]/cnt[c];
      }
      if(!moved) break;
    }
    let inertia=0; for(let i=0;i<n;i++) inertia+=sqd(X[i],C[lab[i]]);
    if(!best || inertia<best.inertia-1e-12)
      best={labels:Array.from(lab), inertia, centres:C.map(c=>Array.from(c))};
  }
  return best;
}

/* how often does k-means land on a different partition from a
   different seed? measured, not hidden */
export function kmeansStability(X,k,seeds=20,restarts=1){
  const parts=new Map();
  for(let s=0;s<seeds;s++){
    const L=kmeans(X,k,s+1,restarts).labels;
    const key=canonical(L);
    parts.set(key,(parts.get(key)||0)+1);
  }
  let top=0; for(const v of parts.values()) top=Math.max(top,v);
  return {distinct:parts.size, modeShare:top/seeds};
}

/* ---------------- ROC AUC (Mann–Whitney) ----------------
   Threshold-free: it answers "does this statistic separate the two
   populations at all", which is the question a table of hand-picked
   thresholds cannot answer. 0.5 is chance. */
export function auc(pos,neg){
  if(!pos.length||!neg.length) return null;
  const all=[...pos.map(v=>[v,1]),...neg.map(v=>[v,0])].sort((a,b)=>a[0]-b[0]);
  // average ranks for ties
  const rank=new Array(all.length);
  let i=0;
  while(i<all.length){
    let j=i; while(j+1<all.length && all[j+1][0]===all[i][0]) j++;
    const r=(i+j)/2+1;
    for(let q=i;q<=j;q++) rank[q]=r;
    i=j+1;
  }
  let sp=0; for(let q=0;q<all.length;q++) if(all[q][1]===1) sp+=rank[q];
  return (sp-pos.length*(pos.length+1)/2)/(pos.length*neg.length);
}
function canonical(L){
  const map=new Map(); let next=0;
  return L.map(l=>{ if(!map.has(l)) map.set(l,next++); return map.get(l); }).join('');
}

/* ---------------- agglomerative ---------------- */
export function agglomerative(X,k,linkage='ward'){
  const n=X.length;
  if(k>=n) return X.map((_,i)=>i);
  const D=pairwise(X);
  let clusters=X.map((_,i)=>[i]);
  const cdist=(A,B)=>{
    if(linkage==='average'){
      let s=0; for(const a of A) for(const b of B) s+=D[a][b];
      return s/(A.length*B.length);
    }
    if(linkage==='complete'){
      let m=0; for(const a of A) for(const b of B) m=Math.max(m,D[a][b]);
      return m;
    }
    // ward: increase in total within-cluster sum of squares from merging
    const cen=S=>{ const c=new Float64Array(X[0].length);
      for(const i of S) for(let j=0;j<c.length;j++) c[j]+=X[i][j];
      for(let j=0;j<c.length;j++) c[j]/=S.length; return c; };
    const ca=cen(A), cb=cen(B);
    return (A.length*B.length)/(A.length+B.length)*sqd(ca,cb);
  };
  while(clusters.length>k){
    let bi=0,bj=1,bd=Infinity;
    for(let i=0;i<clusters.length;i++) for(let j=i+1;j<clusters.length;j++){
      const v=cdist(clusters[i],clusters[j]);
      if(v<bd){ bd=v; bi=i; bj=j; }
    }
    clusters[bi]=clusters[bi].concat(clusters[bj]);
    clusters.splice(bj,1);
  }
  const lab=new Array(n).fill(0);
  clusters.forEach((c,ci)=>c.forEach(i=>{ lab[i]=ci; }));
  return lab;
}

/* ---------------- symmetric eigen (cyclic Jacobi) ---------------- */
export function jacobi(Ain,iters=100){
  const n=Ain.length;
  const A=Ain.map(r=>Float64Array.from(r));
  let V=[]; for(let i=0;i<n;i++){ const r=new Float64Array(n); r[i]=1; V.push(r); }
  for(let sweep=0;sweep<iters;sweep++){
    let off=0;
    for(let p=0;p<n;p++) for(let q=p+1;q<n;q++) off+=A[p][q]*A[p][q];
    if(off<1e-24) break;
    for(let p=0;p<n;p++) for(let q=p+1;q<n;q++){
      if(Math.abs(A[p][q])<1e-18) continue;
      const theta=(A[q][q]-A[p][p])/(2*A[p][q]);
      const t=Math.sign(theta||1)/(Math.abs(theta)+Math.sqrt(theta*theta+1));
      const c=1/Math.sqrt(t*t+1), s=t*c;
      for(let i=0;i<n;i++){
        const aip=A[i][p], aiq=A[i][q];
        A[i][p]=c*aip-s*aiq; A[i][q]=s*aip+c*aiq;
      }
      for(let i=0;i<n;i++){
        const api=A[p][i], aqi=A[q][i];
        A[p][i]=c*api-s*aqi; A[q][i]=s*api+c*aqi;
      }
      for(let i=0;i<n;i++){
        const vip=V[i][p], viq=V[i][q];
        V[i][p]=c*vip-s*viq; V[i][q]=s*vip+c*viq;
      }
    }
  }
  const val=[]; for(let i=0;i<n;i++) val.push(A[i][i]);
  const ord=val.map((v,i)=>i).sort((a,b)=>val[a]-val[b]);
  return {values:ord.map(i=>val[i]), vectors:ord.map(i=>V.map(r=>r[i]))};
}

/* ---------------- PCA (for the GMM, which cannot see 12 dims from 6 points) */
export function pca(X,dOut){
  const n=X.length, d=X[0].length;
  const mu=new Array(d).fill(0);
  for(const r of X) for(let j=0;j<d;j++) mu[j]+=r[j]/n;
  const C=[]; for(let i=0;i<d;i++) C.push(new Float64Array(d));
  for(const r of X) for(let i=0;i<d;i++) for(let j=0;j<d;j++)
    C[i][j]+=(r[i]-mu[i])*(r[j]-mu[j])/Math.max(1,n-1);
  const {values,vectors}=jacobi(C.map(r=>Array.from(r)));
  const k=Math.min(dOut,d);
  const top=[]; for(let i=0;i<k;i++) top.push(vectors[d-1-i]);   // largest first
  return X.map(r=>top.map(v=>{ let s=0; for(let j=0;j<d;j++) s+=(r[j]-mu[j])*v[j]; return s; }));
}

/* ---------------- diagonal-covariance GMM by EM ---------------- */
export function gmm(X,k,seed=1,restarts=6){
  const n=X.length, d=X[0].length;
  // global variance sets the regularisation floor: with 3–12 points a
  // component will otherwise collapse onto one point and report
  // infinite likelihood, which makes BIC choose the largest k always.
  const gv=new Array(d).fill(0), mu0=new Array(d).fill(0);
  for(const r of X) for(let j=0;j<d;j++) mu0[j]+=r[j]/n;
  for(const r of X) for(let j=0;j<d;j++) gv[j]+=(r[j]-mu0[j])**2/Math.max(1,n-1);
  const floor=gv.map(v=>Math.max(v*0.05,1e-6));

  let best=null;
  for(let rs=0;rs<restarts;rs++){
    const init=kmeans(X,Math.min(k,n),seed*31+rs,3);
    let w=new Array(k).fill(1/k);
    let mu=[], va=[];
    for(let c=0;c<k;c++){
      mu.push(init.centres[Math.min(c,init.centres.length-1)].slice());
      va.push(gv.map((v,j)=>Math.max(v,floor[j])));
    }
    let ll=-Infinity;
    const resp=[]; for(let i=0;i<n;i++) resp.push(new Float64Array(k));
    for(let it=0;it<200;it++){
      // E
      let newLL=0;
      for(let i=0;i<n;i++){
        const lp=new Float64Array(k);
        for(let c=0;c<k;c++){
          let s=Math.log(Math.max(w[c],1e-300));
          for(let j=0;j<d;j++){
            s+=-0.5*(Math.log(2*Math.PI*va[c][j])+(X[i][j]-mu[c][j])**2/va[c][j]);
          }
          lp[c]=s;
        }
        let m=-Infinity; for(let c=0;c<k;c++) m=Math.max(m,lp[c]);
        let se=0; for(let c=0;c<k;c++) se+=Math.exp(lp[c]-m);
        const lse=m+Math.log(se);
        newLL+=lse;
        for(let c=0;c<k;c++) resp[i][c]=Math.exp(lp[c]-lse);
      }
      // M
      for(let c=0;c<k;c++){
        let nk=0; for(let i=0;i<n;i++) nk+=resp[i][c];
        w[c]=Math.max(nk/n,1e-8);
        if(nk<1e-8) continue;
        for(let j=0;j<d;j++){
          let s=0; for(let i=0;i<n;i++) s+=resp[i][c]*X[i][j];
          mu[c][j]=s/nk;
        }
        for(let j=0;j<d;j++){
          let s=0; for(let i=0;i<n;i++) s+=resp[i][c]*(X[i][j]-mu[c][j])**2;
          va[c][j]=Math.max(s/nk,floor[j]);
        }
      }
      if(Math.abs(newLL-ll)<1e-9){ ll=newLL; break; }
      ll=newLL;
    }
    const labels=[]; for(let i=0;i<n;i++){
      let bi=0,bv=-Infinity;
      for(let c=0;c<k;c++) if(resp[i][c]>bv){ bv=resp[i][c]; bi=c; }
      labels.push(bi);
    }
    if(!best || ll>best.ll) best={ll,labels,k,d,n};
  }
  const p=best.k*(2*best.d+1)-1;                  // means + diag vars + weights
  best.bic=-2*best.ll+p*Math.log(best.n);
  best.aic=-2*best.ll+2*p;
  return best;
}

/* ---------------- k selection ---------------- */

/* silhouette; undefined at k=1, so a caller must threshold it */
export function silhouette(X,labels){
  const n=X.length, D=pairwise(X);
  const groups=new Map();
  labels.forEach((l,i)=>{ if(!groups.has(l)) groups.set(l,[]); groups.get(l).push(i); });
  if(groups.size<2) return 0;
  let s=0;
  for(let i=0;i<n;i++){
    const own=groups.get(labels[i]);
    let a=0;
    if(own.length>1){ for(const j of own) if(j!==i) a+=D[i][j]; a/=own.length-1; }
    let b=Infinity;
    for(const [l,g] of groups){
      if(l===labels[i]) continue;
      let m=0; for(const j of g) m+=D[i][j]; m/=g.length;
      b=Math.min(b,m);
    }
    if(own.length===1) s+=0;                       // singleton: no evidence
    else s+=(b-a)/Math.max(a,b);
  }
  return s/n;
}

/* Tibshirani gap statistic. Reference distribution is uniform in the
   bounding box of the data, B draws, seeded. Selects k=1 natively:
   that is the whole reason it is in the list. */
export function gapStatistic(X,kmax=4,B=25,seed=17){
  const n=X.length, d=X[0].length;
  const lo=new Array(d).fill(Infinity), hi=new Array(d).fill(-Infinity);
  for(const r of X) for(let j=0;j<d;j++){ lo[j]=Math.min(lo[j],r[j]); hi[j]=Math.max(hi[j],r[j]); }
  const W=(Y,lab)=>{
    const g=new Map();
    lab.forEach((l,i)=>{ if(!g.has(l)) g.set(l,[]); g.get(l).push(i); });
    let w=0;
    for(const idx of g.values()){
      let s=0;
      for(const a of idx) for(const b of idx) s+=sqd(Y[a],Y[b]);
      w+=s/(2*idx.length);
    }
    return w;
  };
  const rand=rng(seed);
  const kx=Math.min(kmax,n-1);
  const gaps=[], sk=[];
  const refs=[];
  for(let b=0;b<B;b++){
    const Y=[]; for(let i=0;i<n;i++){ const r=[]; for(let j=0;j<d;j++) r.push(lo[j]+rand()*(hi[j]-lo[j])); Y.push(r); }
    refs.push(Y);
  }
  for(let k=1;k<=kx;k++){
    const wk=Math.log(Math.max(W(X,kmeans(X,k,k*13+1,8).labels),1e-12));
    const ls=[];
    for(let b=0;b<B;b++) ls.push(Math.log(Math.max(W(refs[b],kmeans(refs[b],k,k*13+1,8).labels),1e-12)));
    const m=ls.reduce((a,v)=>a+v,0)/B;
    const sd=Math.sqrt(ls.reduce((a,v)=>a+(v-m)*(v-m),0)/B);
    gaps.push(m-wk); sk.push(sd*Math.sqrt(1+1/B));
  }
  // smallest k with Gap(k) >= Gap(k+1) - s_{k+1}
  for(let k=1;k<kx;k++) if(gaps[k-1]>=gaps[k]-sk[k]) return {k, gaps, sk};
  return {k:kx, gaps, sk};
}

/* Spectral eigengap on a Gaussian affinity, self-tuned by the median
   pairwise distance. Selects k=1 natively. */
/* `scaling` matters enough to be an option rather than a constant: with
   one global σ on a fully connected graph the Laplacian's first gap is
   almost always the largest, so the selector degenerates to "k=1
   always" and reporting that as a result would be a strawman of my own
   σ choice. The Zelnik-Manor & Perona local scaling is the standard
   answer, so both are measured. */
export function eigengap(X,kmax=4,scaling='median'){
  const n=X.length;
  const D=pairwise(X);
  const flat=[]; for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) flat.push(D[i][j]);
  flat.sort((a,b)=>a-b);
  const sigma=Math.max(flat[Math.floor(flat.length/2)]||1,1e-9);
  // local scale: distance to the min(3, n-1)-th nearest neighbour
  const loc=new Float64Array(n);
  for(let i=0;i<n;i++){
    const d=[]; for(let j=0;j<n;j++) if(j!==i) d.push(D[i][j]);
    d.sort((a,b)=>a-b);
    loc[i]=Math.max(d[Math.min(2,d.length-1)]||sigma,1e-9);
  }
  const W=[]; for(let i=0;i<n;i++) W.push(new Float64Array(n));
  for(let i=0;i<n;i++) for(let j=0;j<n;j++)
    W[i][j]= i===j ? 0 : (scaling==='local'
      ? Math.exp(-D[i][j]*D[i][j]/(loc[i]*loc[j]))
      : Math.exp(-D[i][j]*D[i][j]/(2*sigma*sigma)));
  const deg=new Float64Array(n);
  for(let i=0;i<n;i++){ let s=0; for(let j=0;j<n;j++) s+=W[i][j]; deg[i]=Math.max(s,1e-12); }
  const L=[]; for(let i=0;i<n;i++) L.push(new Float64Array(n));
  for(let i=0;i<n;i++) for(let j=0;j<n;j++)
    L[i][j]=(i===j?1:0)-W[i][j]/Math.sqrt(deg[i]*deg[j]);
  const {values}=jacobi(L.map(r=>Array.from(r)));
  const kx=Math.min(kmax,n-1);
  let bk=1, bg=-Infinity;
  for(let k=1;k<=kx;k++){
    const g=values[k]-values[k-1];
    if(g>bg+1e-12){ bg=g; bk=k; }
  }
  return {k:bk, values:values.slice(0,kx+1), gap:bg};
}

/* BIC over a GMM, on the top-2 principal components. With n as small
   as 3 the full-dimensional likelihood is degenerate, so this is not
   optional. */
export function bicSelect(X,kmax=4,seed=5){
  const n=X.length;
  const Z = X[0].length>2 ? pca(X,2) : X;
  const kx=Math.min(kmax,n-1);
  let bk=1, bv=Infinity; const curve=[];
  for(let k=1;k<=kx;k++){
    const g=gmm(Z,k,seed,4);
    curve.push(+g.bic.toFixed(2));
    if(g.bic<bv-1e-9){ bv=g.bic; bk=k; }
  }
  return {k:bk, curve};
}

/* ---------------- scoring ---------------- */
const C2=v=>v*(v-1)/2;

export function ari(a,b){
  const n=a.length;
  if(n<2) return 1;
  const A=[...new Set(a)], B=[...new Set(b)];
  const M=A.map(()=>B.map(()=>0));
  for(let i=0;i<n;i++) M[A.indexOf(a[i])][B.indexOf(b[i])]++;
  let sij=0, si=0, sj=0;
  const ra=A.map(()=>0), cb=B.map(()=>0);
  for(let i=0;i<A.length;i++) for(let j=0;j<B.length;j++){
    sij+=C2(M[i][j]); ra[i]+=M[i][j]; cb[j]+=M[i][j];
  }
  for(const v of ra) si+=C2(v);
  for(const v of cb) sj+=C2(v);
  const exp=si*sj/C2(n), max=(si+sj)/2;
  return Math.abs(max-exp)<1e-12 ? 1 : (sij-exp)/(max-exp);
}

/* best per-item accuracy over all assignments of predicted clusters to
   true labels (Hungarian is overkill at k<=4; brute force the perms) */
export function bestAccuracy(pred,truth){
  const P=[...new Set(pred)], T=[...new Set(truth)];
  const perms=permutations(T.length>=P.length?T:T.concat(new Array(P.length-T.length).fill(null)));
  let best=0;
  for(const perm of perms){
    let hit=0;
    for(let i=0;i<pred.length;i++){
      const mapped=perm[P.indexOf(pred[i])];
      if(mapped===truth[i]) hit++;
    }
    best=Math.max(best,hit/pred.length);
  }
  return best;
}
function permutations(arr){
  if(arr.length<=1) return [arr];
  const out=[];
  for(let i=0;i<arr.length;i++){
    const rest=arr.slice(0,i).concat(arr.slice(i+1));
    for(const p of permutations(rest)) out.push([arr[i],...p]);
  }
  return out;
}
