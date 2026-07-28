/* ---------------- results ----------------
   Turns the raw fit in S.ana into what the Result panel shows:
   the surviving notes, the chord name, the key map, the spectrum
   overlay and the voicing table. Re-runs on its own whenever the
   note threshold moves — no refit needed. */
import {$,S,clamp,noteOn} from '../state.js';
import {midiName,midiFreq} from '../pitch.js';
import {NOTE_LO,NN_COUNT} from '../dsp/nnls.js';
import {idChord,chordLabel} from '../chords.js';
import {fitCanvas,dynColor} from './canvas.js';
import {drawKeys} from './keyboard.js';
import {drawSpec} from './spectrum.js';
import {buildIso,startPlay,clearSynthCache,restartSynth} from '../audio.js';

function selectedNotes(){
  const A=S.ana; if(!A) return [];
  // 1. activation threshold  2. must have energy at its own fundamental
  const pass=new Float64Array(NN_COUNT);
  for(let i=0;i<NN_COUNT;i++)
    if(A.detN[i]>=S.thr && (!A.evid || A.evid[i]>=S.GATE)) pass[i]=A.detN[i];
  // 3. non-maximum suppression: adjacent semitones in the bass are usually
  //    FFT smearing, not a real minor 2nd — keep one unless they are comparable
  const out=[];
  for(let i=0;i<NN_COUNT;i++){
    if(!pass[i]) continue;
    let beaten=false;
    for(const d of [-1,1]){ const j=i+d;
      if(j>=0&&j<NN_COUNT&&pass[j]>pass[i]*S.NMS) beaten=true; }
    if(!beaten) out.push(i);
  }
  out.sort((a,b)=>A.detN[b]-A.detN[a]);
  const keep=out.slice(0,12);
  keep.sort((a,b)=>a-b);
  return keep;
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
  if(noteOn.size===0) rows.forEach(r=>{ if(r.pf>0.5) noteOn.add(r.i); });
  S.rows=rows; clearSynthCache();

  // ---- chord ----
  const pcv=new Array(12).fill(0);
  rows.forEach(r=>{
    const wgt=Math.pow(10,r.db/40)*(0.25+0.75*r.pf);   // amplitude^0.5, weighted by confidence
    pcv[r.midi%12]+=wgt;
  });
  const real=rows.filter(r=>r.pf>0.4);
  const bass = real.length? real[0].midi%12 : (rows.length?rows[0].midi%12:null);
  const cands = rows.length? idChord(pcv,bass) : [];
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

  drawKeys(rows);
  drawSpec(rows);

  // ---- table ----
  const tb=$('#noteTbl tbody'); tb.innerHTML='';
  rows.forEach(r=>{
    const tr=document.createElement('tr');
    const lvl=clamp((r.db+48)/48,0,1);
    tr.innerHTML=
      '<td class="n" style="color:'+dynColor(r.db,1)+'">'+r.name+
        (r.pf<0.45?' <span class="pill">ovt</span>':'')+'</td>'+
      '<td style="color:var(--dim)">'+r.f.toFixed(1)+'</td>'+
      '<td><div class="bar"><i style="width:'+(lvl*100).toFixed(0)+'%;background:'+dynColor(r.db,1)+'"></i></div>'+
        '<span style="font-size:10px;color:var(--dimmer)">'+r.db.toFixed(0)+' dB</span></td>'+
      '<td><div class="bar"><i style="width:'+(r.pf*100).toFixed(0)+'%;background:var(--vi)"></i></div>'+
        '<span style="font-size:10px;color:var(--dimmer)">'+(r.pf*100).toFixed(0)+'%</span></td>'+
      '<td></td>';
    const cb=document.createElement('input');
    cb.type='checkbox'; cb.checked=noteOn.has(r.i);
    cb.onchange=()=>{ cb.checked?noteOn.add(r.i):noteOn.delete(r.i);
      delete S.isoBufs.notes; clearSynthCache();
      restartSynth();
      if(S.iso==='notes'){ buildIso('notes').then(()=>{ if(S.playing) startPlay(); }); } };
    tr.lastElementChild.appendChild(cb);
    tb.appendChild(tr);
  });
  if(!rows.length) tb.innerHTML='<tr><td colspan="5" style="color:var(--dim)">Nothing above threshold. Lower it, or fence a louder / more sustained part.</td></tr>';
}

export {renderResult};
