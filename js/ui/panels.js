/* ---------------- results ----------------
   Turns the raw fit in S.ana into what the Result panel shows:
   the surviving notes, the chord name, the key map, the spectrum
   overlay and the voicing table. Re-runs on its own whenever the
   note threshold moves — no refit needed. */
import {$,S,clamp,noteOn,noteVote,noteShift,sel} from '../state.js';
import {midiName,midiFreq} from '../pitch.js';
import {NOTE_LO} from '../dsp/nnls.js';
import {selectNotes} from '../analyzeSegment.js';
import {idChord,chordLabel} from '../chords.js';
import {fitCanvas,dynColor} from './canvas.js';
import {drawKeys} from './keyboard.js';
import {drawSpec} from './spectrum.js';
import {buildIso,startPlay,previewNote,setPickMode} from '../audio.js';

/* the same selection analyzeSegment() applies, re-run live so the
   threshold slider needs no refit */
function selectedNotes(){
  const A=S.ana; if(!A) return [];
  return selectNotes(A.detN,A.evid,S.thr,S.GATE,S.NMS,12);
}
function renderResult(){
  const A=S.ana; if(!A) return;
  $('#resPanel').style.display='';
  fitCanvas();

  const notes=selectedNotes();
  let amx=0; notes.forEach(i=>{ if(A.xamp[i]>amx) amx=A.xamp[i]; });
  const rows=notes.map(i=>{
    const db = amx>0 && A.xamp[i]>0 ? 20*Math.log10(A.xamp[i]/amx) : -60;
    return {i, midi:NOTE_LO+i, name:midiName(NOTE_LO+i),
            f:midiFreq(NOTE_LO+i,S.a4), db:Math.max(-60,db),
            pf:A.pfund[i], det:A.detN[i]};
  });
  // Every detected note starts on. The old seed was `pf > 0.5`, which handed
  // the default to a number handoff.md §2 measures as weak (gap 0.12) and
  // inverted on one of six timbres — so it silently dropped real notes.
  // noteOn is rebuilt from scratch here rather than seeded once, so a user's
  // decision survives the threshold slider recomputing the candidate list.
  noteOn.clear();
  rows.forEach(r=>{ if(noteVote.get(r.i)!==false) noteOn.add(r.i); });
  S.rows=rows;

  // What the panel shows: the detected rows with any moves applied. rows
  // itself stays the algorithm's answer, so Detected is always one tap away
  // and Reset is a delete rather than a re-analysis. In Detected mode the
  // moves are ignored, which is what makes the switch a real A/B.
  const view=rows.map(r=>{
    const s=S.playAll?0:(noteShift.get(r.i)||0);
    if(!s) return {...r,dmidi:r.midi,moved:0};
    const m=clamp(r.midi+s,21,108);
    return {...r,midi:m,dmidi:r.midi,moved:s,name:midiName(m),f:midiFreq(m,S.a4)};
  });
  view.sort((a,b)=>a.midi-b.midi);

  // ---- chord ----
  const pcv=new Array(12).fill(0);
  view.forEach(r=>{
    const wgt=Math.pow(10,r.db/40)*(0.25+0.75*r.pf);   // amplitude^0.5, weighted by confidence
    pcv[r.midi%12]+=wgt;
  });
  const real=view.filter(r=>r.pf>0.4);
  const bass = real.length? real[0].midi%12 : (view.length?view[0].midi%12:null);
  const cands = view.length? idChord(pcv,bass) : [];
  if(cands.length){
    const L=chordLabel(cands[0],bass);
    $('#chordName').innerHTML = L.root + (L.q?'<span class="sup">'+L.q+'</span>':'') +
      (L.slash?'<span class="slash">'+L.slash+'</span>':'');
    $('#chordAlt').innerHTML = cands.slice(1,4).map(c=>{
      const l=chordLabel(c,bass);
      return '<span>'+l.root+l.q+l.slash+'  '+(c.sc*100).toFixed(0)+'</span>';
    }).join('');
  }else{
    $('#chordName').textContent='—';
    $('#chordAlt').innerHTML='<span>no clear pitch content</span>';
  }

  drawKeys(view);
  drawSpec(view);

  // ---- table ----
  const tb=$('#noteTbl tbody'); tb.innerHTML='';
  view.forEach(r=>{
    const tr=document.createElement('tr');
    if(r.i===sel.i) tr.className='selrow';
    const lvl=clamp((r.db+48)/48,0,1);
    // A moved note shows where it came from, and its Real % is struck out —
    // that number was measured for the detected pitch and says nothing about
    // the one you chose. Better to void it than to let it look like evidence.
    const nameHtml = r.moved
      ? '<span class="was">'+midiName(r.dmidi)+'</span> '+r.name
      : r.name;
    tr.innerHTML=
      '<td class="n tap" role="button" tabindex="0" title="Select and hear this note"'+
        ' style="color:'+dynColor(r.db,1)+'">'+nameHtml+
        (!r.moved&&r.pf<0.45?' <span class="pill">ovt</span>':'')+'</td>'+
      '<td style="color:var(--dim)">'+r.f.toFixed(1)+'</td>'+
      '<td><div class="bar"><i style="width:'+(lvl*100).toFixed(0)+'%;background:'+dynColor(r.db,1)+'"></i></div>'+
        '<span style="font-size:10px;color:var(--dimmer)">'+r.db.toFixed(0)+' dB</span></td>'+
      (r.moved
        ? '<td style="color:var(--dimmer)"><span style="font-size:10px">moved '+
            (r.moved>0?'+':'')+r.moved+'</span></td>'
        : '<td><div class="bar"><i style="width:'+(r.pf*100).toFixed(0)+'%;background:var(--vi)"></i></div>'+
          '<span style="font-size:10px;color:var(--dimmer)">'+(r.pf*100).toFixed(0)+'%</span></td>')+
      '<td></td>';
    const cb=document.createElement('input');
    cb.type='checkbox'; cb.checked=noteOn.has(r.i);
    // no re-render and no restart: the scheduler re-reads noteOn at the top
    // of the next cycle, so the edit lands on the next pass without a stutter
    cb.onchange=()=>{ noteVote.set(r.i,cb.checked);
      cb.checked?noteOn.add(r.i):noteOn.delete(r.i);
      delete S.isoBufs.notes;
      // Touching a tick means you want your picks to count. Without this the
      // box would visibly change while playback carried on unaltered, because
      // All-detected mode ignores the ticks.
      if(S.playAll){ setPickMode(false); return; }
      if(S.iso==='notes'){ buildIso('notes').then(()=>{ if(S.playing) startPlay(); }); } };
    tr.lastElementChild.appendChild(cb);
    // Tap the name to hear that note alone. Deliberately not the whole row —
    // the row's other end is the include/exclude checkbox, and a tap target
    // that both auditions and toggles depending on where it landed would be
    // the worst of both.
    const nameCell=tr.firstElementChild;
    // One tap does both jobs: you hear the note, and it becomes the note the
    // key-map drag will move. That pairing is what makes dragging workable —
    // at ~4px per key nothing can be grabbed directly, but nothing needs to be
    // once you have already said which note you mean.
    const pick=e=>{ e.preventDefault(); sel.i=r.i; previewNote(r); refreshSel(); };
    nameCell.onclick=pick;
    nameCell.onkeydown=e=>{ if(e.key==='Enter'||e.key===' ') pick(e); };
    tb.appendChild(tr);
  });
  if(!view.length) tb.innerHTML='<tr><td colspan="5" style="color:var(--dim)">Nothing above threshold. Lower it, or fence a louder / more sustained part.</td></tr>';

  // ---- selection bar ----
  const cur=view.find(r=>r.i===sel.i);
  $('#selBar').style.display=cur?'':'none';
  if(cur){
    $('#selName').innerHTML=cur.moved
      ? '<span class="was">'+midiName(cur.dmidi)+'</span> → <b>'+cur.name+'</b>'
      : '<b>'+cur.name+'</b>';
    $('#selUndo').style.visibility=cur.moved?'':'hidden';
  }
  const edits=noteShift.size+[...noteVote.values()].filter(v=>v===false).length;
  $('#resetAll').style.display=edits?'':'none';
  $('#resetAll').textContent='↺ Reset all ('+edits+')';
  $('#pickMine').textContent=noteShift.size?'Your version':'My picks';
}
/* One render path. renderResult() re-picks from the analysis already done —
   no refit — so calling it after an edit is cheap and keeps the table, the
   key map, the chord name and the selection bar from ever disagreeing. */
function refreshSel(){ renderResult(); }

export {renderResult,refreshSel};
