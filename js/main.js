/* ============================================================
   Harmonograph — chord, voicing and dynamics analyzer
   Entry point. Pulls the modules in and wires the controls that
   span more than one of them: the waveform gestures (they drive
   the transport), the analysis settings, and window events.
   The Source, transport and playback panels wire themselves in
   audio.js, next to the code they drive.
   ============================================================ */
import {$,S,clamp} from './state.js';
import {wave,WD,fitCanvas} from './ui/canvas.js';
import {t2x,x2t,drawWave,zoomBy} from './ui/waveform.js';
import {renderResult} from './ui/panels.js';
import {startPlay} from './audio.js';
import {detectA4,analyze} from './analysis.js';

/* ---------------- pointer: select + pinch zoom ---------------- */
const ptrs=new Map();
let mode=null, dragEdge=null, pinch=null, selSave=null;
wave.addEventListener('pointerdown',e=>{
  if(!S.mono) return;
  wave.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId,{x:e.offsetX,y:e.offsetY});
  if(ptrs.size===1){
    const x=e.offsetX;
    selSave={a:S.selA,b:S.selB};          // a second finger may yet turn this into a pinch
    if(S.selA!=null){
      const xa=t2x(S.selA), xb=t2x(S.selB);
      if(Math.abs(x-xa)<18){ mode='edge'; dragEdge='a'; return; }
      if(Math.abs(x-xb)<18){ mode='edge'; dragEdge='b'; return; }
    }
    mode='new'; S.selA=S.selB=clamp(x2t(x),0,S.dur); drawWave();
  }else if(ptrs.size===2){
    mode='pinch';
    // the first finger already collapsed the fence to a point; that was a
    // pinch starting, not a new selection, so put it back
    if(selSave){ S.selA=selSave.a; S.selB=selSave.b; drawWave(); }
    const p=[...ptrs.values()];
    pinch={d:Math.abs(p[0].x-p[1].x)||1, c:(p[0].x+p[1].x)/2, a:S.viewA, b:S.viewB};
  }
},{passive:false});
wave.addEventListener('pointermove',e=>{
  if(!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId,{x:e.offsetX,y:e.offsetY});
  if(mode==='pinch'&&ptrs.size===2){
    const p=[...ptrs.values()];
    const d=Math.abs(p[0].x-p[1].x)||1, c=(p[0].x+p[1].x)/2;
    const span=pinch.b-pinch.a;
    const anchorT=pinch.a+pinch.c/WD.w*span;
    let ns=clamp(span*pinch.d/d, 0.0015, S.dur);
    let na=anchorT-(c/WD.w)*ns;
    na=clamp(na,0,Math.max(0,S.dur-ns));
    S.viewA=na; S.viewB=na+ns; drawWave();
  }else if(mode==='new'){
    const t=clamp(x2t(e.offsetX),0,S.dur);
    S.selB=t; drawWave();
  }else if(mode==='edge'){
    const t=clamp(x2t(e.offsetX),0,S.dur);
    if(dragEdge==='a') S.selA=t; else S.selB=t;
    drawWave();
  }
});
function endPtr(e){
  ptrs.delete(e.pointerId);
  if(ptrs.size===0){
    if(mode==='new'||mode==='edge'){
      if(S.selA>S.selB){ const t=S.selA; S.selA=S.selB; S.selB=t; }
      if(S.selB-S.selA<0.03){ S.selB=Math.min(S.dur,S.selA+0.4); }
      S.isoBufs={};
      if(S.playing) startPlay();
    }
    mode=null;
    drawWave();
  }
}
wave.addEventListener('pointerup',endPtr);
wave.addEventListener('pointercancel',endPtr);
wave.addEventListener('wheel',e=>{
  if(!S.mono) return;
  e.preventDefault();
  const span=S.viewB-S.viewA;
  if(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY)){
    const d=(e.deltaX||e.deltaY)/WD.w*span;
    let a=clamp(S.viewA+d,0,S.dur-span); S.viewA=a; S.viewB=a+span;
  }else{
    const anchor=x2t(e.offsetX);
    let ns=clamp(span*Math.pow(1.0022,e.deltaY),0.0015,S.dur);
    let na=clamp(anchor-(e.offsetX/WD.w)*ns,0,Math.max(0,S.dur-ns));
    S.viewA=na; S.viewB=na+ns;
  }
  drawWave();
},{passive:false});

$('#zoomIn').onclick=()=>zoomBy(0.55);
$('#zoomOut').onclick=()=>zoomBy(1.8);
$('#zoomAll').onclick=()=>{ S.viewA=0; S.viewB=S.dur; drawWave(); };
$('#zoomSel').onclick=()=>{
  if(S.selA==null) return;
  const pad=(S.selB-S.selA)*0.25;
  S.viewA=Math.max(0,S.selA-pad); S.viewB=Math.min(S.dur,S.selB+pad); drawWave();
};

/* ---------------- settings wiring ---------------- */
$('#a4').oninput=e=>{ S.a4=clamp(+e.target.value||440,380,500); S.ana=null; };
$('#thr').oninput=e=>{ S.thr=+e.target.value; $('#thrTxt').textContent=S.thr.toFixed(2); if(S.ana) renderResult(); };
$('#fftSize').onchange=e=>{ S.fftN=+e.target.value; };
$('#decay').oninput=e=>{ S.decay=+e.target.value; $('#decTxt').textContent=S.decay.toFixed(2); };
$('#fund').oninput=e=>{ S.fund=+e.target.value; $('#fundTxt').textContent=S.fund.toFixed(2); };
$('#hpssBtn').onclick=e=>{ S.hpss=!S.hpss; e.target.classList.toggle('on',S.hpss); };
$('#analyzeBtn').onclick=()=>analyze();
$('#detectA4').onclick=()=>detectA4();

/* ---------------- resize ---------------- */
let rt=null;
window.addEventListener('resize',()=>{
  clearTimeout(rt);
  rt=setTimeout(()=>{
    fitCanvas();
    if(S.mono) drawWave();
    if(S.ana) renderResult();
  },120);
});
window.addEventListener('orientationchange',()=>setTimeout(()=>{fitCanvas();S.mono&&drawWave();S.ana&&renderResult();},300));
document.addEventListener('touchstart',()=>{ if(S.ac&&S.ac.state==='suspended') S.ac.resume(); },{passive:true});
