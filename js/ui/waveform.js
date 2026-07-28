/* ---------------- waveform canvas ----------------
   Drawing and view geometry only. The pointer gestures that drive it
   are wired in main.js, because they reach into the transport. */
import {$,S,clamp,fmtT} from '../state.js';
import {wctx,WD} from './canvas.js';

const t2x = t => (t-S.viewA)/(S.viewB-S.viewA)*WD.w;
const x2t = x => S.viewA + x/WD.w*(S.viewB-S.viewA);

/* where the playhead is right now, for the overlay below */
function curTime(){
  if(!S.playing) return S.selA||0;
  const a=S.selA, b=S.selB;
  let el=(S.ac.currentTime-S.playT0)*S.rate;
  if(S.loop){ const L=Math.max(0.01,b-a); el=el%L; }
  return Math.min(b,a+el);
}

function drawWave(){
  if(!S.mono) return;
  const {w,h}=WD, mid=h/2;
  wctx.clearRect(0,0,w,h);
  wctx.fillStyle='#0a0f12'; wctx.fillRect(0,0,w,h);

  // selection band
  if(S.selA!=null){
    const xa=t2x(S.selA), xb=t2x(S.selB);
    wctx.fillStyle='rgba(99,179,201,0.11)';
    wctx.fillRect(xa,0,xb-xa,h);
    wctx.fillStyle='rgba(99,179,201,0.85)';
    wctx.fillRect(xa-1,0,2,h); wctx.fillRect(xb-1,0,2,h);
    wctx.fillRect(xa-1,0,2,10); wctx.fillRect(xb-1,h-10,2,10);
  }
  // centre line
  wctx.strokeStyle='#1a252c'; wctx.lineWidth=1;
  wctx.beginPath(); wctx.moveTo(0,mid+.5); wctx.lineTo(w,mid+.5); wctx.stroke();

  const spanS=(S.viewB-S.viewA)*S.sr;
  wctx.strokeStyle='#7fa9b8'; wctx.fillStyle='#7fa9b8';
  if(spanS/w < 3){
    // sample-accurate line
    wctx.beginPath();
    for(let px=0;px<w;px++){
      const i=Math.round(x2t(px)*S.sr);
      const v=(i>=0&&i<S.mono.length)?S.mono[i]:0;
      const y=mid-v*mid*0.94;
      px?wctx.lineTo(px,y):wctx.moveTo(px,y);
    }
    wctx.stroke();
  }else{
    const {mn,mx,cnt}=S.peaks, bs=S.pkSize;
    for(let px=0;px<w;px++){
      const ia=clamp(Math.floor(x2t(px)*S.sr/bs),0,cnt-1);
      const ib=clamp(Math.floor(x2t(px+1)*S.sr/bs),0,cnt-1);
      let a=1e9,b=-1e9;
      for(let i=ia;i<=ib;i++){ if(mn[i]<a)a=mn[i]; if(mx[i]>b)b=mx[i]; }
      if(a===1e9){a=0;b=0;}
      const y1=mid-b*mid*0.94, y2=mid-a*mid*0.94;
      wctx.fillRect(px,y1,1,Math.max(1,y2-y1));
    }
  }
  // playhead
  if(S.playing){
    const t=curTime();
    const x=t2x(t);
    if(x>=0&&x<=w){ wctx.fillStyle='#e7eef2'; wctx.fillRect(x-0.5,0,1.5,h); }
  }
  $('#hudL').textContent=fmtT(S.viewA);
  $('#hudR').textContent=fmtT(S.viewB);
  $('#selTxt').textContent = S.selA!=null ? fmtT(S.selA)+' → '+fmtT(S.selB)+'  ('+(S.selB-S.selA).toFixed(2)+'s)' : '—';
  updLevel();
}
function updLevel(){
  if(S.selA==null||!S.mono){ $('#lvlTxt').textContent='—'; return; }
  const a=Math.max(0,Math.floor(S.selA*S.sr)), b=Math.min(S.mono.length,Math.floor(S.selB*S.sr));
  let pk=0,rms=0,n=0;
  for(let i=a;i<b;i+=7){ const v=Math.abs(S.mono[i]); if(v>pk)pk=v; rms+=v*v; n++; }
  rms=Math.sqrt(rms/Math.max(1,n));
  $('#lvlTxt').textContent='peak '+(20*Math.log10(pk||1e-9)).toFixed(1)+' dBFS · rms '+(20*Math.log10(rms||1e-9)).toFixed(1);
}

function zoomBy(f){
  const span=S.viewB-S.viewA, c=(S.viewA+S.viewB)/2;
  let ns=clamp(span*f,0.0015,S.dur);
  let na=clamp(c-ns/2,0,Math.max(0,S.dur-ns));
  S.viewA=na; S.viewB=na+ns; drawWave();
}

export {t2x,x2t,drawWave,zoomBy};
