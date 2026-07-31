/* ============================================================
   APP STATE — the one place S, $ and the AudioContext live.
   Imports nothing, so every other module can import it freely.
   ============================================================ */

const $ = s => document.querySelector(s);
const clamp = (v,a,b) => v<a?a:v>b?b:v;
const fmtT = t => {
  const m = Math.floor(t/60), s = t-m*60;
  return m+':'+(s<10?'0':'')+s.toFixed(2);
};
const yield_=()=>new Promise(r=>setTimeout(r,0));

const S={
  ac:null, buf:null, mono:null, sr:44100, dur:0,
  viewA:0, viewB:0, selA:null, selB:null,
  peaks:null, pkSize:256,
  src:null, playT0:0, playOff:0, playing:false, loop:true, rate:1,
  iso:'full', isoBufs:{},
  ana:null, hpss:true, thr:0.12, a4:440, fftN:16384, decay:0.72,
  GATE:0.08, NMS:1.5, voice:'piano', useDyn:true, rows:null,
  rec:null
};

/* which notes are ticked in the voicing table — read by the
   resynthesis and by the harmonic-comb isolation */
let noteOn=new Set();

/* an explicit decision the user made about a note, index -> boolean.
   noteOn is derived from this on every render, so a note you switched off
   stays off when the threshold slider recomputes the candidate list. Absent
   means "no opinion", and the default applies. Cleared on a new analysis. */
let noteVote=new Map();

function ac(){
  if(!S.ac) S.ac=new (window.AudioContext||window.webkitAudioContext)();
  if(S.ac.state==='suspended') S.ac.resume();
  return S.ac;
}
/* resume() is a promise, and a suspended context's currentTime does not
   advance. Scheduling against that clock silently drops everything, which
   is the usual reason playback "sometimes does nothing" on a phone — iOS
   suspends the context on interruptions and after backgrounding, not only
   before the first gesture. Await this anywhere playback is about to start. */
async function acReady(){
  const c=ac();
  if(c.state!=='running'){ try{ await c.resume(); }catch(e){} }
  return c;
}
function setStatus(t,busy,err){
  const el=$('#status');
  el.className=err?'err':'';
  el.innerHTML=(busy?'<span class="spin"></span>':'')+t;
}

export {$,clamp,fmtT,yield_,S,noteOn,noteVote,ac,acReady,setStatus};
