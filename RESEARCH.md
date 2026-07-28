# Browser-based chord, voicing and dynamics analyzer — research & architecture

Findings behind the `harmonograph.html` prototype, plus the upgrade path if you take it further.

---

## 1. The FFmpeg assumption — mostly wrong, and worth dropping

FFmpeg is the right tool for a *server*. For this app it is close to pure cost.

- `ffmpeg.wasm` ships a ~24 MB wasm binary (~8.5 MB gzipped) for the full build. Custom builds get to 5–8 MB. On a phone that is a several-second stall before the user has done anything.
- You do not need it. `AudioContext.decodeAudioData()` already decodes **WAV, MP3, AAC/M4A, FLAC, Ogg/Opus and WebM** natively, hardware-accelerated, and hands you exactly what you want: raw `Float32Array` PCM, already resampled to the context rate.
- "Streaming the audio correctly" is also a non-problem. Once decoded you hold an `AudioBuffer` and play arbitrary regions with `AudioBufferSourceNode` + `loopStart` / `loopEnd`. Sample-accurate looping, no seeking, no streaming layer.
- If you later need format work the browser can't do, the modern answer is **WebCodecs**, or **MediaBunny** (MPL-2.0) which wraps WebCodecs — 10–50× faster than ffmpeg.wasm because it uses the platform's hardware codecs. Remotion has already deprecated its own parser in favour of it.

**Only** reach for ffmpeg.wasm if you must ingest an exotic container the browser refuses. Even then, do it server-side.

### The one real decode caveat
`decodeAudioData` decodes the *whole* file into RAM. Ten minutes of stereo 44.1 kHz float ≈ 212 MB. For long files, chunk the decode or downmix to mono immediately (the prototype downmixes on load).

---

## 2. Audio input

**Files** — `<input type="file">` + drag-drop → `arrayBuffer()` → `decodeAudioData`. Done.

**Recording** — `getUserMedia` + `MediaRecorder`. Three traps, all of which the prototype handles:

1. **Kill the voice processing.** Browsers default to echo cancellation, noise suppression and auto gain control. All three destroy musical recordings — AGC pumps your dynamics, NS eats sustained tones. Request:
   ```js
   getUserMedia({audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}})
   ```
2. **Codecs are not interoperable.** Chrome/Firefox write `audio/webm;codecs=opus`; Safari writes `audio/mp4` (AAC). Feature-detect with `MediaRecorder.isTypeSupported()` rather than hardcoding. Since you decode locally with `decodeAudioData`, either is fine.
3. **iOS requires a user gesture** to create or resume an `AudioContext`, and requires **https**. Create the context inside the button handler, never at page load.

Known iOS annoyance with no clean fix: granting mic access can force output from headphones to the built-in speaker. Worth a UI warning if people will monitor while recording.

---

## 3. Waveform display and segment fencing

**wavesurfer.js v7** is the default choice and has the plugins you'd want (Regions, Timeline, Minimap, Zoom, Spectrogram). But its maintainers' own discussions document that **regions + zoom + touch is genuinely broken on mobile** — dragging a region ambiguously moves it, resizes it, or scrolls the waveform, because region drag and container scroll compete for the same gesture.

Since precise fencing on a phone is the core interaction here, the prototype **renders the waveform itself on `<canvas>`** with explicit Pointer Events:

- min/max peak pyramid precomputed at 256 samples/bucket → redraw is O(canvas width), not O(samples)
- below ~3 samples/pixel it switches to drawing actual samples
- **one finger** = create or drag a selection edge (18 px hit zones)
- **two fingers** = pinch-zoom and pan, anchored on the pinch midpoint
- `touch-action:none` on the canvas so the browser never steals the gesture
- wheel zooms at cursor, shift-wheel pans

That's ~150 lines and removes an entire class of mobile bug. Use wavesurfer if you want annotations, minimaps and waveform export for free; write your own if the gesture model is the product.

---

## 4. The central problem: overtones vs. real notes

Your instinct that the frequency domain alone won't distinguish them is **correct, and it's the whole difficulty.**

A single low C on a piano puts strong energy at C, C, G, C, E, G, B♭, C… A naive FFT peak-picker reads a dominant 7th chord that nobody played. Worse, in a real chord the partials of the bass note land exactly on the notes above it, so the evidence is genuinely ambiguous.

The published approaches, in ascending order of quality:

| Method | Idea | Verdict |
|---|---|---|
| Raw FFT peaks | Pick spectral maxima | Useless polyphonically |
| Harmonic Product Spectrum | Downsample spectrum ×2,×3,×4 and multiply | Cheap; monophonic-biased; fails on chords |
| Constant-Q / chromagram | Log-frequency bins aligned to semitones | Necessary front end, not sufficient |
| **NNLS approximate transcription** | Fit a dictionary of 88 idealised harmonic note profiles by non-negative least squares | **Best classical method; what the prototype uses** |
| Harmonic-constrained NMF | Same, learned/iterative | Marginal gain, much slower |
| Neural (Basic Pitch, Onsets & Frames) | Learned multipitch | Best accuracy; heaviest |

### What the prototype implements

Following **Mauch & Dixon, ISMIR 2010** (*Approximate Note Transcription for the Improved Identification of Difficult Chords*) — the front end of Chordino / NNLS-Chroma, and still the strongest non-neural method:

1. **STFT**, 16384-point Hann, 75% overlap, averaged over the selection.
2. **Log-frequency mapping** to 3 bins per semitone across A0–C10, with a raised-cosine gathering kernel per bin. Bin centres are derived from *your* A₄, so retuning the app retunes the analysis.
3. **Spectral whitening** — running mean/std standardisation over a ±1 octave window. Flattens instrument spectral envelope and recording EQ.
4. **NNLS fit.** Build a dictionary column per piano key containing that key's whole harmonic series with geometrically decaying partial amplitudes ($a_h = s^{h-1}$), L2-normalised. Solve
   $$\min_x \lVert Dx - y\rVert^2 + \lambda\lVert x\rVert_1 \quad \text{s.t.}\ x \ge 0$$
   with **FISTA + non-negative projection** (accelerated proximal gradient), 320 iterations on the 88×88 Gram matrix. Energy at 3f gets charged to the key at f instead of being reported as its own note.
5. **Second NNLS pass on the un-whitened spectrum**, restricted to detected notes, to recover physical amplitudes for the dynamics colour map.

### Two failure modes I had to fix, and how

Straight NNLS out of the paper produced garbage voicings, because Mauch & Dixon collapse to a 12-bin chroma where octave errors are harmless. You want the actual voicing, so they aren't.

**(a) Phantom notes an octave below the real ones.** With the paper's flat harmonic decay ($s = 0.9$), a template's own fundamental carries only ~44% of its norm, so the C1 column looks almost identical to the C2 column shifted — the fit happily explains a whole chord with one non-existent low note. Measured: a single C2 produced a ghost C1; a C major triad produced *six* ghosts.

Fixes, both validated by sweep:
- **Steeper harmonic decay, $s = 0.72$.** Now the fundamental dominates its own template, so a phantom note is expensive. Exposed as the *Timbre* slider (0.60 for flute-like, 0.86 for buzzy/distorted).
- **Fundamental-evidence gate.** After the fit, reject any note lacking real observed energy at its own f₀ (≥8% of spectral max). A note that is actually sounding must show up at its fundamental.

**(b) Semitone smearing in the bass.** At 16384/44.1 kHz the bin width is 2.69 Hz, but a semitone at C2 is only ~3.9 Hz. Adjacent semitones bleed and both get activated. Fixed with **non-maximum suppression**: suppress a note if a neighbour a semitone away is >1.5× stronger. Deliberately mild, so real minor 2nds survive — verified on a C4/C♯4/G4 cluster.

### Measured accuracy after the fixes

14 synthetic chords, 61 notes, realistic 16-partial piano-like spectra with inharmonicity and decay:

```
recall     90%  (55/61 notes found)
precision  96%  (2 ghosts)
chord name 14/14 correct
runtime    278 ms for 2.5 s of audio, including HPSS
```

Mean **P(real)** — the confidence dimension you asked for — separates cleanly: **72% for true notes, 31% for ghosts.**

### How P(real) is computed
For each detected note, at its fundamental bin: how much of the fitted energy is its own contribution versus other detected notes' partials landing there.
$$P_\text{real}(i) = \frac{x_i D_i[f_i]}{x_i D_i[f_i] + \sum_{j\ne i} x_j D_j[f_i]}$$
Low score = you're probably looking at a ghost. Shown as the violet bar and the `ovt` tag.

### Known limits (inherent, not bugs)
- **Octave duplicates get merged.** If E1, E2 and E3 all sound, the fit often reports two of them. Unavoidable with a single-frame spectral fit — the evidence really is ambiguous.
- **Bass below ~E2** is at the resolution floor. The 32768 window helps but needs ≥1.5 s of steady audio.
- **Enharmonic spelling** is key-dependent (A♯ vs B♭). The prototype always picks sharps; correct spelling needs key context.
- Averaging over a segment where the chord *changes* gives mush. Fence tightly.

---

## 5. Isolating instruments — the honest ladder

You asked about clustering to solo instruments out. Here is what's actually achievable, cheapest first.

### Tier 1 — Harmonic/percussive separation (in the prototype)
**Fitzgerald 2010**, median filtering. Harmonic content is horizontal in a spectrogram (steady across time); percussive content is vertical (broadband, instantaneous). Median-filter the magnitude STFT along time → harmonic estimate; along frequency → percussive estimate; form a soft Wiener-style mask; ISTFT.

~30 lines, runs in ~150 ms, and it is *the* highest-value preprocessing step for chord ID. Measured: on a chord contaminated with transients, detection went from `A0 A♯0 C1 C♯1 D1 D♯1 C3 G3 E4 D6 G6` (garbage) to exactly `C3 G3 E4 G4`.

### Tier 2 — Harmonic comb masking (in the prototype)
Given the detected notes, build an STFT mask keeping only bins within ±50 cents of the harmonic series of the notes you tick, then resynthesise by ISTFT. This is what the *Ticked notes only* button does, and it genuinely solos one voice out of a chord so you can verify by ear. It bleeds where partials collide (that's physics), but for checking "is that really an E4 or an overtone of C2?" it works well.

### Tier 3 — NMF component clustering
Decompose the spectrogram $V \approx WH$ into ~10–20 components, cluster columns of $W$ by timbral features (spectral centroid, flatness, MFCC), assign clusters to "instruments". This is the "clustering" approach you had in mind. Unsupervised, so cluster→instrument assignment is unreliable and needs the user to audition and label. Feasible in JS but a big build for modest payoff.

### Tier 4 — Neural demixing (Demucs)
This is what actually works, and it now runs client-side:

- **`free-music-demixer`** — Demucs v4 HT transliterated to C++/Eigen, compiled to wasm. Weights are 81 MB (`htdemucs`) or 53 MB (`htdemucs_6s`) as float16; compression only reaches ~70 MB, so it isn't worth it.
- **`demucs-onnx` / `demucs-web`** — ONNX Runtime Web with WASM or WebGPU backends, ~172 MB embedded model. Needs COOP/COEP headers for `SharedArrayBuffer`.
- **`demucs-rs`** — Rust → wasm + WebGPU.

**`htdemucs_6s` is the one you want**: it separates **guitar and piano** as their own stems, not just vocals/drums/bass/other.

The cost is real and you should size it honestly: a 4-minute song takes **3–5 minutes on a modern laptop**, bounded by the single WASM thread and RAM. On a phone this is not viable as an interactive feature. Reported quality on `htdemucs`: SDR ~7.3 vocals, ~10.6 drums, ~10.6 bass, ~6.3 other.

**Recommendation:** Tier 1 + 2 client-side always. If you want Tier 4, run it server-side on stem-separation-worthy material, cache the stems, and let the phone analyze the returned stems.

---

## 6. Hearing the chord back — resynthesis

The strongest verification loop isn't visual, it's aural: play the detected notes back at the measured levels and see whether it matches the recording. Two voices, both rendered additively straight into a `Float32Array` with table-lookup oscillators and multiplicative envelopes (no `Math.sin` per sample, no Web Audio node graph — a 5-note chord renders in 90–240 ms).

**Grand piano** — inharmonic partial series $f_h = h f_0\sqrt{1+Bh^2}$ with $B$ scaling by register, per-partial decay ($\tau_h = \tau_0/(1+0.5(h-1))$, so the top dies first), two slightly detuned strings on the low partials for beating, and a short filtered-noise hammer transient.

**Rhodes** — a harmonic body with fast-decaying upper partials plus a separate short "tine" partial near $6f_0$, which is where the ding lives, and a 5.2 Hz tremolo.

A note on the Rhodes: the obvious implementation is the DX7 patch, a 14:1 FM operator with a fast-decaying index. It sounds right but it was a mistake here — the inharmonic sidebands land far from any harmonic series and the analyzer read them as phantom notes at B5, A6 and F7. Rebuilding it on a harmonic body plus one tine partial took the ghost count from 3 to **0**, and kept the character.

**Velocity is not just volume.** Measured dB maps to amplitude *and* to brightness — partial count and rolloff for the piano, upper-partial and tine level for the Rhodes. That's how real instruments encode dynamics, and it makes a quiet inner voice audibly quiet rather than merely turned down.

**Controls:** voice choice; *Play chord*; *Roll it up* (110 ms arpeggio stagger, good for hearing a voicing bottom-up); *Measured dynamics* vs equal level; and **A/B**, which loops `recording → silence → resynthesis` in one buffer so you can compare directly without touching a transport.

Round-trip check (analyze → synthesize → re-analyze): dynamics rank correlation **r = 0.96** for both voices. Note count drops on the round trip, because a synthetic chord with perfectly aligned partials is *harder* to analyze than a real recording — real instruments have inharmonicity and beating that help disambiguate octaves.

---

## 7. Concert pitch (A₄)

Two things must respond to the A₄ setting, and in the prototype both do:
- the log-frequency **bin centres**, $f(m) = A_4 \cdot 2^{(m-69)/12}$
- the **dictionary** harmonic positions

There's also **auto-detection** (*Detect from audio*), following the same idea as the NNLS-Chroma Tuning plugin: parabolically interpolate every significant spectral peak, express its deviation from the nearest equal-tempered semitone in cents, and take an **energy-weighted circular mean** over ±50 cents. Circular is the key detail — a naive mean breaks at the wraparound. Result is clamped to 415–466 Hz.

This matters more than people expect: historical recordings, wind bands and anything tape-based drift far enough to shift every note by a semitone boundary.

---

## 8. Performance architecture

The prototype runs on the main thread with `await yield_()` between pipeline stages so the UI can repaint and show progress. At ~280 ms per analysis that's fine. If you extend it:

- **Web Worker** for all DSP. Create from a Blob URL to stay single-file, or a real module in a bundled build. Transfer `Float32Array` buffers, don't copy.
- **AudioWorklet** if you ever want live/real-time analysis — it runs on the audio thread at 128-sample quanta. Note it cannot do a 16384-point FFT per quantum; you'd ring-buffer and analyze at hop intervals.
- **WASM** for the hot loops. The NNLS Gram construction and the HPSS median filters are the two costs; both are trivially portable to Rust/C++. Probably 3–5× on the median filter.
- **WebGPU** compute for the constant-Q transform if you go to a full CQT spectrogram view.
- **Essentia.js** (MTG/UPF, wasm) already ships `LogSpectrum` and `NNLSChroma` ported from the original Vamp plugin, plus `Chromagram`, `HPCP`, `ChordsDetection`, and benchmarks on Android and iOS. If you'd rather not maintain DSP, this is the shortcut — at the price of a wasm dependency and less control over exactly the two failure modes above.
- **`@spotify/basic-pitch`** (TypeScript, TF.js) is the neural option: polyphonic, instrument-agnostic, resamples to 22.05 kHz, small enough to run in-browser, outputs notes with pitch bends. Best used as a *second opinion* alongside NNLS — where they agree, confidence is high. It has no A₄ parameter (fixed 440 semitone grid), but its pitch-bend output lets you recover detuning.

---

## 9. Recommended stack

**Phase 1 — what you have now.** Vanilla HTML/JS, canvas, Web Audio. Zero dependencies, 53 KB, works offline, nothing leaves the device. Good enough to use daily.

**Phase 2 — productionise.** Vite + TypeScript. DSP into a Web Worker. Vitest against a fixture set of labelled chords so accuracy changes are measurable, not vibes. IndexedDB for saved sessions. PWA manifest + service worker so it installs to the home screen and runs on a plane.

**Phase 3 — accuracy.** Add Basic Pitch as a cross-check. Add a **Viterbi/HMM smoother** across consecutive segments — chord transitions have strong priors and this is where Chordino gets its remaining accuracy. Port the NNLS and HPSS inner loops to Rust/wasm.

**Phase 4 — separation.** Server-side `htdemucs_6s`, cached stems, per-stem analysis in the client.

---

## References

- Mauch & Dixon, *Approximate Note Transcription for the Improved Identification of Difficult Chords*, ISMIR 2010 — the NNLS method. Code: `c4dm/nnls-chroma`.
- Fitzgerald, *Harmonic/Percussive Separation Using Median Filtering*, DAFx 2010. Extended by Driedger, Müller & Disch, ISMIR 2014 (margin-based, handles noise better).
- Bittner et al., *A Lightweight Instrument-Agnostic Model for Polyphonic Note Transcription and Multipitch Estimation*, ICASSP 2022 — Basic Pitch.
- Correya et al., *Audio and Music Analysis on the Web using Essentia.js*, TISMIR 2021.
- Beck, Teboulle, *A Fast Iterative Shrinkage-Thresholding Algorithm*, SIAM J. Imaging Sci. 2009 — the FISTA solver.
