/* ---------------- 88-key drawing ---------------- */
import {KD,kctx,dynColor} from './canvas.js';

const WHITE=[0,2,4,5,7,9,11];
function keyGeom(w){
  // A0(21) .. C8(108)
  let whites=[]; for(let m=21;m<=108;m++) if(WHITE.includes(m%12)) whites.push(m);
  const ww=w/whites.length;
  const xOf={};
  whites.forEach((m,i)=>xOf[m]=i*ww);
  return {whites,ww,xOf};
}
function drawKeys(rows){
  const {w,h}=KD; if(!w) return;
  kctx.clearRect(0,0,w,h);
  kctx.fillStyle='#0a0f12'; kctx.fillRect(0,0,w,h);
  const g=keyGeom(w), bh=h*0.62, bw=g.ww*0.62;
  const hit={}; rows.forEach(r=>hit[r.midi]=r);

  // white keys
  g.whites.forEach(m=>{
    const x=g.xOf[m], r=hit[m];
    kctx.fillStyle = r? dynColor(r.db,0.30+0.70*r.pf) : '#e2e8ea';
    kctx.fillRect(x+0.5,0,g.ww-1,h);
    kctx.strokeStyle='#0a0f12'; kctx.lineWidth=1;
    kctx.strokeRect(x+0.5,0,g.ww-1,h);
    if(r&&r.pf<0.45){ kctx.strokeStyle='#9184f0'; kctx.lineWidth=2;
      kctx.strokeRect(x+1.5,1,g.ww-3,h-2); }
    if(m%12===0){ // C markers
      kctx.fillStyle='#5d727e';
      kctx.font='9px '+ 'IBM Plex Mono, monospace';
      kctx.fillText('C'+(m/12-1), x+1, h-3);
    }
  });
  // black keys
  for(let m=21;m<=108;m++){
    if(WHITE.includes(m%12)) continue;
    const prevWhite = m-1;
    const x=g.xOf[prevWhite]+g.ww-bw/2;
    const r=hit[m];
    kctx.fillStyle = r? dynColor(r.db,0.42+0.58*r.pf) : '#141d23';
    kctx.fillRect(x,0,bw,bh);
    kctx.strokeStyle='#0a0f12'; kctx.lineWidth=1; kctx.strokeRect(x,0,bw,bh);
    if(r&&r.pf<0.45){ kctx.strokeStyle='#9184f0'; kctx.lineWidth=2; kctx.strokeRect(x+1,1,bw-2,bh-2); }
  }
  // confidence ticks under each hit
  rows.forEach(r=>{
    const isW=WHITE.includes(r.midi%12);
    const x= isW? g.xOf[r.midi] : g.xOf[r.midi-1]+g.ww-bw/2;
    const wdt= isW? g.ww : bw;
    kctx.fillStyle='#9184f0';
    kctx.fillRect(x+1,h-3,Math.max(1,(wdt-2)*r.pf),3);
  });
}

export {drawKeys};
