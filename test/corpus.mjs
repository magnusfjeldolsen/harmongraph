/* ============================================================
   Synthetic evaluation corpus — 22 voicings × 6 timbres.

   Every chord is a Float32Array of 2.5 s at 44.1 kHz plus a
   ground-truth MIDI note list. Fully deterministic: one seeded
   PRNG, no Math.random(), so two runs on two machines produce the
   same bytes and the same harness numbers.

   The six timbres exist to probe the one assumption buildDict()
   makes — that a note's partial h has amplitude s^(h-1) at exactly
   h·f0. Each timbre breaks that assumption in a different way, and
   the point of the corpus is to see what the breakage costs:

     geometric   obeys it exactly              — the control
     bright      slow rolloff, loud highs      — more partials to misattribute
     dark        fast rolloff, ~5 partials     — little evidence above f0
     hollow      odd partials only (clarinet)  — no 2nd partial, strong 3rd
     formant     f0 is not the loudest partial — the fit prefers an octave up
     inharmonic  f_h = h·f0·sqrt(1+B·h²)       — no exact octave coincidence

   Node-only ESM, zero dependencies.
   ============================================================ */

export const SR = 44100;
export const DUR = 2.5;

/* ---------------- deterministic PRNG (mulberry32) ---------------- */
function rng(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- voicings ----------------
   22 of them, chosen to span the difficulty range rather than to
   flatter the model: close and open triads, sevenths and extensions,
   octave doublings (the known-hard case), semitone clusters, wide
   spreads, bass near the resolution floor, and the guitar
   fourths-and-octaves voicings RESEARCH.md §10 says are the real
   reported failure. */
export const VOICINGS = [
  { id:'triad-close-Cmaj',    notes:[60,64,67],                 note:'close major triad, mid register — the easy case' },
  { id:'triad-open-Cmaj',     notes:[48,55,64,72],              note:'open triad with an octave on top' },
  { id:'min7-A-close',        notes:[57,60,64,67],              note:'close minor 7th' },
  { id:'dim7-Fs',             notes:[54,57,60,63],              note:'fully symmetric, no root cue' },
  { id:'dom7-G-low',          notes:[43,47,50,53],              note:'dominant 7th low and close' },
  { id:'maj7-C-open',         notes:[48,55,59,64],              note:'open major 7th' },
  { id:'min7-D-close',        notes:[50,53,57,60],              note:'close minor 7th, lower' },
  { id:'dom9-F',              notes:[41,45,48,51,55],           note:'dominant 9th, five voices' },
  { id:'dom13-Bb',            notes:[46,50,56,60,65,68],        note:'dense extension, six voices' },
  { id:'min11-E-wide',        notes:[40,47,50,55,59,64],        note:'quartal-ish minor 11, wide' },
  { id:'oct-quad-C',          notes:[36,48,60,72],              note:'four octaves of one pitch class — hardest known case' },
  { id:'oct-triple-E',        notes:[40,52,59,64],              note:'octave doubling plus a fifth' },
  { id:'cluster-semitone',    notes:[60,61,62],                 note:'three adjacent semitones — NMS stress test' },
  { id:'cluster-C-Cs-G',      notes:[60,61,67],                 note:'the C4/C#4/G4 cluster from RESEARCH.md §4' },
  { id:'maj9-wide-spread',    notes:[36,55,64,71,74,79],        note:'six voices spread over four octaves' },
  { id:'low-bass-E1',         notes:[28,35,40,47],              note:'bass at the resolution floor' },
  { id:'low-bass-C1',         notes:[24,31,36,43],              note:'below the resolution floor' },
  { id:'guitar-open-E',       notes:[40,47,52,56,59,64],        note:'open E — E2 B2 E3 G#3 B3 E4, maximally nested' },
  { id:'guitar-open-A',       notes:[45,52,57,61,64],           note:'open A' },
  { id:'guitar-open-G',       notes:[43,47,50,55,59,67],        note:'open G' },
  { id:'guitar-barre-F',      notes:[41,48,53,57,60,65],        note:'barre F — root doubled two octaves up' },
  { id:'quartal-stack',       notes:[45,50,55,60,65,70],        note:'five stacked fourths' }
];

/* ---------------- timbres ----------------
   Each returns [{h, amp}] — partial index and linear amplitude —
   plus an inharmonicity coefficient B (0 for the harmonic ones). */
export const TIMBRES = ['geometric','bright','dark','hollow','formant','inharmonic'];

function partials(timbre, midi){
  const out=[];
  if(timbre==='geometric'){
    // exactly what buildDict assumes: a_h = s^(h-1), s = 0.72
    for(let h=1;h<=16;h++) out.push({h, amp:Math.pow(0.72,h-1)});
    return {out, B:0};
  }
  if(timbre==='bright'){
    // slow rolloff — partial 12 is still at -25 dB
    for(let h=1;h<=20;h++) out.push({h, amp:Math.pow(0.93,h-1)});
    return {out, B:0};
  }
  if(timbre==='dark'){
    // fast rolloff, five partials and nothing above
    for(let h=1;h<=5;h++) out.push({h, amp:Math.pow(0.45,h-1)});
    return {out, B:0};
  }
  if(timbre==='hollow'){
    // clarinet-like: odd partials carry it, evens are ~26 dB down.
    // No 2nd partial + a strong 3rd is exactly the configuration that
    // lets the fit explain the 3rd as the fundamental of a note a
    // twelfth up.
    for(let h=1;h<=15;h++){
      const base=Math.pow(0.75,(h-1)/2);
      out.push({h, amp: (h%2===1) ? base : 0.05*base});
    }
    return {out, B:0};
  }
  if(timbre==='formant'){
    // a fixed resonance around 900 Hz, and the fundamental pushed
    // down hard, so f0 is never the loudest partial. This is the
    // configuration that makes an octave-up reading cheaper.
    const f0 = 440*Math.pow(2,(midi-69)/12);
    for(let h=1;h<=18;h++){
      const f=f0*h;
      const g=Math.exp(-Math.pow(Math.log2(f/900),2)/(2*0.65*0.65));
      let a=Math.pow(0.88,h-1)*(0.12+g);
      if(h===1) a*=0.5;
      out.push({h, amp:a});
    }
    // guarantee the property the timbre is named for, for notes whose
    // f0 already sits inside the resonance
    const mx=out.reduce((m,p)=>Math.max(m,p.amp),0);
    if(out[0].amp>=mx*0.999) out[0].amp=mx*0.35;
    return {out, B:0};
  }
  if(timbre==='inharmonic'){
    // piano stiffness, scaled with register as in handoff Task 5
    const B = 5e-5*Math.pow(2,(midi-21)/24);
    for(let h=1;h<=16;h++) out.push({h, amp:Math.pow(0.78,h-1)});
    return {out, B};
  }
  throw new Error('unknown timbre '+timbre);
}

/* ---------------- one player's notes, summed into `buf` ----------------
   Pulled out of synth() unchanged so a mixture can render two players
   into the same buffer with independent PRNG streams and a relative
   gain. With gain=1 the arithmetic is bit-identical to the original
   (1*lvl === lvl), so the 132-chord baseline does not move. */
function renderNotes(buf, notes, timbre, rand, gain=1){
  const N=buf.length, nyq=SR/2;
  notes.forEach((midi,ni)=>{
    const f0=440*Math.pow(2,(midi-69)/12);
    const {out:ps, B}=partials(timbre,midi);
    // mild per-note level spread so the chord is not a flat stack
    const lvl=0.62+0.38*rand();
    // mild per-note decay: 2.2–4.5 s time constant, high partials
    // a little shorter, as on a real string
    const tau=2.2+2.3*rand();
    // a few ms of onset stagger, well under one analysis hop
    const t0=0.004*ni*rand();

    ps.forEach(({h,amp})=>{
      const f = B>0 ? h*f0*Math.sqrt(1+B*h*h) : h*f0;
      if(f>=nyq*0.97) return;
      const ph=2*Math.PI*rand();
      const th=tau/(1+0.10*(h-1));
      const a=gain*lvl*amp;
      const w=2*Math.PI*f/SR;
      for(let i=0;i<N;i++){
        const t=i/SR-t0;
        if(t<0) continue;
        // 6 ms raised-cosine attack, then exponential decay
        const at = t<0.006 ? 0.5-0.5*Math.cos(Math.PI*t/0.006) : 1;
        buf[i]+=a*at*Math.exp(-t/th)*Math.sin(w*i+ph);
      }
    });
  });
}

/* noise + peak normalise, shared by the solo and mixture paths */
function finish(buf, rand){
  const N=buf.length;
  // a little broadband noise so this is not a pure sinusoid stack
  let pk=0; for(let i=0;i<N;i++) if(Math.abs(buf[i])>pk) pk=Math.abs(buf[i]);
  const nz=pk*0.0035;
  for(let i=0;i<N;i++) buf[i]+=nz*(rand()*2-1);

  pk=0; for(let i=0;i<N;i++) if(Math.abs(buf[i])>pk) pk=Math.abs(buf[i]);
  const g=pk>0?0.9/pk:1;
  for(let i=0;i<N;i++) buf[i]*=g;
  return buf;
}

/* ---------------- one chord ---------------- */
function synth(notes, timbre, seed, dur=DUR){
  const N=Math.round(SR*dur);
  const buf=new Float32Array(N);
  const rand=rng(seed);
  renderNotes(buf,notes,timbre,rand,1);
  return finish(buf,rand);
}

/* ---------------- the corpus ----------------
   Lazily synthesised: 132 × 2.5 s of Float32 is ~58 MB if held at
   once, so the harness pulls one chord at a time. */
export function* corpus(){
  for(let ti=0; ti<TIMBRES.length; ti++){
    const timbre=TIMBRES[ti];
    for(let vi=0; vi<VOICINGS.length; vi++){
      const v=VOICINGS[vi];
      const seed = 0x9E37 + ti*1000 + vi;
      yield {
        id: timbre+'/'+v.id,
        timbre, voicing:v.id, note:v.note,
        truth: v.notes.slice(),
        get signal(){ return synth(v.notes,timbre,seed); }
      };
    }
  }
}

/* ============================================================
   TWO-INSTRUMENT MIXTURES  (added for the voice-clustering study)

   Each segment is two players rendered with independent PRNG
   streams and summed, so the same "player A" part is bit-identical
   whether it appears alone or inside a mixture. That makes the solo
   control and the mixture directly comparable: any difference in
   the clustering is caused by the second instrument, not by a
   different rendering of the first.

   The axes are chosen to be the things that should break the
   method, not the things that should flatter it:

     pair        how far apart the two timbres are
     arrangement how the two pitch sets sit against each other —
                 separate registers, interleaved, octave-related
                 (maximal partial collision without unison), and
                 outright shared pitches
     level       instrument B at 0, −6 or −12 dB

   Solo segments carry `k:1` and exist for one number only: how
   often a one-instrument segment is reported as more than one
   voice.
   ============================================================ */

export const PAIRS = [
  {id:'dark+bright',         A:'dark',      B:'bright',     dist:'far'},
  {id:'geometric+inharmonic',A:'geometric', B:'inharmonic', dist:'close'},
  {id:'hollow+formant',      A:'hollow',    B:'formant',    dist:'mid'},
  {id:'bright+formant',      A:'bright',    B:'formant',    dist:'mid'},
  // The control that matters: two players of the *same* instrument.
  // There is no timbral evidence to find, so whatever the method scores
  // here it read out of something that is not timbre — register,
  // partial-collision pattern, position in the chord. Any accuracy on a
  // real pair only counts insofar as it exceeds this. One per timbre,
  // because the artefact could be timbre-specific.
  ...TIMBRES.map(t=>({id:`${t}+${t}`, A:t, B:t, dist:'identical'}))
];

export const ARRANGEMENTS = [
  {id:'sep-register',   A:[36,43,48],    B:[64,67,71],    kind:'separate'},
  {id:'sep-wide',       A:[28,35,40],    B:[72,76,79],    kind:'separate'},
  {id:'melody-chord',   A:[43,50,55,59], B:[76,79],       kind:'separate'},
  {id:'interleave',     A:[48,60,67],    B:[55,64,72],    kind:'interleave'},
  {id:'interleave-tight',A:[60,64,67],   B:[62,65,69],    kind:'interleave'},
  // every B note is exactly an octave above an A note: every partial of
  // B lands on an even partial of A. Collision without unison.
  {id:'octave-apart',   A:[48,52,55],    B:[60,64,67],    kind:'interleave'},
  {id:'share-1',        A:[48,55,60],    B:[60,64,67],    kind:'shared'},
  {id:'share-2',        A:[52,55,59,64], B:[55,59,62,67], kind:'shared'}
];

export const LEVELS_DB = [0,-6,-12];

/* dense solo chords, on top of the arrangement A-parts, so the
   false-split rate is not measured only on 3-note voicings */
export const SOLO_VOICINGS = ['triad-close-Cmaj','dom13-Bb','oct-quad-C',
                              'guitar-open-E','cluster-C-Cs-G','maj9-wide-spread'];

const rmsOf=b=>{ let s=0; for(let i=0;i<b.length;i++) s+=b[i]*b[i]; return Math.sqrt(s/b.length); };

/* Each player is rendered into its own buffer and normalised to unit
   RMS *before* the level offset is applied, so `0 dB` means the two
   instruments are equally loud. Without that step the level axis
   would be measuring the timbres' very different intrinsic energies
   (`bright` has 20 partials, `dark` has 5) rather than anything the
   experiment set. The two PRNG streams are independent, so player A's
   samples do not depend on player B existing. */
function synthMix(notesA,timbreA,notesB,timbreB,seed,gainB,dur=DUR){
  const N=Math.round(SR*dur);
  const bufA=new Float32Array(N), bufB=new Float32Array(N);
  renderNotes(bufA,notesA,timbreA,rng(seed),1);
  renderNotes(bufB,notesB,timbreB,rng(seed^0x5F3759DF),1);
  const ra=rmsOf(bufA)||1, rb=rmsOf(bufB)||1;
  const out=new Float32Array(N);
  for(let i=0;i<N;i++) out[i]=bufA[i]/ra + gainB*bufB[i]/rb;
  return finish(out,rng(seed+7919));
}

/* the mixture segments: PAIRS × ARRANGEMENTS × LEVELS_DB.
   The identical-timbre control runs at 0 dB only. */
export function* mixtures(dur=DUR){
  for(let pi=0; pi<PAIRS.length; pi++){
    const p=PAIRS[pi];
    const levels = LEVELS_DB;
    for(let ai=0; ai<ARRANGEMENTS.length; ai++){
      const a=ARRANGEMENTS[ai];
      for(const db of levels){
        const seed = 0x1B7D + pi*10000 + ai*100 + (db+12);
        const gainB = Math.pow(10,db/20);
        const shared = a.A.filter(m=>a.B.includes(m));
        yield {
          id: `${p.id}/${a.id}/${db}dB`,
          kind:'mix', k:2,
          pair:p.id, dist:p.dist, arrangement:a.id, arrKind:a.kind, db,
          timbreA:p.A, timbreB:p.B,
          truthA:a.A.slice(), truthB:a.B.slice(), shared,
          get signal(){ return synthMix(a.A,p.A,a.B,p.B,seed,gainB,dur); }
        };
      }
    }
  }
}

/* the solo controls: every timbre over every arrangement A-part, plus
   six of the dense VOICINGS. Truth is one voice. */
export function* solos(dur=DUR){
  for(let ti=0; ti<TIMBRES.length; ti++){
    const t=TIMBRES[ti];
    for(let ai=0; ai<ARRANGEMENTS.length; ai++){
      const a=ARRANGEMENTS[ai];
      const seed = 0x2C4F + ti*1000 + ai;
      yield { id:`solo/${t}/${a.id}`, kind:'solo', k:1,
              pair:'—', dist:'solo', arrangement:a.id, arrKind:'solo', db:0,
              timbreA:t, timbreB:null,
              truthA:a.A.slice(), truthB:[], shared:[],
              get signal(){ return synth(a.A,t,seed,dur); } };
    }
    for(let vi=0; vi<SOLO_VOICINGS.length; vi++){
      const v=VOICINGS.find(x=>x.id===SOLO_VOICINGS[vi]);
      const seed = 0x3D6A + ti*1000 + vi;
      yield { id:`solo/${t}/${v.id}`, kind:'solo', k:1,
              pair:'—', dist:'solo', arrangement:v.id, arrKind:'solo', db:0,
              timbreA:t, timbreB:null,
              truthA:v.notes.slice(), truthB:[], shared:[],
              get signal(){ return synth(v.notes,t,seed,dur); } };
    }
  }
}

/* everything, solos first so a short run still sees the headline number */
export function* voiceCorpus(dur=DUR){
  yield* solos(dur);
  yield* mixtures(dur);
}

/* one note list, one timbre, no mixture — exported so the isolated-note
   diagnostic can render a single note through the same synthesiser the
   corpus uses, rather than a second copy of the partial tables */
export {synth as synthNote};

export function voiceCorpusStats(){
  let mix=0,solo=0;
  for(const s of mixtures()) mix++;
  for(const s of solos()) solo++;
  return {mix, solo, total:mix+solo,
          pairs:PAIRS.length, arrangements:ARRANGEMENTS.length, levels:LEVELS_DB.length};
}

export function corpusStats(){
  const chords=TIMBRES.length*VOICINGS.length;
  const perTimbre=VOICINGS.reduce((s,v)=>s+v.notes.length,0);
  return {chords, notes:perTimbre*TIMBRES.length, notesPerTimbre:perTimbre,
          voicings:VOICINGS.length, timbres:TIMBRES.length};
}

if(process.argv[1] && process.argv[1].endsWith('corpus.mjs')){
  const s=corpusStats();
  console.log(`${s.voicings} voicings × ${s.timbres} timbres = ${s.chords} chords, ${s.notes} notes`);
  console.log(`${s.notesPerTimbre} notes per timbre, ${DUR}s each at ${SR} Hz`);
  for(const v of VOICINGS) console.log(`  ${v.id.padEnd(20)} ${String(v.notes.length).padStart(2)}  [${v.notes.join(' ')}]`);
  const m=voiceCorpusStats();
  console.log(`\nvoice corpus: ${m.mix} mixtures + ${m.solo} solos = ${m.total} segments`);
  console.log(`  ${m.pairs} pairs × ${m.arrangements} arrangements × ${m.levels} levels`);
}
