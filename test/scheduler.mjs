/* Playback scheduler test — `node test/scheduler.mjs`
   No dependencies, no browser.

   js/audio.js is the one module that cannot be exercised by the analysis
   harness and cannot be checked by reading it, because what matters is
   *when* things are scheduled. So: stub the DOM and Web Audio, import the
   real module, drive its buttons, and assert on the schedule.

   The load-bearing assertion is that toggling a note stops nothing. The
   old renderChord()/restartSynth() path tore down and re-rendered the whole
   chord on every tick, which restarted the loop from the top. */

const els=new Map();
const intervals=[];
function el(sel){
  if(els.has(sel)) return els.get(sel);
  const e={
    _sel:sel, style:{}, dataset:{}, textContent:'', innerHTML:'', value:'0.5',
    classList:{ _s:new Set(), add(c){this._s.add(c)}, remove(c){this._s.delete(c)},
                toggle(c,v){ v?this._s.add(c):this._s.delete(c) }, contains(c){return this._s.has(c)} },
    addEventListener(){}, removeEventListener(){}, appendChild(){},
    getBoundingClientRect:()=>({width:334,height:92,left:0,top:0}),
    getContext:()=>new Proxy({},{get:()=>()=>{}}),
    querySelector:()=>el(sel+' *'),
  };
  els.set(sel,e);
  return e;
}
globalThis.document={querySelector:el,querySelectorAll:()=>[],
  createElement:()=>el('#made'+els.size),addEventListener(){}};

let NOW=0;
const started=[], stopped=[];
class Param{ constructor(v){this.value=v}
  setValueAtTime(v){this.value=v; return this}
  linearRampToValueAtTime(v){this.value=v; return this} }
class Node{
  constructor(t){ this.type=t; this.gain=new Param(1); this.frequency=new Param(0);
                  this.playbackRate=new Param(1); }
  connect(d){ return d } disconnect(){}
  start(t,off,len){ this._start=t??NOW; this._off=off; this._len=len; started.push(this) }
  stop(){ if(!this._stopped){ this._stopped=true; stopped.push(this); } }
}
class Ctx{
  constructor(){ this.destination=new Node('dest'); this.state='running' }
  get currentTime(){ return NOW }
  createGain(){ return new Node('gain') }
  createBufferSource(){ return new Node('src') }
  createOscillator(){ return new Node('osc') }
  createBuffer(ch,len,sr){ return {length:len,sampleRate:sr,numberOfChannels:ch,
    copyToChannel(){}, getChannelData:()=>new Float32Array(len)} }
  resume(){}
}
globalThis.window={AudioContext:Ctx,devicePixelRatio:1,addEventListener(){}};
globalThis.setInterval=fn=>{ intervals.push(fn); return intervals.length-1 };
globalThis.clearInterval=id=>{ if(intervals[id]) intervals[id]=()=>{}; };
globalThis.performance={now:()=>0};
globalThis.requestAnimationFrame=()=>0;
/* Click handlers do not return their promise, so awaiting the handler does
   not await the work. Drain the microtask queue instead. */
const flush=async()=>{ for(let i=0;i<8;i++) await Promise.resolve(); await new Promise(r=>setTimeout(r,0)); };

const {S,noteOn}=await import('../js/state.js');
await import('../js/audio.js');

S.sr=44100; S.a4=440; S.voice='piano'; S.useDyn=true;
S.dur=3; S.selA=0; S.selB=2; S.mono=new Float32Array(44100*3); S.buf={};
S.pkSize=256;                                  // drawWave() reads the peak pyramid
{ const cnt=Math.ceil(S.mono.length/S.pkSize);
  S.peaks={mn:new Float32Array(cnt), mx:new Float32Array(cnt), cnt}; }
S.rows=[{i:39,midi:60,name:'C4',db:0},  {i:43,midi:64,name:'E4',db:-4},
        {i:46,midi:67,name:'G4',db:-6}, {i:50,midi:71,name:'B4',db:-9},
        {i:53,midi:74,name:'D5',db:-12}];
noteOn.clear(); S.rows.forEach(r=>noteOn.add(r.i));

const pump=()=>intervals.forEach(f=>f());
const srcs=()=>started.filter(n=>n.type==='src');
let fails=0;
function check(label,got,want){
  const ok=String(got)===String(want);
  if(!ok) fails++;
  console.log((ok?'  ok  ':'  FAIL')+'  '+label.padEnd(46)+got+(ok?'':'   want '+want));
}

console.log('chord loop');
await el('#synthPlay').onclick();
check('notes scheduled on the first cycle',srcs().length,5);
check('all struck together',new Set(srcs().map(n=>n._start.toFixed(4))).size,1);

console.log('\nediting a running loop');
let n0=srcs().length;
noteOn.delete(43);                       // untick E4 mid-loop
NOW=3.1; pump();
check('next cycle drops the unticked note',srcs().length-n0,4);
check('nothing already playing was stopped',stopped.length,0);
n0=srcs().length;
noteOn.add(43);
NOW=6.3; pump();
check('re-ticking restores it next cycle',srcs().length-n0,5);
check('still no restart',stopped.length,0);

console.log('\narpeggio');
await el('#synthPlay').onclick();
started.length=0; stopped.length=0; NOW=10;
await el('#synthArp').onclick();
const on=srcs().map(n=>n._start).sort((a,b)=>a-b);
const gaps=on.slice(1).map((v,i)=>+(v-on[i]).toFixed(3));
check('110 ms stagger between entries',[...new Set(gaps)].join(','),'0.11');

console.log('\nA/B');
await el('#synthArp').onclick();
started.length=0; stopped.length=0; NOW=20;
await el('#abBtn').onclick();
const rec=srcs().filter(n=>n._len!==undefined);
check('one source for the recording half',rec.length,1);
check('and the note stack after it',srcs().length-rec.length,5);
const gap=Math.min(...srcs().filter(n=>n._len===undefined).map(n=>n._start))-(rec[0]._start+rec[0]._len);
check('gap between the halves',gap.toFixed(3),'0.300');

console.log('\nteardown');
const live=srcs().filter(n=>!n._stopped).length;
await el('#abBtn').onclick();
check('every live source stopped',stopped.length,live);

/* Rendering cold notes spans hundreds of ms of awaits. A press landing in
   that window must supersede the in-flight start, not race it — otherwise
   two schedulers exist, only one is reachable by stop, and synthKind can end
   up set while the button reads "Play", which makes the button dead. */
console.log('\npressing play twice while notes are still rendering');
S.voice='rhodes';                          // cold cache, so the render awaits
started.length=0; stopped.length=0; NOW=30;
const p1=el('#synthPlay').onclick();
const p2=el('#synthPlay').onclick();
await p1; await p2;
NOW=31; pump();
check('second press stops rather than racing',el('#synthPlay').textContent,'▶ Play chord');
check('no scheduler left running',srcs().length,0);

/* The workflow is record -> analyse -> play the chord. Those two transports
   must never sound at once: starting the chord has to abort the recording
   loop, and starting the recording has to abort the chord. */
console.log('\none transport at a time');
S.voice='piano';
await el('#synthPlay').onclick();               // stop whatever is running
started.length=0; NOW=50;
S.playing=false;
el('#playBtn').onclick(); await flush();        // recording loop
check('recording loop is playing',S.playing,true);
await el('#synthPlay').onclick(); await flush();// now play the chord
check('starting the chord stops the recording',S.playing,false);
check('and the chord is running',el('#synthPlay').textContent,'■ Stop');
el('#playBtn').onclick(); await flush();        // back to the recording
check('starting the recording stops the chord',el('#synthPlay').textContent,'▶ Play chord');
check('recording is playing again',S.playing,true);
el('#playBtn').onclick(); await flush();
check('and stops',S.playing,false);

console.log('\nand the button still works afterwards');
started.length=0; NOW=40;
await el('#synthPlay').onclick();
check('a later press starts cleanly',srcs().length,5);
check('button reflects it',el('#synthPlay').textContent,'■ Stop');
await el('#synthPlay').onclick();
check('and stops again',el('#synthPlay').textContent,'▶ Play chord');

console.log('\n'+(fails?fails+' FAILED':'all passed'));
process.exit(fails?1:0);
