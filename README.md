# Harmonograph

A browser tool for working out what chord is being played, how it is voiced, and how loud each note in the voicing is.

**Live:** https://magnusfjeldolsen.github.io/harmongraph/

Load an audio file or record from the mic, fence a segment on the waveform, and analyze. Everything runs on your device — no upload, no server, no build step. One HTML file, no dependencies.

---

## What it does

- **Waveform with real fencing.** One finger drags a selection, two fingers pinch to zoom. Works properly on a phone.
- **Chord identification** across 26 qualities, with slash-chord bass detection and ranked alternatives.
- **Voicing on an 88-key map**, coloured green → red by measured level.
- **Overtone confidence** per note — a separate dimension telling you how likely each detected note is real rather than a partial of a lower one.
- **Concert pitch control.** Set A₄ by hand or detect it from the audio. The whole analysis retunes.
- **Percussion stripping** (HPSS) so drums don't pollute the chord reading.
- **Note soloing.** Tick notes to hear only their harmonic series, resynthesised from the original recording.
- **Chord playback** in a piano or Rhodes voice, at the measured dynamics, with an A/B loop against the recording.

## How it tells a note from an overtone

A raw FFT can't. One low C on a piano puts strong energy on C, C, G, C, E, G, B♭ — a naive peak-picker reports a dominant 7th nobody played.

Harmonograph builds a dictionary of 88 idealised note profiles, each containing that key's full harmonic series with geometrically decaying partial amplitudes, then solves a non-negative least squares fit: which combination of keys, at what strengths, best reconstructs the spectrum actually present? Energy at 3f gets charged to the key at f. This is the NNLS approximate-transcription method of Mauch & Dixon (ISMIR 2010), the front end of Chordino, plus two additions needed to recover voicings rather than chroma — a fundamental-evidence gate and semitone non-maximum suppression.

Measured on 14 synthetic chords (61 notes, realistic partial structure and decay):

| | |
|---|---|
| Note recall | 90% |
| Precision | 96% |
| Chord names correct | 14/14 |
| Runtime | ~280 ms per 2.5 s segment |
| P(real): true notes vs ghosts | 72% vs 31% |

`RESEARCH.md` has the full method, the failure modes I hit, and the upgrade path.

## Known limits

- Octave duplicates get merged — if E1, E2 and E3 all sound, expect two of them. A single-frame spectral fit genuinely cannot separate these.
- Bass below roughly E2 sits at the FFT resolution floor. The 32768 window helps but wants ≥1.5 s of steady audio.
- Enharmonic spelling is always sharps; correct spelling needs key context.
- Averaging across a segment where the chord changes gives mush. Fence tightly.

## Tips

- Fence one sustained chord. Short and clean beats long and busy.
- Leave percussion stripping on for anything with drums.
- Nudge the **Timbre** slider toward *pure* for flute or voice, toward *bright* for distorted guitar or organ.
- Use **A/B** to sanity-check: if the resynthesis matches the recording, the reading is right.

## Licence

MIT.

## References

- Mauch & Dixon, *Approximate Note Transcription for the Improved Identification of Difficult Chords*, ISMIR 2010
- Fitzgerald, *Harmonic/Percussive Separation Using Median Filtering*, DAFx 2010
- Beck & Teboulle, *A Fast Iterative Shrinkage-Thresholding Algorithm*, SIAM J. Imaging Sci. 2009
