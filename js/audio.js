/* ============================================================
   AUDIO — everything that touches the AudioContext: loading and
   decoding, the waveform transport, mic capture, the isolation
   layers, and the resynthesis voices.
   Owns the controls of the Source, Waveform-transport, Listen and
   Hear-the-chord-back panels.
   ============================================================ */
import {$,S,clamp,ac,acReady,audioSession,isIOS,setStatus,yield_,noteOn,noteVote} from './state.js';
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
/* New audio means a clean slate. Everything derived from the previous take
   has to go, not just the waveform — leaving any of it behind produces
   symptoms that look unrelated to loading a file:
     - a still-running transport keeps sounding the OLD recording, and its
       rAF loop keeps drawing a stale playhead over the new waveform, which
       is why the display appeared to take a moment to settle
     - S.rows survives, so "Play chord" would play the previous analysis
       even though the result panel is hidden
     - S.iso survives, so an isolation button stays lit while playback has
       silently fallen back to the full mix, because isoBufs was cleared */
function setBuffer(b,label){
  stopPlay(); stopSynth();
  S.buf=b; S.sr=b.sampleRate; S.dur=b.duration;
  const n=b.length, m=new Float32Array(n);
  for(let c=0;c<b.numberOfChannels;c++){ const d=b.getChannelData(c); for(let i=0;i<n;i++) m[i]+=d[i]; }
  const g=1/b.numberOfChannels; for(let i=0;i<n;i++) m[i]*=g;
  S.mono=m;
  buildPeaks();
  S.viewA=0; S.viewB=S.dur;                       // full view
  S.selA=0; S.selB=Math.min(S.dur,2.5);           // default fence
  S.isoBufs={}; S.ana=null; S._fine=null; S.rows=null;
  noteOn.clear(); noteVote.clear();
  S.iso='full';
  document.querySelectorAll('.iso').forEach(x=>x.classList.toggle('on',x.dataset.iso==='full'));
  $('#srcInfo').textContent=label+' · '+S.dur.toFixed(1)+'s · '+S.sr+' Hz';
  $('#wavePanel').style.display='';
  $('#setPanel').style.display='';
  $('#resPanel').style.display='none';
  fitCanvas(); drawWave();
  // The waveform panel may have gone from display:none to visible on this
  // very call. fitCanvas() forces layout so the first draw is usually right,
  // but a second pass on the next frame costs nothing and covers the case
  // where the panel's box is still settling.
  requestAnimationFrame(()=>{ fitCanvas(); drawWave(); });
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
async function startPlay(){
  if(!S.buf) return;
  stopPlay(); stopSynth();          // one transport at a time: the synth loop yields to the recording
  const c=await acReady();
  if(S.playing) return;             // superseded while the context was resuming
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
async function stopRec(){
  const R=S.rec; if(!R) return; S.rec=null;
  clearInterval(R.timer); R.node.onaudioprocess=null;
  try{ R.src.disconnect(); R.node.disconnect(); R.mute.disconnect(); }catch(e){}
  R.stream.getTracks().forEach(t=>t.stop());
  $('#recBtn').classList.remove('armed'); $('#recBtn').textContent='● Record from mic';
  if(!R.n){ setStatus('Nothing was captured — the mic delivered no audio.',false,true); return; }

  const rate=R.ctx.sampleRate;
  const pcm=new Float32Array(R.n);
  let o=0; for(const ch of R.chunks){ pcm.set(ch,o); o+=ch.length; }

  // Bring the take up to a normal listening level. We ask for the mic with
  // autoGainControl off, because AGC pumps dynamics and the whole point of
  // this tool is measuring them — but that leaves the raw stream very quiet
  // on phones, and playing it back at unity made a loud performance sound
  // almost silent. Peak normalisation is safe here: the analysis is scale
  // invariant (whitening standardises, and the note levels it reports are
  // relative to the loudest note), so this changes what you hear and not
  // what is measured.
  let pk=0; for(let i=0;i<R.n;i++){ const a=Math.abs(pcm[i]); if(a>pk) pk=a; }
  let g=1;
  if(pk>0&&pk<0.89){ g=0.89/pk; for(let i=0;i<R.n;i++) pcm[i]*=g; }

  // Hand the audio session back before anything is played. On iOS the mic
  // left it in play-and-record, which routes output to the earpiece receiver
  // at low volume and stays that way after the tracks stop.
  audioSession('playback');
  if(isIOS && !navigator.audioSession && S.ac){
    // Safari before 16.4 has no way to ask, and the routing survives the
    // stopped tracks — closing the context and building the take in a fresh
    // one is the only lever left. Restricted to iOS because nothing else has
    // the problem, and tearing the context down costs every cached note
    // buffer, which belongs to the context that is going away.
    try{ await S.ac.close(); }catch(e){}
    S.ac=null; noteCache.clear();
  }
  const c=ac();
  const b=c.createBuffer(1,R.n,rate);
  b.copyToChannel(pcm,0);
  setBuffer(b,'mic recording');

  const dbfs=pk>0?20*Math.log10(pk):-120;
  setStatus('Recorded '+(R.n/rate).toFixed(1)+'s · input peaked at '+dbfs.toFixed(0)+' dBFS'
    +(g>1.02?', raised '+(20*Math.log10(g)).toFixed(0)+' dB for playback':'')+'.'
    +(dbfs<-40?' That is very quiet — check the mic input level.':'')
    +' If you hear nothing on iPhone, check the ring/silent switch.');
}
$('#recBtn').onclick=async()=>{
  if(S.rec){ await stopRec(); return; }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    setStatus(micError({name:'unsupported'}),false,true); return;
  }
  let stream=null;
  try{
    stopPlay(); stopSynth();                        // never capture our own output
    audioSession('play-and-record');
    // getUserMedia goes FIRST, before anything is awaited. Safari grants a
    // transient user activation on the tap and awaiting spends it, after
    // which the mic request is no longer gesture-initiated and never
    // prompts. Note also that acReady() must not be used here: it asks for
    // the playback session, which would undo the line above.
    stream=await navigator.mediaDevices.getUserMedia({audio:{
      echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1
    }});
    const c=ac();
    if(c.state!=='running'){ try{ await c.resume(); }catch(e){} }
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
    // only notes in the current analysis — noteOn is keyed by pitch and can
    // still hold picks from an earlier chord
    const list=(S.rows||[]).filter(r=>noteOn.has(r.i)).map(r=>r.i);
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
  // Every layer is a masked subset of the original spectrum and so carries a
  // fraction of its energy — the harmonic comb especially, which keeps only
  // ±50 cents around each partial. Played through at unity these were far
  // quieter than the recording, which reads as the layer being broken rather
  // than as it being a subset. Match the recording's level instead, capping
  // the makeup gain so a nearly empty layer amplifies its own numerical noise
  // rather than exploding.
  // Copy first: for 'harm' and 'perc', out is a reference into S.ana, and
  // scaling in place would quietly corrupt the stored analysis.
  const pcm=Float32Array.from(out);
  let mx=0; for(let i=0;i<pcm.length;i++){ const a=Math.abs(pcm[i]); if(a>mx) mx=a; }
  let g=1;
  if(mx>0){ g=Math.min(0.89/mx,32); for(let i=0;i<pcm.length;i++) pcm[i]*=g; }
  const b=c.createBuffer(1,pcm.length,S.sr);
  b.copyToChannel(pcm,0);
  S.isoBufs[kind]=b;
  setStatus('Layer ready — press play.'+(g>1.5?' Raised '+(20*Math.log10(g)).toFixed(0)+' dB to match the recording.':''));
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

/* ---------------- per-note render cache ----------------
   One note per buffer, rendered at unit amplitude, cached by voice, pitch
   and a velocity bucket. Velocity is bucketed because it changes timbre
   (partial count and rolloff) and so has to be baked in; level does not,
   and is applied by a gain node at schedule time.

   The point of rendering per note rather than per chord: toggling a note
   then costs nothing. The next cycle reads noteOn and schedules a
   different set — no re-render, no restart of the loop. */
const VEL_BUCKETS=8, CACHE_MAX=24;
const noteCache=new Map();
const velBucket=v=>clamp(Math.round(v*(VEL_BUCKETS-1)),0,VEL_BUCKETS-1);

function renderNote(midi,vel,voice){
  const b=velBucket(vel);
  const key=voice+'|'+midi+'|'+b+'|'+S.sr+'|'+S.a4.toFixed(2);
  const hit=noteCache.get(key);
  if(hit) return hit;
  const sr=S.sr, L=Math.ceil(sr*3.0), out=new Float32Array(L);
  (voice==='rhodes'?rhodesVoice:pianoVoice)(out,0,L,sr,midiFreq(midi,S.a4),midi,1,b/(VEL_BUCKETS-1));
  const fo=Math.floor(sr*0.09);
  let peak=0;
  for(let i=0;i<L;i++){
    if(i>L-fo) out[i]*=(L-i)/fo;
    const a=Math.abs(out[i]); if(a>peak) peak=a;
  }
  const buf=ac().createBuffer(1,L,sr);
  buf.copyToChannel(out,0);
  const e={buf,peak:peak||1};
  if(noteCache.size>=CACHE_MAX) noteCache.delete(noteCache.keys().next().value);
  noteCache.set(key,e);
  return e;
}
function activeRows(){ return (S.rows||[]).filter(r=>noteOn.has(r.i)); }
const noteAmp=r=>Math.pow(10,(S.useDyn?Math.max(r.db,-30):-6)/20);
const noteVel=r=>S.useDyn?clamp((r.db+42)/42,0.12,1):0.7;

/* ---------------- lookahead scheduler ----------------
   Replaces one looping AudioBufferSource. Costs sample-exact loop points
   and buys live editing: the set is re-read at the top of every cycle, so
   an edit lands on the next pass instead of restarting playback. */
const LOOKAHEAD=0.25, TICK_MS=100, GAP=0.3, NOTE_LEN=3.0, ARP=0.110;
let sched=null, synthKind=null, synthSeq=0;

function buildChain(){
  const c=ac();
  const recOut=c.createGain(); recOut.gain.value=1; recOut.connect(c.destination);
  const noteOut=c.createGain(); noteOut.gain.value=1; noteOut.connect(c.destination);
  let lfo=null;
  if(S.voice==='rhodes'){                    // tremolo belongs on the bus, not baked per note
    lfo=c.createOscillator(); lfo.frequency.value=5.2;
    const d=c.createGain(); d.gain.value=0.11;
    lfo.connect(d).connect(noteOut.gain);
    lfo.start();
  }
  return {recOut,noteOut,lfo};
}
function recNorm(){
  const a=Math.max(0,Math.floor(S.selA*S.sr));
  const b=Math.min(S.mono.length,Math.min(Math.floor(S.selB*S.sr),a+Math.floor(3.2*S.sr)));
  let mo=0; for(let i=a;i<b;i++){ const v=Math.abs(S.mono[i]); if(v>mo) mo=v; }
  return {gain:mo>0?0.82/mo:1, off:a/S.sr, len:Math.max(0.05,(b-a)/S.sr)};
}
function scheduleCycle(t0){
  const c=ac(), rows=activeRows();
  if(!rows.length) return NOTE_LEN;
  let tN=t0, lead=0;
  if(synthKind==='ab'){
    const R=recNorm();
    const s=c.createBufferSource(); s.buffer=S.buf;
    const g=c.createGain();
    g.gain.setValueAtTime(0,t0);
    g.gain.linearRampToValueAtTime(R.gain,t0+0.02);
    g.gain.setValueAtTime(R.gain,t0+R.len-0.02);
    g.gain.linearRampToValueAtTime(0,t0+R.len);
    s.connect(g).connect(sched.recOut);
    s.start(t0,R.off,R.len);
    track(s);
    lead=R.len+GAP; tN=t0+lead;
  }
  // energy-summed normalisation: peak-of-sum for independent phases is much
  // closer to sqrt(sum of squares) than to the sum, and this can never be
  // louder than the old per-mix peak normalisation for a single note
  const items=rows.map(r=>({e:renderNote(r.midi,noteVel(r),S.voice), amp:noteAmp(r)}));
  let en=0; items.forEach(it=>{ const p=it.e.peak*it.amp; en+=p*p; });
  const norm=0.78/Math.max(1e-6,Math.sqrt(en));
  const arp=synthKind==='arp'?ARP:0;
  items.forEach((it,k)=>{
    const s=c.createBufferSource(); s.buffer=it.e.buf;
    const g=c.createGain(); g.gain.value=it.amp*norm;
    s.connect(g).connect(sched.noteOut);
    s.start(tN+arp*k);
    track(s);
  });
  return lead+NOTE_LEN+arp*(rows.length-1)+(synthKind==='ab'?GAP:0);
}
function pump(){
  if(!sched) return;
  const c=ac();
  let guard=0;
  while(sched.nextAt<c.currentTime+LOOKAHEAD && guard++<8){
    const len=scheduleCycle(sched.nextAt);
    sched.nextAt+=Math.max(0.25,len);
  }
}
/* keep the stop-list from growing without bound over a long loop */
function track(s){
  sched.nodes.push(s);
  s.onended=()=>{ if(!sched) return; const i=sched.nodes.indexOf(s); if(i>=0) sched.nodes.splice(i,1); };
}
function stopSynth(){
  synthSeq++;                    // supersede any start still rendering
  if(sched){
    clearInterval(sched.timer);
    sched.nodes.forEach(n=>{ try{n.stop();}catch(e){} try{n.disconnect();}catch(e){} });
    if(sched.lfo){ try{sched.lfo.stop();}catch(e){} }
    try{ sched.recOut.disconnect(); sched.noteOut.disconnect(); }catch(e){}
    sched=null;
  }
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
  const rows=activeRows();
  if(!rows.length){ setStatus('Tick at least one note to play it back.',false,true); return; }
  // Claim the transport before the FIRST await — resuming the context and
  // rendering up to 12 notes both take real time, and if synthKind stayed
  // null across that the UI would read "not playing" while a start was in
  // flight: press again and the toggle logic mistakes the in-flight start
  // for a stop, leaving synthKind set and the button dead. seq lets a later
  // press supersede this one instead. Every await below this line needs its
  // seq guard, which is why the guard sits immediately after each one.
  const seq=++synthSeq;
  synthKind=kind; updSynthUI();
  const c=await acReady();
  if(seq!==synthSeq) return;
  const cold=rows.filter(r=>!noteCache.has(S.voice+'|'+r.midi+'|'+velBucket(noteVel(r))+'|'+S.sr+'|'+S.a4.toFixed(2)));
  if(cold.length){
    setStatus('Rendering '+(S.voice==='rhodes'?'Rhodes':'piano')+' …',true);
    await yield_();
    for(const r of cold){
      if(seq!==synthSeq) return;                 // superseded mid-render
      renderNote(r.midi,noteVel(r),S.voice);
      await yield_();
    }
  }
  if(seq!==synthSeq) return;
  sched={...buildChain(), nodes:[], nextAt:c.currentTime+0.06, timer:null};
  pump();
  sched.timer=setInterval(pump,TICK_MS);
  updSynthUI();
  const names=rows.map(r=>r.name).join(' ');
  $('#synthInfo').textContent=names;
  setStatus(kind==='ab'
    ? 'Looping: recording → silence → resynthesis. Same voicing?'
    : 'Playing '+names+(S.useDyn?' at measured levels.':' at equal level.'));
}
/* Tap a note name to hear that note on its own — the point is inspecting the
   chord one participant at a time, so this stops whatever else is sounding
   rather than layering over it.

   It is the same cached buffer the loop uses, at the same velocity, so the
   timbre cannot disagree with what the chord plays. The level deliberately
   does not match: a note measured at -30 dB would be inaudible soloed, and
   you can already read its level off the bar. The status line states the
   measured figure instead, so nothing is hidden. */
let previewSrc=null, previewSeq=0;
async function previewNote(row){
  stopPlay(); stopSynth();
  if(previewSrc){ try{ previewSrc.stop(); }catch(e){} previewSrc=null; }
  const seq=++previewSeq;
  const c=await acReady();
  if(seq!==previewSeq) return;
  const e=renderNote(row.midi,noteVel(row),S.voice);
  if(seq!==previewSeq) return;
  const s=c.createBufferSource(); s.buffer=e.buf;
  const g=c.createGain(); g.gain.value=0.85/e.peak;
  s.connect(g).connect(c.destination);
  s.start();
  previewSrc=s;
  s.onended=()=>{ if(previewSrc===s) previewSrc=null; };
  setStatus(row.name+' · '+row.f.toFixed(1)+' Hz · '+row.db.toFixed(0)
    +' dB in the chord · '+(row.pf*100).toFixed(0)+'% real');
}
/* Toggling a note no longer needs to touch playback at all — the next cycle
   reads noteOn. Only a change that invalidates the rendered notes or the
   bus does, which is the voice and the dynamics mode. */
function restartSynth(){ if(synthKind){ const k=synthKind; synthKind=null; playSynth(k); } }
$('#synthPlay').onclick=()=>playSynth('chord');
$('#synthArp').onclick=()=>playSynth('arp');
$('#abBtn').onclick=()=>playSynth('ab');
$('#dynBtn').onclick=e=>{
  S.useDyn=!S.useDyn; e.target.classList.toggle('on',S.useDyn);
  e.target.textContent=S.useDyn?'Measured dynamics':'Equal level';
  restartSynth();
};
document.querySelectorAll('.voice').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('.voice').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); S.voice=b.dataset.voice;
    restartSynth();
  };
});

export {startPlay,buildIso,renderNote,activeRows,noteVel,previewNote};
