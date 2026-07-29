# Handoff — improving note identification in Harmonograph

**Repo:** `magnusfjeldolsen/harmongraph` · **Goal:** better identification of the individual notes inside a fenced chord.

Everything here is measured, not guessed. Three plausible improvements were tested and **failed**; they are documented so you don't repeat them. One was verified to work and is Task 2.

---

## 0. Read this first

**Scope.** Improve *note* detection — which pitches are sounding, at what level, with what confidence. Chord *naming* is downstream and out of scope. In particular: **do not add chord-transition priors / HMM / Viterbi.** Those operate on 12-bin chroma, which discards octave, so they cannot help note identification at all. They are a separate future task for chord labelling.

**Constraints — do not break these.**
- Zero runtime dependencies. No npm packages shipped to the browser, no build step. It must stay openable as static files on GitHub Pages.
- Must stay responsive on a phone. Budget: **< 900 ms** total for a 2.5 s selection on desktop Node (currently ~185 ms/chord). If a change exceeds this, put it behind a toggle defaulting off.
- Don't regress the UI. `index.html` behaviour, gestures and layout stay as they are unless a task says otherwise.

**Working method.** Every task ends with `node test/harness.mjs`. If a change does not improve F1 on the harness, revert it. Report the before/after table in your PR description.

---

## 1. Current state

Single file `index.html`, ~1100 lines of JS. Pipeline inside `analyze()`:

1. Slice selection (capped 6 s)
2. Optional HPSS — STFT 4096/2048, median filter 17×17, soft mask, ISTFT → harmonic audio
3. STFT 16384, hop 4096 → **magnitude averaged across all frames into one spectrum**
4. `logSpec()` → 3 bins/semitone, MIDI 21–132, raised-cosine gathering kernel
5. `whiten()` → running mean/std standardisation over ±1 octave
6. `buildDict(a4, 0.72)` → 88 columns, partial amplitudes `s^(h-1)`, L2-normalised
7. `nnls()` → FISTA + non-negative projection, 320 iterations, L1 = 0.004
8. Post-filters: activation threshold 0.12, fundamental-evidence gate 0.08, semitone NMS ratio 1.5
9. Second NNLS on the un-whitened spectrum, restricted to candidates → amplitudes
10. `pfund` — own vs others' contribution at the fundamental bin

Key parameters live in the `S` object: `decay: 0.72`, `GATE: 0.08`, `NMS: 1.5`, `thr: 0.12`, `fftN: 16384`.

---

## 2. Measured baseline

Run `node test/harness.mjs`. Corpus is 22 voicings × 6 timbres = 132 chords, 620 notes.

```
timbre        recall  prec.   oct  5th  oth  miss   P(real) hit/ghost
geometric     0.859   0.859     6    2    4    12    0.76 / 0.63
bright        0.835   0.623    18   22    3    14    0.83 / 0.49
dark          0.859   0.924     3    0    3    12    0.70 / 0.84   <- inverted
hollow        0.859   0.640     6   30    5    12    0.74 / 0.45
formant       0.835   0.597    20   17   11    14    0.83 / 0.45
inharmonic    0.894   0.854     7    1    5     9    0.77 / 0.69
OVERALL       0.857   0.749   octave-errors 60  ghosts 163  conf-gap 0.18
```

**What this says.**

- Recall is uniform (~0.86) but **precision collapses on timbres the dictionary can't represent**. `bright`, `hollow` and `formant` sit at 0.60–0.64. Timbre mismatch, not octave collapse, is the largest single driver of ghosts.
- `hollow` (clarinet-like, odd harmonics only) produces **30 fifth-errors** — a missing 2nd partial and a strong 3rd makes the fit invent a note a twelfth up.
- `formant` (fundamental is *not* the loudest partial) produces **20 octave errors**.
- `inharmonic` scores **best**. Inharmonicity breaks exact octave/fifth coincidences and makes disambiguation easier. Real pianos are easier than synthetic ones.
- **`pFund` is weak and on `dark` it is inverted** — ghosts score *higher* than real notes. The confidence column is not currently trustworthy. Overall gap is only 0.18.

The earlier "90% recall / 96% precision" figure was measured on an easier corpus with only geometric partials. Ignore it; use the table above.

---

## 3. Verified negative results — do not attempt

These were implemented and benchmarked. All three made things worse.

| Attempt | Result | Why |
|---|---|---|
| **Multi-template dictionary** (2–4 decay rates per note, 176–352 columns) | precision **0.728 → 0.551** | Overcomplete dictionary is degenerate. More ways to explain the same energy means more ghosts. Recall gained only +0.05. |
| **Evidence-protected pruning** (skip pruning notes with strong energy at their own fundamental) | F1 **0.835 → 0.806** | Octave ghosts have strong fundamental evidence *by definition* — the real note's 2nd partial sits exactly there. Evidence cannot protect against them. |
| **Auto-fit decay `s` per segment** by minimising reconstruction residual | F1 **0.835 → 0.755** | Degenerate model selection: picks the smallest `s` on the grid for 100% of chords regardless of actual timbre, because a peakier dictionary always fits better unpenalised. Would need a complexity penalty (AIC/BIC) or envelope estimation from already-detected notes. |

Also tested: **L1 penalty sweep** (0.004 → 0.12) moves precision 0.728 → 0.741 and costs nothing. Marginal; take it as a free tweak, not a fix.

---

## Task 0 — Refactor for testability *(prerequisite, no behaviour change)*

Split the single file into:

```
index.html      markup + styles, loads app.js as a module
dsp.js          pure DSP, no DOM, no globals — ES module
app.js          UI, state, canvas, transport, synthesis
test/           corpus.mjs, harness.mjs, baseline.json  (provided)
```

`dsp.js` must export exactly:

```js
FFT, getFFT, hann, stft, istft, magOf, applyMask, med, hpssMask,
buildKernel, logSpec, whiten, buildDict, nnls, idChord, chordLabel,
midiFreq, midiName, clamp, NN, TPL,
BPS, LO, HI, NB, NOTE_LO, NOTE_HI, NN_COUNT, binMidi, binFreq, freqBin,
analyzeSegment
```

`analyzeSegment(signal, sampleRate, opts)` is the whole detection pipeline as a pure function:

```js
analyzeSegment(sig, sr, { a4=440, fftN=16384, decay=0.72, hpss=true,
                          thr=0.12, gate=0.08, nms=1.5, maxNotes=12 })
  -> { notes: [{ midi, name, freq, db, pFund, activation, cents }],
       yraw, yw, fundBin, detN, evid, windowSize }
```

A working reference implementation encoding **exactly** current behaviour is in `reference/analyzeSegment.js`. Use it verbatim for Task 0 so the baseline reproduces, then evolve it.

Note `index.html` must use `<script type="module">`. That breaks `file://` opening — fine, the mic already required https, and the deploy target is GitHub Pages.

**Acceptance:** `node test/harness.mjs` reproduces the Section 2 table exactly. App behaves identically in a browser.

---

## Task 1 — Free tweak: raise L1

Set the detection NNLS L1 penalty from `0.004` to `0.10`.

**Acceptance:** precision up ~0.01, recall unchanged, no runtime cost. Trivial, do it first to confirm the harness loop works.

---

## Task 2 — Redundancy pruning *(the verified win — highest priority)*

**Rationale.** An octave or fifth ghost is a note whose harmonics are a *subset* of a stronger note's harmonics. It explains nothing the others don't already explain. So test that directly: remove it and see whether the reconstruction gets meaningfully worse.

**Algorithm.** After the candidate set is built (post threshold/gate/NMS), greedy backward elimination:

```
loop while candidates > 1:
  x_full  = nnls(D, candidates, yw)
  e0      = ||D·x_full - yw||²
  for each candidate q:
      sub   = candidates without q
      x_sub = nnls(D, sub, yw)
      rel_q = (||D·x_sub - yw||² - e0) / (e0 + eps)
  q*   = argmin rel_q
  if rel_q* < PRUNE_TOL:  remove q*; continue
  else: break
```

`PRUNE_TOL = 0.05`. Candidate sets are ≤ 12, each sub-fit is ≤ 12 columns, so cost is negligible.

**Measured effect** (over all 6 timbres):

| | recall | precision | F1 | octave err | fifth err |
|---|---|---|---|---|---|
| baseline | 0.857 | 0.728 | 0.787 | 74 | 58 |
| **prune 5%** | 0.808 | **0.864** | **0.835** | **39** | **16** |
| prune 10% | 0.761 | 0.922 | 0.834 | 24 | 4 |

Octave errors −47%, fifth errors −72%. Recall drops ~5 points because genuine octave doublings really are redundant — that is an honest limit of a static spectrum, not a bug.

**Expose `PRUNE_TOL` as a UI slider** labelled something like *"Strictness — permissive ↔ strict"*, range 0–0.12, default 0.05. Users transcribing dense piano voicings will want it lower; users identifying a guitar chord will want it higher. Re-runs without re-running the STFT, so it should be instant.

**Acceptance:** harness F1 ≥ 0.83, octave errors ≤ 40, runtime still < 900 ms.

---

## Task 3 — Replace `pFund` with envelope correlation

**Rationale.** The current metric compares contributions at a single bin at a single averaged time, and Section 2 shows it inverts on `dark`. A real note's partials all rise and fall *together*; a ghost's "partials" are borrowed from other notes and its implied envelope won't track.

**Algorithm.** You already have `stft` output — don't average it away.

1. For each detected note, for harmonics h = 1…8, extract the magnitude time-series at that harmonic's bin across frames → `E_h[t]`.
2. Compute the mean Pearson correlation between `E_1[t]` and each `E_h[t]`, h ≥ 2, weighted by the amplitude of h.
3. `pFund = clamp(mean correlation, 0, 1)`, optionally averaged with the existing static measure.

Notes whose fundamental doesn't co-modulate with its own harmonic series are ghosts. This also gives you onset grouping almost free.

**Acceptance:** confidence gap (`P(real)` on hits minus on ghosts) rises from **0.18 to ≥ 0.35**, and is positive on *every* timbre including `dark`. Recall/precision must not regress.

---

## Task 4 — Per-frame fitting instead of one averaged spectrum

**Rationale.** Step 3 currently collapses ~30 frames into one mean spectrum. Notes that decay at different rates, or enter mid-fence, get smeared. This is the biggest structural weakness left.

**Algorithm.**
1. Run the NNLS per frame instead of once on the mean.
2. Aggregate note activations across frames — start with the **median of the top 60% of frames** per note; this rejects transients and late entries better than the mean.
3. **Warm-start** FISTA from the previous frame's solution. The Gram matrix `DᵀD` is fixed and already computed once; only `Dᵀy` changes per frame. Expect convergence in far fewer than 320 iterations.
4. Emit a **stability** figure per segment: fraction of frames whose note set matches the aggregate. Surface it in the UI as *"segment is 87% one chord"* vs *"chord change detected at 1.4 s"* — this is the only signal the tool can give that the user's fence is wrong.

**Watch the budget.** If warm-started per-frame fitting exceeds 900 ms, reduce to ~12 evenly spaced frames rather than all of them.

**Acceptance:** harness F1 improves, runtime < 900 ms, stability figure exposed in the UI.

---

## Task 5 — Inharmonicity in the dictionary

**Rationale.** Piano partials sit at `f_h = h·f₀·√(1 + B·h²)`. At h = 10 with B = 4e-4 that is ~34 cents sharp — a full log-bin at 3 bins/semitone, so the template is misaligned exactly where discrimination matters. Note the `inharmonic` timbre already scores *best* in the baseline: inharmonicity destroys exact octave coincidence, which helps.

**Algorithm.** Add a `B` parameter to `buildDict`, scaling with register (e.g. `B = 5e-5 · 2^((midi-21)/24)`). Optionally estimate `B` per segment by testing a small grid and taking the best reconstruction — but see the Section 3 warning about degenerate model selection, so grid over `B` only, with `s` fixed.

**Acceptance:** improves or holds F1 on all timbres; must not regress `hollow` or `formant`.

---

## Task 6 — Per-note tuning readout

Cheap and useful. For each detected note, parabolic-interpolate the peak in the *linear* magnitude spectrum near its fundamental and report cents deviation from equal temperament in the `cents` field (already in the return shape, currently hardcoded 0). Display it in the voicing table.

This makes the tool useful for intonation work, and gives the user a direct check that their A₄ setting is right.

---

## Suggested order

`0 → 1 → 2 → 3 → 4 → 5 → 6`. Tasks 0–2 are the ones that matter most; stop there if time is short, since Task 2 alone is a ~6-point F1 gain and a 47%/72% cut in the two error classes the user cares about.

## Reporting

For each task, paste the harness table before and after. Flag any per-timbre regression even if the overall number improves — a change that helps `geometric` while wrecking `hollow` is not an improvement, it is overfitting to the synthetic model.

**Finally:** the corpus is synthetic and its `geometric` timbre is exactly what the dictionary assumes. Before declaring success, test on a handful of real recordings — a piano chord, a strummed guitar, a horn section — and confirm the results are sane by ear using the app's own A/B resynthesis.