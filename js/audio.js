/* ============================================================
   AUDIO — everything that touches the AudioContext: loading and
   decoding, the waveform transport, mic capture, the isolation
   layers, and the resynthesis voices.
   Owns the controls of the Source, Waveform-transport, Listen and
   Hear-the-chord-back panels.
   ============================================================ */
import {$,S,clamp,ac,setStatus,yield_,noteOn} from './state.js';
import {midiFreq} from './pitch.js';
import {NOTE_LO} from './dsp/nnls.js';
import {stft,istft} from './dsp/fft.js';
import {applyMask} from './dsp/hpss.js';
import {fitCanvas} from './ui/canvas.js';
import {drawWave} from './ui/waveform.js';

/* ---------------- loading ---------------- */
async function loadArrayBuffer(ab,label){
  setStatus('Decoding '+label+' …',true);
  try{
    const b=await ac().decodeAudioData(ab);
    setBuffer(b,label);
  }catch(e){
    setStatus('Could not decode that file. Try WAV, MP3 or M4A.',false,true);
  }
}
function setBuffer(b,label){
  S.buf=b; S.sr=b.sampleRate; S.dur=b.duration;
  const n=b.length, m=new Float32Array(n);
  for(let c=0;c<b.numberOfChannels;c++){ const d=b.getChannelData(c); for(let i=0;i<n;i++) m[i]+=d[i]; }
  const g=1/b.numberOfChannels; for(let i=0;i<n;i++) m[i]*=g;
  S.mono=m;
  buildPeaks();
  S.viewA=0; S.viewB=S.dur;
  S.selA=0; S.selB=Math.min(S.dur,2.5);
  S.isoBufs={}; S.ana=null;
  $('#srcInfo').textContent=label+' · '+S.dur.toFixed(1)+'s · '+S.sr+' Hz';
  $('#wavePanel').style.display='';
  $('#setPanel').style.display='';
  $('#resPanel').style.display='none';
  fitCanvas(); drawWave();
  setStatus('Drag on the waveform to fence a chord, then press Analyze.');
}
function buildPeaks(){
  const m=S.mono, bs=S.pkSize, cnt=Math.ceil(m.length/bs);
  const mn=new Float32Array(cnt), mx=new Float32Array(cnt);
  for(let i=0;i<cnt;i++){
    let a=1e9,b=-1e9; const s=i*bs, e=Math.min(m.length,s+bs);
    for(let j=s;j<e;j++){ const v=m[j]; if(v<a)a=v; if(v>b)b=v; }
    mn[i]=a===1e9?0:a; mx[i]=b===-1e9?0:b;
  }
  S.peaks={mn,mx,cnt};
}

/* ---------------- transport ---------------- */
function stopPlay(){
  if(S.src){ try{S.src.stop();}catch(e){} S.src.disconnect(); S.src=null; }
  S.playing=false; $('#playBtn').textContent='▶ Play loop'; $('#playBtn').classList.add('pri');
}
function playBuffer(){
  // returns the AudioBuffer to play for the current isolation mode
  if(S.iso==='full'||!S.ana) return {buf:S.buf,off:S.selA,len:S.selB-S.selA,full:true};
  const b=S.isoBufs[S.iso];
  if(!b) return {buf:S.buf,off:S.selA,len:S.selB-S.selA,full:true};
  return {buf:b,off:0,len:b.duration,full:false};
}
function startPlay(){
  if(!S.buf) return;
  stopPlay(); stopSynth();
  const c=ac();
  const P=playBuffer();
  const s=c.createBufferSource();
  s.buffer=P.buf;
  s.playbackRate.value=S.rate;
  if(S.loop){ s.loop=true; s.loopStart=P.off; s.loopEnd=P.off+P.len; }
  const g=c.createGain(); g.gain.value=1;
  s.connect(g).connect(c.destination);
  s.start(0,P.off,S.loop?undefined:P.len);
  S.src=s; S.playing=true; S.playT0=c.currentTime;
  $('#playBtn').textContent='■ Stop'; $('#playBtn').classList.remove('pri');
  s.onended=()=>{ if(S.src===s) stopPlay(); };
  tick();
}
function tick(){ if(!S.playing) { drawWave(); return; } drawWave(); requestAnimationFrame(tick); }
$('#playBtn').onclick=()=>{ S.playing?stopPlay():startPlay(); };
$('#loopBtn').onclick=e=>{ S.loop=!S.loop; e.target.classList.toggle('on',S.loop); if(S.playing) startPlay(); };
$('#rate').oninput=e=>{ S.rate=+e.target.value; $('#rateTxt').textContent=S.rate.toFixed(2)+'×'; if(S.src) S.src.playbackRate.value=S.rate; };

/* ---------------- file / record ---------------- */
$('#drop').onclick=()=>$('#file').click();
$('#file').onchange=async e=>{
  const f=e.target.files[0]; if(!f) return;
  ac();
  await loadArrayBuffer(await f.arrayBuffer(), f.name.length>26?f.name.slice(0,24)+'…':f.name);
};
['dragover','dragenter'].forEach(k=>$('#drop').addEventListener(k,e=>{e.preventDefault();$('#drop').classList.add('over');}));
['dragleave','drop'].forEach(k=>$('#drop').addEventListener(k,e=>{e.preventDefault();$('#drop').classList.remove('over');}));
$('#drop').addEventListener('drop',async e=>{
  const f=e.dataTransfer.files[0]; if(!f) return;
  ac(); await loadArrayBuffer(await f.arrayBuffer(),f.name);
});

/* Mic capture writes raw PCM straight into an AudioBuffer. MediaRecorder would mean
   an Opus/AAC round-trip — lossy in exactly the high partials the NNLS fit reads,
   and a decode step that can fail after the take is already gone. */
function micError(err){
  const n=(err&&err.name)||String(err);
  if(location.protocol==='file:')
    return 'Mic access is blocked on file:// pages ('+n+'). Open the hosted copy at '
      +'magnusfjeldolsen.github.io/harmongraph, or serve this folder over http://localhost.';
  if(n==='NotAllowedError'||n==='SecurityError')
    return 'Microphone permission denied. Allow it for this site from the address bar, then try again.';
  if(n==='NotFoundError'||n==='OverconstrainedError') return 'No microphone found on this device.';
  if(n==='NotReadableError') return 'The microphone is busy — another app or tab is holding it.';
  return 'Microphone failed to start: '+n;
}
function stopRec(){
  const R=S.rec; if(!R) return; S.rec=null;
  clearInterval(R.timer); R.node.onaudioprocess=null;
  try{ R.src.disconnect(); R.node.disconnect(); R.mute.disconnect(); }catch(e){}
  R.stream.getTracks().forEach(t=>t.stop());
  $('#recBtn').classList.remove('armed'); $('#recBtn').textContent='● Record from mic';
  if(!R.n){ setStatus('Nothing was captured — the mic delivered no audio.',false,true); return; }
  const b=R.ctx.createBuffer(1,R.n,R.ctx.sampleRate), d=b.getChannelData(0);
  let o=0; for(const ch of R.chunks){ d.set(ch,o); o+=ch.length; }
  setBuffer(b,'mic recording');
}
$('#recBtn').onclick=async()=>{
  if(S.rec){ stopRec(); return; }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    setStatus(micError({name:'unsupported'}),false,true); return;
  }
  let stream=null;
  try{
    const c=ac();
    stream=await navigator.mediaDevices.getUserMedia({audio:{
      echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1
    }});
    const src=c.createMediaStreamSource(stream);
    const node=c.createScriptProcessor(4096,1,1);
    const mute=c.createGain(); mute.gain.value=0;   // a ScriptProcessor only pulls once routed to the destination
    const R={ctx:c,stream,src,node,mute,chunks:[],n:0};
    node.onaudioprocess=e=>{                        // keep this callback cheap — a slow one drops input
      const d=e.inputBuffer.getChannelData(0);
      R.chunks.push(new Float32Array(d)); R.n+=d.length;
    };
    src.connect(node); node.connect(mute); mute.connect(c.destination);
    R.timer=setInterval(()=>setStatus('Recording '+(R.n/c.sampleRate).toFixed(1)+'s — press again to stop.',true),250);
    S.rec=R;
    $('#recBtn').classList.add('armed'); $('#recBtn').textContent='■ Stop recording';
    setStatus('Recording — mic processing disabled for musical accuracy.',true);
  }catch(err){
    if(stream) stream.getTracks().forEach(t=>t.stop());
    setStatus(micError(err),false,true);
  }
};

/* synthetic test chord: Cmaj9 voicing, piano-ish partials + a little noise */
$('#demoBtn').onclick=()=>{
  const c=ac(), sr=c.sampleRate, dur=4.0, N=(sr*dur)|0;
  const b=c.createBuffer(1,N,sr), d=b.getChannelData(0);
  const a4=440;
  const voicing=[36,48,55,64,67,74];       // C2 C3 G3 E4 G4 D5
  const gains  =[0.9,0.55,0.4,0.5,0.35,0.3];
  voicing.forEach((m,vi)=>{
    const f0=midiFreq(m,a4);
    for(let h=1;h<=14;h++){
      const f=f0*h*(1+0.0004*h*h);          // slight inharmonicity
      if(f>sr/2*0.9) break;
      const amp=gains[vi]*Math.pow(0.62,h-1)*(0.85+0.3*Math.random());
      const ph=Math.random()*6.283;
      const dec=1.6+3.5/h;
      for(let i=0;i<N;i++){
        const t=i/sr;
        d[i]+=amp*Math.exp(-t/dec)*Math.sin(2*Math.PI*f*t+ph);
      }
    }
  });
  let mx=0; for(let i=0;i<N;i++){ d[i]+=(Math.random()-0.5)*0.0015; if(Math.abs(d[i])>mx)mx=Math.abs(d[i]); }
  for(let i=0;i<N;i++) d[i]*=0.82/mx;
  setBuffer(b,'test chord (C2 C3 G3 E4 G4 D5)');
};

/* ---------------- isolation resynthesis ---------------- */
document.querySelectorAll('.iso').forEach(b=>{
  b.onclick=async()=>{
    document.querySelectorAll('.iso').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); S.iso=b.dataset.iso;
    if(S.iso!=='full'){ await buildIso(S.iso); }
    if(S.playing) startPlay();
  };
});

async function buildIso(kind){
  if(S.isoBufs[kind]) return;
  const F=S._fine; if(!F){ return; }
  setStatus('Rendering layer …',true); await yield_();
  const c=ac();
  let out;
  if(kind==='harm'||kind==='perc'){
    if(!F.Sf){ setStatus('Turn on “Strip percussion” and analyze again to use this layer.',false,true); return; }
    out = kind==='harm'? S.ana.harm : S.ana.perc;
  }else if(kind==='notes'){
    const sig=F.sig, n=4096, hop=2048;
    const Sn=F.Sf||stft(sig,n,hop);
    const K=Sn.K, df=S.sr/Sn.n;
    const keep=new Float32Array(K);
    const list=[...noteOn];
    if(!list.length){ setStatus('Tick at least one note to solo it.',false,true); return; }
    list.forEach(i=>{
      const f0=midiFreq(NOTE_LO+i,S.a4);
      for(let hh=1;hh<=16;hh++){
        const f=f0*hh; if(f>S.sr/2) break;
        const wid=f*(Math.pow(2,50/1200)-1);          // ±50 cents soft
        const lo=Math.max(1,Math.floor((f-wid)/df)), hi=Math.min(K-1,Math.ceil((f+wid)/df));
        for(let k=lo;k<=hi;k++){
          const d=Math.abs(k*df-f)/wid;
          const g=0.5+0.5*Math.cos(Math.PI*clamp(d,0,1));
          if(g>keep[k]) keep[k]=g;
        }
      }
    });
    const M=new Float32Array(Sn.frames*K);
    for(let t=0;t<Sn.frames;t++) for(let k=0;k<K;k++) M[t*K+k]=keep[k]*(F.mask?F.mask[t*K+k]:1);
    out=istft(applyMask(Sn,M,false),sig.length);
  }
  if(!out) return;
  const b=c.createBuffer(1,out.length,S.sr);
  b.copyToChannel(out,0);
  S.isoBufs[kind]=b;
  setStatus('Layer ready — press play.');
}

/* ============================================================
   RESYNTHESIS — hear the detected chord back
   Additive/FM rendered straight into a Float32Array. Table-lookup
   oscillators and multiplicative envelopes keep it fast enough
   to render on a phone in well under a second.
   ============================================================ */
const SINT=new Float32Array(8193);
for(let i=0;i<=8192;i++) SINT[i]=Math.sin(2*Math.PI*i/8192);
function sinT(p){
  p-=Math.floor(p);
  const x=p*8192, i=x|0, f=x-i;
  return SINT[i]+(SINT[i+1]-SINT[i])*f;
}

/* Grand piano: inharmonic partial series, per-partial decay,
   two slightly detuned strings on the low partials for beating,
   plus a short hammer-noise transient. */
function pianoVoice(out,off,L,sr,f0,midi,amp,vel){
  const B=5e-5*Math.pow(2,(midi-21)/24);          // string inharmonicity
  const nH=Math.min(18,6+Math.round(14*vel));      // louder = brighter
  const s=0.48+0.26*vel;
  const tau0=6.0*Math.exp(-(midi-21)/58);          // bass rings longer
  const atk=Math.max(2,Math.round(sr*0.004));
  for(let h=1;h<=nH;h++){
    const a0=amp*Math.pow(s,h-1)*(h===1?1:0.92);
    if(a0<0.0015) break;
    const fh=h*f0*Math.sqrt(1+B*h*h);
    if(fh>sr*0.45) break;
    const dec=Math.exp(-1/((tau0/(1+0.5*(h-1)))*sr));
    const strings=h<=5?[-0.45,0.45]:[0];
    for(const ct of strings){
      const dph=fh*Math.pow(2,ct/1200)/sr;
      let ph=Math.random(), env=a0/strings.length;
      for(let i=0;i<L-off;i++){
        let e=env; if(i<atk) e*=i/atk;
        out[off+i]+=e*sinT(ph);
        ph+=dph; if(ph>=1) ph-=1;
        env*=dec; if(env<1e-5) break;
      }
    }
  }
  const nl=Math.round(sr*0.012); let lp=0;
  for(let i=0;i<nl&&off+i<L;i++){
    lp=lp*0.6+(Math.random()*2-1)*0.4;
    out[off+i]+=lp*0.05*vel*amp*Math.exp(-i/(nl*0.35));
  }
}

/* Rhodes: a harmonic body with fast-decaying upper partials, plus a
   separate short "tine" partial near 6f0 — that ding is the whole
   character. Deliberately kept harmonic: a literal 14:1 FM patch
   throws off inharmonic sidebands that read as phantom high notes. */
function rhodesVoice(out,off,L,sr,f0,midi,amp,vel){
  const tau=2.8*Math.exp(-(midi-21)/72);
  const atk=Math.max(2,Math.round(sr*0.005));
  const body=[[1,1.0,1.00],[2,0.30+0.25*vel,0.72],[3,0.09+0.14*vel,0.52],[4,0.04+0.09*vel,0.40]];
  for(const [h,a,tf] of body){
    const f=h*f0; if(f>sr*0.45) continue;
    const dec=Math.exp(-1/(tau*tf*sr)), dph=f/sr;
    let ph=Math.random(), env=amp*a;
    for(let i=0;i<L-off;i++){
      let e=env; if(i<atk) e*=i/atk;
      out[off+i]+=e*sinT(ph);
      ph+=dph; if(ph>=1) ph-=1;
      env*=dec; if(env<1e-5) break;
    }
  }
  const ft=6*f0;
  if(ft<sr*0.45){
    const dec=Math.exp(-1/(0.16*sr)), dph=ft/sr;
    let ph=0, env=amp*(0.10+0.30*vel);
    for(let i=0;i<L-off;i++){
      let e=env; if(i<atk) e*=i/atk;
      out[off+i]+=e*sinT(ph);
      ph+=dph; if(ph>=1) ph-=1;
      env*=dec; if(env<1e-6) break;
    }
  }
}

function renderChord(rows,voice,useDyn,arpMs){
  const sr=S.sr, arp=arpMs/1000;
  const dur=3.0+arp*Math.max(0,rows.length-1);
  const L=Math.ceil(sr*dur), out=new Float32Array(L);
  rows.forEach((r,ri)=>{
    const off=Math.floor(arp*ri*sr);
    const db=useDyn?Math.max(r.db,-30):-6;
    const amp=Math.pow(10,db/20);
    const vel=useDyn?clamp((r.db+42)/42,0.12,1):0.7;
    const f0=midiFreq(r.midi,S.a4);
    (voice==='rhodes'?rhodesVoice:pianoVoice)(out,off,L,sr,f0,r.midi,amp,vel);
  });
  let mx=0; for(let i=0;i<L;i++){ const a=Math.abs(out[i]); if(a>mx) mx=a; }
  const g=mx>0?0.82/mx:1, fo=Math.floor(sr*0.09);
  const trem=voice==='rhodes', dpt=5.2/sr;
  let tp=0;
  for(let i=0;i<L;i++){
    let v=out[i]*g;
    if(trem){ v*=1+0.11*sinT(tp); tp+=dpt; if(tp>=1) tp-=1; }
    if(i>L-fo) v*=(L-i)/fo;
    out[i]=v;
  }
  return out;
}

/* original selection, then a gap, then the synthesised chord — looped */
function buildAB(synth){
  const sr=S.sr;
  const a=Math.max(0,Math.floor(S.selA*sr));
  const b=Math.min(S.mono.length,Math.min(Math.floor(S.selB*sr),a+Math.floor(3.2*sr)));
  const oL=Math.max(1,b-a);
  let mo=0; for(let i=a;i<b;i++){ const v=Math.abs(S.mono[i]); if(v>mo) mo=v; }
  const go=mo>0?0.82/mo:1;
  const gap=Math.floor(sr*0.3), fd=Math.floor(sr*0.02);
  const out=new Float32Array(oL+gap+synth.length+gap);
  for(let i=0;i<oL;i++){
    let w=1;
    if(i<fd) w=i/fd; else if(i>oL-fd) w=(oL-i)/fd;
    out[i]=S.mono[a+i]*go*w;
  }
  out.set(synth,oL+gap);
  return out;
}

let synthSrc=null, synthKind=null, synthCache={};
function stopSynth(){
  if(synthSrc){ try{synthSrc.stop();}catch(e){} synthSrc.disconnect(); synthSrc=null; }
  synthKind=null; updSynthUI();
}
function updSynthUI(){
  const b=$('#synthPlay');
  b.textContent=synthKind?'■ Stop':'▶ Play chord';
  b.classList.toggle('pri',!synthKind);
  $('#synthArp').classList.toggle('on',synthKind==='arp');
  $('#abBtn').classList.toggle('on',synthKind==='ab');
}
async function playSynth(kind){
  const was=synthKind;
  stopPlay(); stopSynth();
  if(was===kind) return;
  const rows=(S.rows||[]).filter(r=>noteOn.has(r.i));
  if(!rows.length){ setStatus('Tick at least one note to play it back.',false,true); return; }
  const key=[S.voice,S.useDyn,kind,rows.map(r=>r.midi).join('.')].join('|');
  let buf=synthCache[key];
  if(!buf){
    setStatus('Rendering '+(S.voice==='rhodes'?'Rhodes':'piano')+' …',true);
    await yield_();
    let pcm=renderChord(rows,S.voice,S.useDyn,kind==='arp'?110:0);
    if(kind==='ab') pcm=buildAB(pcm);
    buf=ac().createBuffer(1,pcm.length,S.sr);
    buf.copyToChannel(pcm,0);
    synthCache[key]=buf;
  }
  const c=ac(), s=c.createBufferSource();
  s.buffer=buf; s.loop=true;
  s.connect(c.destination); s.start();
  synthSrc=s; synthKind=kind; updSynthUI();
  const names=rows.map(r=>r.name).join(' ');
  $('#synthInfo').textContent=names;
  setStatus(kind==='ab'
    ? 'Looping: recording → silence → resynthesis. Same voicing?'
    : 'Playing '+names+(S.useDyn?' at measured levels.':' at equal level.'));
}
/* synthKind and synthCache are module-local because they are reassigned;
   an ES module cannot assign to an imported binding, so the two places
   outside this file that need to touch them go through these. */
function clearSynthCache(){ synthCache={}; }
function restartSynth(){ if(synthKind){ const k=synthKind; synthKind=null; playSynth(k); } }
$('#synthPlay').onclick=()=>playSynth('chord');
$('#synthArp').onclick=()=>playSynth('arp');
$('#abBtn').onclick=()=>playSynth('ab');
$('#dynBtn').onclick=e=>{
  S.useDyn=!S.useDyn; e.target.classList.toggle('on',S.useDyn);
  e.target.textContent=S.useDyn?'Measured dynamics':'Equal level';
  if(synthKind){ const k=synthKind; synthKind=null; playSynth(k); }
};
document.querySelectorAll('.voice').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('.voice').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); S.voice=b.dataset.voice;
    if(synthKind){ const k=synthKind; synthKind=null; playSynth(k); }
  };
});

export {startPlay,buildIso,clearSynthCache,restartSynth};
