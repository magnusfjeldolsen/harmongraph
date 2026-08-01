/* ============================================================
   INFO POPOVERS — the small "i" marks.

   One popover element, reused. It is position:fixed and clamped to the
   viewport on every open, so it can never open off-screen or with its
   close button out of reach — which on a phone is the difference between
   an explanation and a trap. Closes on the ×, on Escape, on a second tap
   of the same mark, and on any click outside it.
   ============================================================ */
import {$} from '../state.js';

/* Written for someone who has just met the control, not for someone who
   already knows what it does. Each one says what it is, and when to reach
   for it. */
const TOPICS={
  record:{t:'Record from mic',b:`
    <p>Records straight from your microphone with the phone's own processing
    switched off — no auto-gain, no noise suppression. Those features pump the
    dynamics and eat sustained tones, which is exactly what this tool measures.</p>
    <p>Because auto-gain is off, phone mics record quietly. The take is turned
    back up automatically, and the status line tells you what your input peaked
    at. If it says below about −40 dBFS, move closer or play louder.</p>
    <p><b>On iPhone:</b> if you hear nothing, check the ring/silent switch.</p>`},

  fence:{t:'Fencing a segment',b:`
    <p>Drag on the waveform to choose the piece of audio to analyse. Two
    fingers pinch to zoom in first.</p>
    <p><b>Fence one chord that is sustained.</b> Short and clean beats long and
    busy — if the chord changes inside your selection, the analysis averages
    the two together and you get mush.</p>
    <p>Aim for at least a second, more if there is a low bass note, since low
    notes need more time to be measured accurately.</p>`},

  threshold:{t:'Note threshold',b:`
    <p>How much evidence a note needs before it is reported.</p>
    <p><b>Lower it</b> when you know a note is there and it is not being
    listed. <b>Raise it</b> when you are getting notes you did not play.</p>
    <p>This one is instant — it re-picks from the analysis already done, so
    you can slide it and watch the list change without re-analysing.</p>`},

  timbre:{t:'Timbre — pure ↔ bright',b:`
    <p>How much high-overtone content the instrument has.</p>
    <p>Move toward <b>pure</b> for flute, voice or whistling. Toward
    <b>bright</b> for distorted guitar, organ or anything buzzy.</p>
    <p>Getting this roughly right matters: the analysis works by matching your
    sound against a model of what a note looks like, and if the model is the
    wrong shape it invents notes to explain the difference.</p>`},

  fund:{t:'Fundamental — weak ↔ strong',b:`
    <p><b>Use this when a note is reported an octave too high.</b></p>
    <p>On most instruments the lowest tone of a note is not actually its
    loudest part — guitars, small speakers and phone mics all under-produce it.
    If the analysis assumes the lowest tone is always the loudest, the easiest
    way for it to explain what it hears is to move the note up an octave, to
    where the loud part sits.</p>
    <p>Sliding left tells it not to assume that. Measured on real guitar,
    lowering it to 0.8 raised the proportion of single notes read as exactly
    one note from 29% to 38%.</p>
    <p><b>The trade:</b> too far left and quiet real notes start being missed,
    and the <i>Real&nbsp;%</i> column loses some of its meaning. Try 0.8 first.</p>`},

  hpss:{t:'Strip percussion',b:`
    <p>Separates the pitched part of the sound from the drum and transient
    part, and analyses only the pitched part.</p>
    <p><b>Leave it on for anything with drums or strumming noise.</b> It is the
    single most useful preparation step — on a chord with transients over it,
    it is the difference between a readable chord and nonsense.</p>
    <p>Turn it off only for clean solo instrument recordings, where it has
    little to do and costs a moment.</p>`},

  a4:{t:'Concert pitch (A₄)',b:`
    <p>What frequency counts as the A above middle C. Almost everything modern
    is 440&nbsp;Hz.</p>
    <p><b>Use Detect</b> if the recording sounds between the notes — old
    records, tape, wind bands and anything sped up or slowed down drift far
    enough to shift every note across a boundary and make the whole reading
    wrong.</p>
    <p>Changing it retunes the entire analysis, not just the labels.</p>`},

  picks:{t:'All detected / My picks',b:`
    <p><b>All detected</b> plays everything the analysis found.
    <b>My picks</b> plays only the notes you have ticked.</p>
    <p>Switching between them never changes your ticks, so you can flip back
    and forth to compare the algorithm's answer with your own as often as you
    like — untick a note you doubt, switch to All detected to hear it again,
    switch back. Nothing is lost either way.</p>
    <p>Unticking a note while in All detected switches you to My picks
    automatically, since otherwise the tick would change and the sound would
    not.</p>`},

  tapnote:{t:'Tapping a note name',b:`
    <p>Tap any note name to hear that note on its own, so you can go through
    the chord one note at a time and decide what you actually hear.</p>
    <p>Every note is played at a clear, even volume rather than at its measured
    level — a quiet note would otherwise be inaudible on its own. Its real
    level is in the bar next to it, and in the status line.</p>
    <p>This is a synthesiser playing what the analysis <i>thinks</i> is there.
    To hear what is <i>really</i> there, use <b>Ticked notes only</b> below,
    which is cut from your own recording.</p>`},

  real:{t:'The Real % column',b:`
    <p>How confident the analysis is that a note was actually played, rather
    than being an overtone of a lower note that it mistook for one.</p>
    <p>Notes stacked in octaves and fifths — which is most guitar chords — will
    show lower numbers, because in those chords the evidence genuinely is
    ambiguous. A low score means "this is hard to be sure about", not
    "this is wrong".</p>
    <p><b>Do not trust it over your own ears.</b> Untick what sounds wrong and
    listen back.</p>`},

  layers:{t:'Listen to a layer',b:`
    <p>Rebuilds part of <i>your own recording</i> and plays just that.</p>
    <p><b>Ticked notes only</b> is the honest test of whether a note is really
    there: it keeps only the frequencies belonging to the notes you ticked, cut
    from your actual audio. If a note is truly present you will hear it; if the
    analysis invented it, you will hear a gap.</p>
    <p><b>Pitched only</b> and <b>Percussive only</b> split the recording into
    its tuned and untuned halves — useful for checking what the percussion
    stripping is actually removing.</p>`},

  playback:{t:'Hearing the chord back',b:`
    <p>Plays the detected notes on a piano or Rhodes, at the levels measured
    from your recording.</p>
    <p><b>A/B</b> is the one that settles arguments: it loops your recording,
    then a gap, then the synthesised version. If they match, the reading is
    right. Your ear catches a wrong note there far faster than your eye catches
    it in a table.</p>
    <p><b>Roll it up</b> spreads the notes out one at a time, which is the
    easiest way to hear a voicing from the bottom up.</p>`},
};

let pop=null, openFor=null;

function build(){
  pop=document.createElement('div');
  pop.className='pop';
  pop.setAttribute('role','dialog');
  pop.innerHTML='<div class="pop-hd"><span class="pop-t"></span>'+
    '<button class="pop-x" type="button" aria-label="Close">✕</button></div>'+
    '<div class="pop-b"></div>';
  document.body.appendChild(pop);
  pop.querySelector('.pop-x').onclick=e=>{ e.stopPropagation(); close(); };
  pop.addEventListener('pointerdown',e=>e.stopPropagation());
}

/* Clamp to the viewport rather than trusting the trigger's position: the
   marks sit in panels that can be anywhere on a long scrolling page, and a
   popover whose close button lands off-screen is worse than no popover. */
function place(btn){
  const m=8, vw=window.innerWidth, vh=window.innerHeight;
  pop.style.maxWidth=Math.min(340,vw-2*m)+'px';
  pop.style.maxHeight=(vh-2*m)+'px';
  pop.style.left='0px'; pop.style.top='0px';
  const pr=pop.getBoundingClientRect(), br=btn.getBoundingClientRect();
  let left=Math.max(m,Math.min(br.left, vw-m-pr.width));
  let top=br.bottom+6;
  if(top+pr.height>vh-m){
    const above=br.top-6-pr.height;
    top = above>=m ? above : Math.max(m, vh-m-pr.height);
  }
  pop.style.left=left+'px'; pop.style.top=top+'px';
}

function close(){
  if(!pop||!openFor) return;
  pop.classList.remove('show');
  openFor.setAttribute('aria-expanded','false');
  openFor=null;
}
function open(btn){
  const k=btn.dataset.info, T=TOPICS[k];
  if(!T) return;
  if(!pop) build();
  if(openFor===btn){ close(); return; }        // second tap of the same mark
  pop.querySelector('.pop-t').textContent=T.t;
  pop.querySelector('.pop-b').innerHTML=T.b;
  pop.classList.add('show');
  openFor=btn;
  btn.setAttribute('aria-expanded','true');
  place(btn);
  pop.querySelector('.pop-x').focus({preventScroll:true});
}

document.querySelectorAll('.info').forEach(b=>{
  b.type='button';
  b.setAttribute('aria-expanded','false');
  b.setAttribute('aria-label','What is this?');
  b.addEventListener('pointerdown',e=>e.stopPropagation());
  b.onclick=e=>{ e.preventDefault(); e.stopPropagation(); open(b); };
});
document.addEventListener('pointerdown',()=>close());
document.addEventListener('keydown',e=>{ if(e.key==='Escape') close(); });
window.addEventListener('resize',()=>{ if(openFor) place(openFor); });
/* Follow the mark while the page scrolls, and give up if it scrolls away —
   a popover pinned to a control that is no longer visible is just clutter. */
window.addEventListener('scroll',()=>{
  if(!openFor) return;
  const r=openFor.getBoundingClientRect();
  if(r.bottom<0||r.top>window.innerHeight) close(); else place(openFor);
},{passive:true});

export {TOPICS};
