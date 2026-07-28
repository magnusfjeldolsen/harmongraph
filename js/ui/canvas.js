/* Canvas plumbing shared by the three views (waveform, 88-key map,
   spectrum): the elements, their contexts, device-pixel-ratio fitting,
   and the level -> colour ramp they all draw with. */
import {$,clamp} from '../state.js';

const wave=$('#wave'), wctx=wave.getContext('2d');
const keys=$('#keys'), kctx=keys.getContext('2d');
const spec=$('#spec'), sctx=spec.getContext('2d');
function fitOne(c){
  const dpr=Math.min(window.devicePixelRatio||1,2.5);
  const r=c.getBoundingClientRect();
  c.width=Math.max(1,Math.round(r.width*dpr));
  c.height=Math.max(1,Math.round(r.height*dpr));
  const x=c.getContext('2d'); x.setTransform(dpr,0,0,dpr,0,0);
  return {w:r.width,h:r.height};
}
let WD={w:0,h:0},KD={w:0,h:0},SD={w:0,h:0};
function fitCanvas(){
  WD=fitOne(wave);
  if($('#resPanel').style.display!=='none'){ KD=fitOne(keys); SD=fitOne(spec); }
}

/* ---------------- colour ---------------- */
function dynColor(db,alpha){
  const t=clamp((db+48)/48,0,1);
  const h=120*(1-t);
  return `hsla(${h.toFixed(0)},82%,${(46+8*t).toFixed(0)}%,${alpha})`;
}

export {wave,wctx,kctx,sctx,WD,KD,SD,fitCanvas,dynColor};
