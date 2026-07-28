/* ---------------- spectrum drawing ---------------- */
import {S,clamp} from '../state.js';
import {BPS,LO} from '../dsp/nnls.js';
import {SD,sctx,dynColor} from './canvas.js';

function drawSpec(rows){
  const {w,h}=SD; if(!w) return;
  const A=S.ana;
  sctx.clearRect(0,0,w,h);
  sctx.fillStyle='#0a0f12'; sctx.fillRect(0,0,w,h);
  const k0=0, k1=(108-LO)*BPS;                 // show A0..C8
  const nb=k1-k0;
  const X=k=>(k-k0)/nb*w;
  let mx=0; for(let k=k0;k<k1;k++){ if(A.yw[k]>mx) mx=A.yw[k]; }
  mx=mx||1;
  const Y=v=>h-4-clamp(v/mx,0,1)*(h-16);

  // octave grid
  for(let m=24;m<=108;m+=12){
    const x=X((m-LO)*BPS);
    sctx.strokeStyle='#1a252c'; sctx.lineWidth=1;
    sctx.beginPath(); sctx.moveTo(x,0); sctx.lineTo(x,h); sctx.stroke();
    sctx.fillStyle='#3d525c'; sctx.font='9px IBM Plex Mono, monospace';
    sctx.fillText('C'+(m/12-1),x+2,10);
  }
  // observed
  sctx.beginPath(); sctx.moveTo(X(k0),h);
  for(let k=k0;k<k1;k++) sctx.lineTo(X(k),Y(A.yw[k]));
  sctx.lineTo(X(k1-1),h); sctx.closePath();
  sctx.fillStyle='rgba(160,180,190,0.22)'; sctx.fill();
  // explained by the NNLS fit
  sctx.beginPath();
  for(let k=k0;k<k1;k++){ const x=X(k),y=Y(A.recon[k]); k===k0?sctx.moveTo(x,y):sctx.lineTo(x,y); }
  sctx.strokeStyle='#63b3c9'; sctx.lineWidth=1.3; sctx.stroke();
  // fundamentals
  rows.forEach(r=>{
    const x=X(A.fundBin[r.i]);
    sctx.strokeStyle=dynColor(r.db,0.95); sctx.lineWidth=2;
    sctx.beginPath(); sctx.moveTo(x,h); sctx.lineTo(x,h-13); sctx.stroke();
    sctx.fillStyle=dynColor(r.db,1); sctx.font='9px IBM Plex Mono, monospace';
    sctx.fillText(r.name,x+2,h-16);
  });
}

export {drawSpec};
