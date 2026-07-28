/* Note naming and equal-temperament frequency, relative to a settable A4. */

const NN = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function midiName(m){ return NN[((m%12)+12)%12] + (Math.floor(m/12)-1); }
function midiFreq(m,a4){ return a4*Math.pow(2,(m-69)/12); }

export {NN,midiName,midiFreq};
