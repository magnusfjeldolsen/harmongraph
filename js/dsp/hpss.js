/* ---------------- median filter helpers ---------------- */
function med(buf,len){
  for(let i=1;i<len;i++){ const v=buf[i]; let j=i-1; while(j>=0&&buf[j]>v){buf[j+1]=buf[j];j--;} buf[j+1]=v; }
  return buf[len>>1];
}
/* HPSS via median filtering (Fitzgerald 2010) -> soft mask */
function hpssMask(mag,frames,K,wT,wF){
  const H=new Float32Array(frames*K), P=new Float32Array(frames*K);
  const hT=wT>>1, hF=wF>>1, buf=new Float64Array(Math.max(wT,wF));
  for(let k=0;k<K;k++){
    for(let t=0;t<frames;t++){
      let c=0;
      for(let d=-hT;d<=hT;d++){ const tt=t+d; if(tt>=0&&tt<frames) buf[c++]=mag[tt*K+k]; }
      H[t*K+k]=med(buf,c);
    }
  }
  for(let t=0;t<frames;t++){
    const o=t*K;
    for(let k=0;k<K;k++){
      let c=0;
      for(let d=-hF;d<=hF;d++){ const kk=k+d; if(kk>=0&&kk<K) buf[c++]=mag[o+kk]; }
      P[o+k]=med(buf,c);
    }
  }
  const M=new Float32Array(frames*K);
  for(let i=0;i<frames*K;i++){ const h=H[i]*H[i], p=P[i]*P[i]; M[i]= (h+p)>1e-20 ? h/(h+p) : 0.5; }
  return M;
}
function applyMask(S,M,invert){
  const {re,im,frames,K,n,hop}=S;
  const r=new Float32Array(re.length), i2=new Float32Array(im.length);
  for(let i=0;i<re.length;i++){ const g=invert?1-M[i]:M[i]; r[i]=re[i]*g; i2[i]=im[i]*g; }
  return {re:r,im:i2,frames,K,n,hop};
}

export {hpssMask,applyMask};
