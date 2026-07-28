/* ---------------- FFT (iterative radix-2) + STFT / ISTFT ---------------- */

class FFT{
  constructor(n){
    this.n=n; const lv=Math.log2(n)|0;
    this.rev=new Uint32Array(n);
    for(let i=0;i<n;i++){ let r=0,x=i; for(let j=0;j<lv;j++){ r=(r<<1)|(x&1); x>>=1; } this.rev[i]=r; }
    this.cs=new Float64Array(n/2); this.sn=new Float64Array(n/2);
    for(let i=0;i<n/2;i++){ this.cs[i]=Math.cos(-2*Math.PI*i/n); this.sn[i]=Math.sin(-2*Math.PI*i/n); }
  }
  run(re,im){
    const n=this.n, rev=this.rev;
    for(let i=0;i<n;i++){ const j=rev[i]; if(j>i){ let t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; } }
    for(let len=2;len<=n;len<<=1){
      const half=len>>1, step=n/len;
      for(let i=0;i<n;i+=len){
        for(let k=0,ti=0;k<half;k++,ti+=step){
          const c=this.cs[ti], s=this.sn[ti];
          const a=i+k, b=a+half;
          const xr=re[b]*c-im[b]*s, xi=re[b]*s+im[b]*c;
          re[b]=re[a]-xr; im[b]=im[a]-xi;
          re[a]+=xr;      im[a]+=xi;
        }
      }
    }
  }
  inv(re,im){
    const n=this.n;
    for(let i=0;i<n;i++) im[i]=-im[i];
    this.run(re,im);
    for(let i=0;i<n;i++){ re[i]/=n; im[i]=-im[i]/n; }
  }
}
const _fft=new Map();
const getFFT = n => { if(!_fft.has(n)) _fft.set(n,new FFT(n)); return _fft.get(n); };

function hann(n){ const w=new Float32Array(n); for(let i=0;i<n;i++) w[i]=0.5-0.5*Math.cos(2*Math.PI*i/n); return w; }

/* ---------------- STFT / ISTFT ---------------- */
function stft(sig,n,hop){
  const f=getFFT(n), w=hann(n);
  const frames=Math.max(1,Math.floor((sig.length-n)/hop)+1);
  const K=n/2+1;
  const re=new Float32Array(frames*K), im=new Float32Array(frames*K);
  const br=new Float64Array(n), bi=new Float64Array(n);
  for(let t=0;t<frames;t++){
    const off=t*hop;
    for(let i=0;i<n;i++){ const s=off+i; br[i]=(s<sig.length?sig[s]:0)*w[i]; bi[i]=0; }
    f.run(br,bi);
    const o=t*K;
    for(let k=0;k<K;k++){ re[o+k]=br[k]; im[o+k]=bi[k]; }
  }
  return {re,im,frames,K,n,hop};
}
function istft(S,len){
  const {re,im,frames,K,n,hop}=S;
  const f=getFFT(n), w=hann(n);
  const out=new Float32Array(len), ws=new Float32Array(len);
  const br=new Float64Array(n), bi=new Float64Array(n);
  for(let t=0;t<frames;t++){
    const o=t*K;
    for(let k=0;k<K;k++){ br[k]=re[o+k]; bi[k]=im[o+k]; }
    for(let k=K;k<n;k++){ br[k]=re[o+(n-k)]; bi[k]=-im[o+(n-k)]; }   // Hermitian mirror
    f.inv(br,bi);
    const off=t*hop;
    for(let i=0;i<n;i++){ const s=off+i; if(s<len){ out[s]+=br[i]*w[i]; ws[s]+=w[i]*w[i]; } }
  }
  for(let i=0;i<len;i++) out[i]= ws[i]>1e-8 ? out[i]/ws[i] : 0;
  return out;
}
function magOf(S){
  const {re,im,frames,K}=S, m=new Float32Array(frames*K);
  for(let i=0;i<frames*K;i++) m[i]=Math.hypot(re[i],im[i]);
  return m;
}

export {stft,istft,magOf};
