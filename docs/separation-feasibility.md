# Splitting a fenced chord by instrument — feasibility

Written against the shipped pipeline and a purpose-built two-instrument corpus,
not against intuition. Every number marked **measured** was produced this
session by scripts that imported `js/analyzeSegment.js` unmodified; no shipped
file was touched. Numbers marked **literature** are cited. Everything else is
flagged **judgement**.

Companion documents: `RESEARCH.md` §5 (the four-tier isolation ladder), §6
(resynthesis), §10 (the plucked-string problem); `docs/algorithm-assessment.md`
(what the detector actually does).

---

## 0. Verdict

**Do not build "split by instrumentation" as asked. Build "split by voice",
which is 90% shipped already, and let the user do the grouping.**

Three findings, in descending order of how much they should change the plan.

**1. Nothing in the pipeline can tell one instrument from two.** I clustered the
observed partial-amplitude profiles of the detected notes — the method proposed
in the brief, the one that reuses data the pipeline already computes — over 80
two-instrument chords and 30 one-instrument chords. The 2-cluster silhouette
separates the two populations with **AUC 0.532** (0.500 is no information).
The gap statistic, the only standard index that is even defined at *k* = 1,
called a solo chord "one instrument" **11 times out of 20**. A feature that
invents a second guitarist on 45% of solo chords is worse than no feature, and
the brief says so itself. This is the single finding that decides the question.

**2. The clustering works, barely, and only when told how many voices to find.**
Given *k* = 2, partitioning by partial profile is right **0.727** of the time
against an exact permutation null of **0.657** — a lift of **+0.070**, on a
six-note chord that is 0.4 notes better than guessing. It got the partition
exactly right 14 times in 80. That is a real effect and it is far too small to
put in front of a user as "here are your two instruments".

**3. The user's duration hypothesis is right about compute and wrong about the
conclusion.** Demucs cost does scale with duration, but it bottoms out at one
7.8 s model segment, which is **~46 s of single-threaded WASM** on a laptop
(literature, derived below), and GitHub Pages cannot serve the COOP/COEP
headers that would let you use threads at all. The weights are 53–81 MB
whichever way you slice the audio, against a 53 KB app. Short segments do not
rescue neural demixing here; they reduce a 40-minute problem to a 46-second one,
against a 100 ms budget.

**What I would do instead**, in order: ship the per-note isolation UI the brief
describes but bind the tabs to *notes* (which the DSP already delivers, at
`js/audio.js:258-291`), add a manual "group these notes into a voice" control,
and — the one genuinely new separation axis worth building — use the stereo
image, which the app currently throws away at `js/audio.js:40-42` while keeping
the multichannel buffer alive at `js/audio.js:38`. Ranked table in §6.

---

## 1. Is the duration hypothesis right?

Partly. Separate the two costs, as the brief asks.

### Compute does scale with duration, down to a hard floor

Demucs v4 `htdemucs` is trained and run on fixed segments of **7.8 s**
(`Fraction(39,5)`), with overlap between segments; inference chunks arbitrary
audio into that quantum (literature). So a 2-second selection does not cost
2/240ths of a 4-minute track — it costs **one segment**, and one segment is the
smallest unit of work the model has.

`free-music-demixer`'s own published benchmarks give the constant
(literature): a ~7-minute track takes **~41 minutes single-threaded**, i.e. a
real-time factor of ≈ 5.9×. One 7.8 s segment is therefore **≈ 46 s of
compute**. Its multi-threaded figure (~9 min for the same track with 8 workers)
is parallelism *across* segments; with one segment there is nothing to
parallelise, so it does not apply. The wall clock for a 2-second chord is the
single-threaded number.

And on this deployment you would not get threads even if there were segments to
spread across them. `demucs-onnx`/`demucs-web` need `SharedArrayBuffer`, which
needs `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` response
headers. **GitHub Pages does not let you set response headers.** That is a hard
constraint violation independent of speed (judgement, from the stated deployment
in `docs/STATUS.md`).

### The download does not scale at all

| model | weights | vs. the 53 KB app |
|---|---|---|
| `htdemucs` (4 stems) | 81 MB fp16 | 1560× |
| `htdemucs_6s` (adds guitar, piano) | 53 MB fp16 | 1020× |
| Open-Unmix `umxhq`, all four targets | ~144 MB | 2700× |

`free-music-demixer`'s maintainers note compression only reaches ~70 MB and is
not worth the load time (literature). On a 10 Mbit/s mobile link, 53 MB is ~42 s
of download before the ~46 s of compute starts. Cached afterwards — but a
100-second first run for a two-second chord is not an interactive feature.

### The plain statement

**Short segments do not make neural separation viable here.** They convert a
3–5 minute job into a ~46 s job. The budget is 100 ms, with ~1 s as the ceiling
for opt-in work. That is 46× over even the opt-in ceiling, before the download.

**What would have to change**, any one of which flips this:

- A separator with weights under ~5 MB and a real-time factor under ~0.1 on
  scalar WASM. Nothing off-the-shelf is close; the smallest credible music
  separator is still tens of megabytes. *Towards Practical Real-Time
  Low-Latency Music Source Separation* (RT-STT, arXiv:2511.13146)
  is the right *shape* of research — explicitly lightweight, real-time,
  quantised — but publishes no MB/RTF figure I could verify, and is not
  packaged for the browser.
- WebGPU with a small model. `demucs-rs` targets this; it does not remove the
  weight download and it does not run on every phone.
- A server, which is what `RESEARCH.md` §5 already recommends and which remains
  correct.

One more thing worth saying plainly: **Demucs would not answer the question
asked anyway.** It emits fixed named stems — vocals/drums/bass/other, or
`htdemucs_6s`'s six. The brief asks for an unknown number of discovered voices.
Those are different features. Demucs is better than what is asked for when the
material happens to be a band; it is useless when the material is two acoustic
guitars, which is the case a "split this chord" button invites.

---

## 2. The core tension — verified, and it is stronger than stated

**The working belief in the brief is correct, and for a sharper reason than
"blind methods rely on different temporal activation patterns". For NMF the
dependency is not a heuristic weakness. It is an identifiability theorem.**

NMF factors *V ≈ WH*. The factorisation is unique only up to permutation and
scaling, and only under conditions on *W* and *H*: **separability** (Donoho &
Stodden, 2003) or its relaxation, the **sufficiently scattered condition**
(Huang, Sidiropoulos & Swami, 2014; Fu et al., 2018). Both are statements that
the activations must be *spread out* — that for each source there exist regions
where it dominates and others do not.

A tightly fenced sustained chord is the exact violation. If every source is on
for the whole window at a roughly constant relative level, the rows of *H* are
near-proportional, *H* is effectively rank-1, and for any invertible non-negative
*A* the pair (*WA*, *A*⁻¹*H*) fits identically well. The decomposition is not
merely hard to find. It does not exist as a unique object. Any answer NMF
returns in that regime is a property of the initialisation, not of the audio —
which is consistent with the reported ~1.4–1.6 dB SI-SDR spread between
initialisation strategies in the audio NMF literature.

**How strongly does it hold?** For NMF, ICA and PLCA: completely, and it is a
theorem, not a tendency. For the partial-profile method proposed in the brief it
**does not apply at all** — that method groups by *spectral shape*, not by
activation pattern, so temporal degeneracy is irrelevant to it. The brief's
instinct to prefer it is right for the right reason. It just fails for a
different one (§3).

### Does it soften for 3–5 s windows, or with onset variety?

**Duration alone buys nothing. Onset and decay variety buys a lot.** Measured,
80 two-instrument chords per row, clustering the per-note activation envelope
(decay slope in dB/s plus onset time) instead of the spectral profile:

| what happens inside the 2.5 s fence | envelope-clustering accuracy | permutation null | lift |
|---|---|---|---|
| **sustained — the app's own use case** | 0.673 | 0.662 | **+0.011** |
| onset offset 0.15 s (a strum) | 0.690 | 0.662 | +0.028 |
| onset offset 0.30 s | 0.719 | 0.663 | +0.056 |
| onset offset 0.60 s | 0.748 | 0.664 | +0.084 |
| decay difference only (τ 0.7 s vs 8 s) | 0.754 | 0.664 | +0.090 |
| **onset 0.30 s + decay difference** | **0.877** | 0.669 | **+0.208** |

Nineteen times the lift, same chords, same feature, same window length — the
only thing that changed is whether the sources did anything different inside the
fence. **The cue is not time. The cue is contrast.**

Which produces the uncomfortable corollary: `RESEARCH.md` §4 tells users to
"fence tightly", and `docs/algorithm-assessment.md` §F makes the same point
about Task 3's envelope correlation. A separation feature wants the *opposite*
fence from the analysis — wide enough to contain the entries. Those are two
different selections over the same audio, and a UI that offers both from one
fence is promising something the DSP cannot deliver.

*(Methodological note, in the spirit of §A of the assessment: my first version
of this test used correlation distance on the log envelope, which is
scale-invariant and therefore structurally blind to a slope difference. It
reported +0.00 for the decay conditions. That was a property of my metric, not
of the world. The table above uses an explicit slope+onset feature. A sound idea
was very nearly filed as a negative result because of one badly chosen
distance.)*

---

## 3. What actually works on short windows

### NMF and harmonic-constrained NMF — no

Fails §2's identifiability condition by construction on a sustained chord, and
you would still need §3's clustering step afterwards to get from components to
instruments. Parameter sensitivity is the worst of any method here: the rank
*R*, the sparsity weight, the divergence (Euclidean/KL/IS) and the random seed
all move the answer, and there is no held-out quantity to tune them against
inside a single 2-second selection.

Cost is not the objection. On the 333-bin log spectrogram the pipeline already
builds (`js/dsp/nnls.js:9`) at ~43 frames, *R* = 20, 200 iterations, the work is
≈ 2.3 × 10⁸ multiply-adds — a few hundred ms in JS on a desktop, a few seconds
on a phone (judgement, arithmetic). Feasible. Just not answering a well-posed
question.

### Shift-invariant PLCA (Benetos & Dixon) — not unsupervised

Worth being precise, because the brief lists it as an unsupervised option. The
JASA 2013 system uses **spectral templates extracted from monophonic
recordings** of each instrument, per pitch and per sound state
(attack/sustain/decay), with HMM constraints on the state order. It is a
supervised, per-instrument-dictionary method that happens to use a
factorisation. Take away the template library and it degenerates to NMF, with
the shift-invariance buying pitch-invariance but not source identity.

### Clustering NMF basis columns by timbral features — no

`RESEARCH.md` §5 tier 3. Inherits both problems at once: the bases come from a
non-identifiable factorisation, and then you have to cluster 10–20 points with
no *k*. Spiertz & Gnann (2009) and Jaiswal et al. (2011, 2012) improved the
clustering step specifically because it was the weak link, and both evaluate on
mixtures with a known source count. Bigger build than tier 4 on a per-line
basis, for less.

### The partial-profile method — scrutinised hardest, and this is the answer

The proposal: for each detected note, read its observed partial amplitudes out
of the spectrum, and cluster those profiles. It reuses `yraw`
(`js/analyzeSegment.js:78`), it is genuinely unsupervised, and the dictionary
already knows where the partials are (`js/dsp/nnls.js:94-102`, 20 partials per
key).

It has real prior art, which is the first thing to say for it. **Duan, Zhang,
Zhang & Shi (2008)**, *Unsupervised Single-Channel Music Source Separation by
Average Harmonic Structure Modeling*, is essentially this idea, and
**Duan, Han & Pardo (2014)**, *Multi-pitch Streaming of Harmonic Sound
Mixtures*, casts multi-pitch streaming explicitly as clustering pitches to
minimise within-cluster timbre inconsistency, using harmonic structure and a
uniform discrete cepstrum. So the idea is not naive.

But read what those papers require:

- **The number of sources is an input.** Duan et al. 2008 states it as a
  precondition ("given the number of instrumental sources"); the reference
  implementation takes it as a parameter and does not estimate it.
- **Sources must have narrow pitch ranges.** That is their stated assumption,
  and it is the register problem the brief already anticipates: the same
  instrument's spectral envelope genuinely changes across its range, so
  "one instrument" is not one point in profile space, it is a curve.
- **The harmonic structures are averaged over many frames across a whole
  piece**, including passages where a source is sparse. Not six points from one
  chord.

Now the measurement. I built two-instrument chords by assigning the notes of a
voicing to two of the project's own six timbres (`test/corpus.mjs:76-129`),
synthesised with the same partial/decay/noise model as the shipped corpus, ran
the unmodified `analyzeSegment`, read a 10-partial profile per note out of
`yraw`, converted to dB shape with the level removed, and clustered with average
linkage. Accuracy is best-of-two-labellings; the null is the **exact
permutation null** over all relabellings with the same class sizes, computed per
partition, which is the right control because agglomerative clustering does not
always produce a balanced split.

**80 chords: 8 timbre pairs × 5 voicings × 2 assignment schemes (contiguous
register split, and interleaved).**

| | accuracy | permutation null | lift |
|---|---|---|---|
| partial-profile clustering, *k* = 2 given | **0.727** | 0.657 | **+0.070** |
| same, on the notes the detector actually reported | 0.720 | — | — |
| exactly-right partitions | **14 / 80** | | |

A second seed set over 48 cases gave 0.722/0.700 and a third gave 0.767/0.660,
so the effect is about **+0.09 ± 0.03**. It is real. It is also, on a six-note
chord, less than half a note better than chance.

Two diagnostics explain why, and they are the two failure modes the brief
predicted:

**Overlapping partials corrupt the profiles, and it costs about what you'd
fear.** Correlation between the observed profile shape and the timbre's true
shape:

| timbre | one note alone | inside a 6-note two-instrument chord |
|---|---|---|
| geometric | 0.981 | |
| inharmonic | 0.991 | |
| bright | 0.975 | |
| dark | 0.959 | |
| hollow | 0.923 | |
| formant | 0.766 | |
| **mean over all cases** | **~0.96** | **0.795** (min 0.521) |

The monophonic column is the ceiling this readout can reach — near-perfect for
five of six timbres, which says the extraction itself is sound. Polyphony takes
it to 0.795. Klapuri's spectral-smoothness principle (2003) is the standard
repair — split energy at a shared bin between the competing notes under a
smoothness prior — and it would raise this number. It is worth building
*anyway*, because §10's ghost problem is the same corruption seen from the other
side. It is not enough to rescue the clustering.

**The register confound is measurable.** Contiguous-register assignment scores
0.750, interleaved 0.694. The clustering is partly finding *high notes vs low
notes* rather than *instrument A vs instrument B* — exactly Duan et al.'s
narrow-pitch-range caveat showing up as a bias, and the reason a solo piano
chord spanning four octaves will happily split into two "voices".

**And the estimator is starved.** `selectNotes` caps at 12 candidates
(`js/analyzeSegment.js:49`, `maxNotes=12`) and a typical chord yields 4–8. You
are clustering 6 points in a 10-dimensional space. No clustering criterion is
reliable at that sample size, and no amount of feature engineering fixes it.

**Verdict on the favourite: sound in principle, correctly identified as the best
fit for this codebase, and it does not clear the bar.** It gives +0.07 with *k*
supplied and cannot supply *k* itself (§4). Its one genuine virtue is that it is
free — profile extraction plus agglomerative clustering for 6 notes measured at
**0.021 ms**, against `analyzeSegment`'s 100 ms. Cost was never the problem.
Information is.

### Common-AM / onset-synchrony grouping (CASA) — right cue, wrong window

Bregman (1990) and Darwin's work put onset synchrony among the strongest
grouping cues, with components starting within ~30 ms fusing. My §2 table is the
same result from the other end: the envelope feature is worth +0.208 when
onsets differ by 0.30 s and decays differ, and +0.011 when nothing differs.

The problem is that a fenced sustained chord contains neither. Note also the
0.15 s row: **a strum spread over 150 ms gives +0.028**, which is nothing. The
onset stagger `RESEARCH.md` §10 hopes to exploit (20–40 ms) is an order of
magnitude below what my measurement can use, and `test/corpus.mjs:147` caps its
stagger at 4 ms deliberately. This cue needs the fence to span an *entry*, not a
strum.

### Not on the brief's list, and the one I'd actually build

**Spatial separation — ADRess (Barry, Lawlor & Coyle, DAFx 2004) or DUET.** For
a stereo source, instruments are usually panned to different positions, and
phase-cancelling one channel against a gain-scaled other exposes frequency-
dependent nulls whose position encodes azimuth. Resynthesise by keeping bins
near a chosen azimuth.

Why it matters here, and why nobody in the brief mentioned it:

- It works **on sustained chords**. It uses no temporal activation diversity, no
  timbre model, no clustering, and no *k*. §2's tension does not apply.
- It is cheap: one STFT and a per-bin scan, comparable to what `hpssMask`
  already costs (`js/dsp/hpss.js:7`).
- The data is already in memory. `js/audio.js:38` keeps the multichannel
  `AudioBuffer` in `S.buf`; `js/audio.js:40-42` averages it to mono for analysis
  and everything downstream reads `S.mono`.
- It fails **honestly**: on a mono file or a phone-mic recording, every source
  sits at the same azimuth and the tool can say "nothing to split here" with
  certainty rather than guessing. That is the graceful degradation to one voice
  the brief wants, and it comes from a measurement rather than from a threshold.

It is not a general answer — it does nothing for a solo guitar, and it smears
badly on reverberant or mid/side-encoded material. But it is the only method
surveyed that delivers actual instrument separation on the app's actual use
case, and its failure mode is detectable in advance.

**Recent literature I checked and am not recommending.** Schulze-Forster et al.
(2023) differentiable parametric source models is the strongest recent
"unsupervised" music separation and still needs training audio (their claim is
data *efficiency* — good results from under three minutes of audio — not
training-freeness), plus f0 tracks as input. ZeroSep (2025) and diffusion-prior
training-free separation repurpose large pretrained generative models, which
puts them further from a zero-dependency static site than Demucs is. MixIT-style
unsupervised training needs a mixture corpus. None of these change the answer.

---

## 4. Choosing *k* without being told

This is where the feature dies, and the brief is right that getting **1**
correct matters more than getting **4** correct.

I measured the candidate criteria on 80 two-instrument and 30 one-instrument
chords, on the profile features from §3.

**Silhouette — carries no information about this question.** It is undefined at
*k* = 1, so it can never answer "don't split". Worse, its *value* at *k* = 2
does not separate the populations either:

| | min | p25 | median | p75 | max |
|---|---|---|---|---|---|
| silhouette at *k*=2, **two** instruments | 0.16 | 0.27 | 0.34 | 0.41 | 0.54 |
| silhouette at *k*=2, **one** instrument | 0.15 | 0.23 | 0.32 | 0.42 | 0.54 |

**AUC 0.532.** The distributions are the same distribution. Any threshold that
never splits a solo chord also never splits a duo. This single number is the
strongest result in this document, and it is the reason for the verdict.

**Gap statistic — the right tool, and it still is not good enough.** Tibshirani,
Walther & Hastie (2001) is the one standard index defined at *k* = 1, precisely
because it frames the choice as a hypothesis test against a uniform null rather
than as an internal validity score. That is the correct framing and it is why it
is the only candidate worth taking seriously. Measured:

- **11 / 20 solo chords correctly called *k* = 1.** The other 45% were split.
- **14 / 48 two-instrument chords correctly called *k* = 2**; 32 were called
  *k* = 1 and 2 were called *k* ≥ 3.

So it is conservative — it defaults toward 1 — and still fabricates a second
voice on nearly half of solo material. With *n* ≤ 12 points the reference
distribution is estimated from a bounding box containing a handful of samples;
the statistic is being asked to do something its asymptotics do not support.

**Eigengap — not applicable at this sample size.** A spectral gap in a 6 × 6
affinity matrix is noise. (Judgement.)

**BIC on a GMM — not estimable.** Six to twelve points in ten dimensions cannot
support a covariance estimate per component. You would have to force spherical
components with a shared variance, at which point BIC is measuring cluster
compactness and inherits silhouette's AUC 0.532. (Judgement, from the sample
size.)

**Agglomerative with a distance cutoff — the only one with the right shape, and
it needs a constant nobody can set.** A cutoff *can* express "never split",
which the others cannot, and it is one line. But the constant would have to be
calibrated on a corpus of real one- and two-instrument recordings, and the
silhouette overlap above says the separating margin, if any, is small.

**The honest recommendation on *k*: do not estimate it.** Default to one voice
and require an explicit user action to split. The user knows whether they are
pointing this at a solo guitar. The machine, measurably, does not.

---

## 5. Honest verdict

**Should this be built as asked? No.** Not because it is expensive — the
clustering step measured at 0.021 ms — but because the output would be a
confident claim the evidence does not support. Tabs labelled "Voice 1 / Voice 2"
over a solo guitar chord, appearing 45% of the time, are worse than no tabs:
they teach the user that the tool's assertions are unreliable, which
retroactively damages the note list, which *is* reliable. This project has
already paid that price once — `RESEARCH.md` §10 is the story of a confidence
readout that became "where the guesswork moved".

**What the user actually asked for, restated as something deliverable:** *"let
me hear one part of this chord at a time, and get back to the mix easily."*
Instrument identity is one way to slice that. It is not the only way, and it is
the one the DSP cannot do. Note identity is another, and the DSP does it well.

**On naming, since the brief raises it:** no unsupervised method can name an
instrument — that is definitional, not a limitation to be engineered away. But
the honest label is not "Voice 1 / Voice 2" either, because §4 shows the tool
cannot establish that there *are* two. The only labels the evidence supports are
the ones already in the result panel: note names. Even supervised systems trained
on a closed set of five instruments reach 84.1% / 77.6% / 72.3% on duos / trios /
quartets (Kitahara et al., 2007) — and that is *with* labelled training data and
a known vocabulary, neither of which exists here.

---

## 6. Ranked recommendation

| # | What | Effort | Expected payoff | Status |
|---|---|---|---|---|
| 1 | **Per-note isolation tabs.** Bind the tabs below the waveform to the detected notes, not to instruments. `buildIso('notes')` at `js/audio.js:258-291` already builds the ±50-cent harmonic-comb mask and resynthesises; `js/audio.js:294-310` already level-matches the layer to the recording, and tells the user how much makeup gain it applied, so a subset does not read as broken. Add "full mix" as the always-present first tab. | days, **UI only** | Delivers the stated interaction — tap to hear one thing, tap back — with zero new DSP and zero new claims. `docs/interaction-design.md` already establishes that detected notes, not keys, are the hit targets. | shipped DSP, **judgement** on the UX |
| 2 | **Manual grouping.** Let the user assign detected notes to Voice A / Voice B and mask the union. | hours on top of 1 | Gives "split by instrumentation" exactly where it is real: the user knows which notes are the bass. No *k* to estimate, no fabricated voice. | **judgement** |
| 3 | **Stereo azimuth separation (ADRess).** Opt-in when `S.buf.numberOfChannels ≥ 2` (`js/audio.js:38`). One STFT plus a per-bin azimuth scan; expose 2–4 azimuth bands as extra layers alongside the existing `harm`/`perc`/`notes` layers. | ~1 day | The only method surveyed that separates real instruments on a sustained chord. Detects its own inapplicability (mono, or all sources centred) instead of guessing. | **literature** (Barry, Lawlor & Coyle 2004); untested on this corpus, which is mono |
| 4 | **Spectral-smoothness repair of overlapped partials** (Klapuri 2003) in the amplitude pass. | ~half day | Raises the observed partial profiles from 0.795 toward the 0.96 monophonic ceiling. Worth it for the dynamics readout and for §10's ghost problem regardless of separation. | **measured** gap; the repair itself is **literature** |
| 5 | **A "does this fence contain one event or several?" indicator** from the envelope features in §2 — onset spread and decay-slope spread across detected notes. | hours | Tells the user when a wider fence would give the tool something to work with, which is the honest precondition for any temporal method. Overlaps `docs/algorithm-assessment.md` §F's cheap stability figure — build one thing, not two. | **judgement** |
| 6 | **Automatic clustering into voices** | — | **Do not build.** +0.07 over chance with *k* given; AUC 0.532 for choosing *k*. | **measured** |
| 7 | **Client-side neural demixing** | — | **Do not build.** ~46 s per 7.8 s segment single-threaded, 53–81 MB of weights, and GitHub Pages cannot serve the headers threads require. `RESEARCH.md` §5's server-side recommendation stands. | **literature** |

---

## 7. What would falsify this

Listed by how likely each is to be the thing that is wrong.

**1. My corpus is synthetic, and my feature is amplitude-only.** This is the
real weakness, and it cuts toward the optimistic side. I clustered a 10-point
partial-amplitude profile. Real instruments also differ in **vibrato and
micro-frequency modulation** (common FM is a strong CASA grouping cue and a
static magnitude spectrum cannot see it), in **beating between paired strings**,
in **noise floor** (breath, bow, fret buzz), and in **attack residue**, all of
which are extra dimensions my feature discards. If a corpus of real
two-instrument recordings gives profile-clustering a lift of **≥ +0.30** over
the permutation null, or a one-vs-two **AUC ≥ 0.80**, recommendation 6 flips and
this document is wrong. Building that corpus is cheap — two instruments, known
notes, a few dozen sustained chords — and it is the first thing I would do
before overriding this verdict. `docs/algorithm-assessment.md` already lists
"no two-instrument segments" as a corpus gap; this is the same gap.

**2. But the synthetic timbres are unrealistically *far apart*, which cuts the
other way.** `geometric` vs `dark` is a 0.72 rolloff against 0.45; `hollow` is a
comb with no even partials. Two acoustic guitars, or a guitar and a piano in the
same register, are far closer than any pair I tested. So +0.07 is plausibly an
**upper** bound for the case a user will actually point this at, and the real
number may be indistinguishable from chance. These two effects push in opposite
directions and I cannot say which dominates without real audio.

**3. The *k* result is the most robust thing here and the hardest to overturn.**
AUC 0.532 across 110 chords, with silhouette distributions that coincide at
every quartile, is not a threshold that needs tuning — it is two populations that
are not distinguishable by this statistic. Overturning it needs a *different*
statistic on a *different* feature, not a better constant.

**4. The Demucs arithmetic rests on one published benchmark** (41 min for a
~7-minute track, single-threaded) and on the 7.8 s segment length. If either is
wrong the ~46 s figure moves proportionally. It would have to move by a factor of
50 to matter, and the 53 MB download would still be there.

**5. Recommendation 3 (ADRess) is the least evidenced thing I am recommending.**
I did not test it — the corpus is mono and the app discards stereo before
anything can. Its failure modes are known and real: mid/side-encoded material,
heavy reverb, and modern productions that put everything near centre. Before
building it, check on a handful of real stereo files whether the instruments in
the material this tool is used on are actually panned apart. If they are not,
recommendation 3 drops off the list and the honest answer is recommendations 1,
2, 4 and nothing else.
