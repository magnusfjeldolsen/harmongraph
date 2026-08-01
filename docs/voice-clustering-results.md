# Can we split a segment into per-instrument voices by clustering the notes we already detect?

Measured 2026-08-01 on branch `voices`. Everything here is reproducible with
zero dependencies:

```
node test/exp/extract.mjs --dur 2.5     # ~4 min, writes test/exp/profiles-2.5.json
node test/exp/report.mjs                # the tables below
node test/exp/isolated.mjs              # the mechanistic diagnostic
node test/exp/duration.mjs              # the segment-length sweep
```

Saved outputs: `test/exp/out-*.txt` (human), `test/exp/report-*.json` and
`test/exp/isolated.json` (machine). The 1.6 MB `profiles-*.json` intermediates
are gitignored and regenerate in ~4 minutes each.

---

## Verdict

**No. Don't build this.**

Not because timbre fingerprints are a bad idea — on isolated single notes they
identify the instrument with 100% accuracy — but because of four measurements,
any one of which is disqualifying:

1. **The false-split rate and the true-split rate are the same number.** Every
   count selector tested (silhouette, gap, eigengap, BIC) reports "more than one
   voice" on a solo segment about as often as on a real two-instrument segment.
   The AUC of the best statistic at separating a solo from a duet, on real
   detections, is **0.64** — and 0.54 for silhouette, which is the one you would
   actually ship. 0.50 is a coin flip. There is no threshold that makes this
   work, because the underlying statistic carries almost no information.
2. **Splitting on MIDI pitch alone beats every timbre fingerprint** (ARI 0.584 vs
   0.516 oracle; 0.729 vs 0.589 on real detections). A user cannot tell the
   difference between a voice separator and a pitch-median split, which means
   they will notice the first time it is wrong.
3. **Two players of the same instrument — where there is no timbre difference to
   find at all — score 74% accuracy / ARI 0.19.** Most of the apparent
   performance is the clusterer reading register and partial-collision pattern,
   not timbre. The real signal is the lift over that control: **ARI +0.265.**
4. **The prerequisite fails first anyway.** In only **47.9%** of two-instrument
   mixtures does the detector find enough notes from *both* instruments to have
   anything to cluster. Mean recall on the second instrument is **38.5%**.

The one piece of good news is runtime: the whole added step is **under 1 ms**
against the 900 ms budget. Cost is not the reason to say no.

There is a genuine, measurable timbre signal in the data — it is just three to
five times smaller than it needs to be, for a mechanical reason given in §6 that
no amount of better clustering can fix.

---

## 1. What was built

**Corpus** (`test/corpus.mjs`, new exports; the existing 132-chord corpus is
byte-identical — verified by SHA-1 over every rendered chord).

324 segments, deterministic, no `Math.random()`:

| | |
|---|---|
| 4 instrument pairs | `dark+bright` (far apart), `hollow+formant` and `bright+formant` (mid), `geometric+inharmonic` (close — differ only in inharmonicity) |
| 6 identical pairs | each timbre against itself: the control with no timbre difference to find |
| 8 arrangements | 3 register-separated, 3 interleaved (incl. one where every B note is an octave above an A note, so every B partial lands on an even A partial), 2 with **shared pitches** |
| 3 levels | instrument B at 0, −6, −12 dB |
| 84 solos | 6 timbres × (8 arrangement A-parts + 6 dense voicings from the existing corpus) |

Each player is rendered into its own buffer with an independent PRNG stream and
**normalised to unit RMS before the level offset**, so "0 dB" means equally loud
rather than "equal synthesis gain" (the timbres' intrinsic energies differ by
more than 12 dB, which would otherwise have been the level axis). Player A's
samples are bit-identical whether or not player B exists.

**Fingerprints** (`test/exp/fingerprint.mjs`). For each note, the observed
amplitude and cents-deviation of partials 1–12, read by local-max search plus
parabolic refinement in a ±33 cent window.

One thing worth stating because it is not obvious: the fingerprints are read off
`yraw`, never `yw`. The NNLS front end *whitens* the spectrum — a running
mean/σ standardisation over ±1 octave whose explicit purpose is to delete the
spectral envelope, so that the same chord on two instruments fits the dictionary
the same way. The spectral envelope is also the only thing that tells two
instruments apart. **The pipeline whitens away exactly the information this
feature would need**, so the extraction has to reach back past it.

Nine feature sets were compared rather than guessed at: log partial amplitudes
(mean-removed, hence level-invariant), partials in dB relative to the
fundamental, six shape descriptors (partial-index centroid, spread, flatness,
rolloff slope, rolloff curvature, odd/even ratio), estimated inharmonicity `B`,
and combinations. Centroid and spread are in *partial-index* units, not Hz,
deliberately: an Hz centroid is dominated by the note's own pitch, so it would
cluster by register and score well for the wrong reason.

**Clustering** (`test/exp/cluster.mjs`), all from scratch: k-means (k-means++,
seeded, n restarts), agglomerative (ward / average / complete), diagonal-
covariance GMM by EM, Jacobi eigendecomposition, PCA, silhouette, Tibshirani gap
statistic, spectral eigengap with both global and local σ, BIC, ARI, and
Mann-Whitney AUC.

**Two modes for every table.** `detected` uses the notes `analyzeSegment`
actually returned, ghosts and misses included — what a shipped feature would
have to work with. `oracle` reads the same fingerprints at the true note
positions whether or not the detector found them, with the collision shares
refit by NNLS restricted to the true columns. The gap between the two columns is
what separates "clustering does not work" from "the detector never handed us the
input".

---

## 2. THE FALSE-SPLIT RATE

The number the brief asked for first, and the one that ends the discussion.

**Detected notes, 2.5 s, best fingerprint (`logPB`), 83 solo segments vs 93
two-instrument segments:**

| selector | false-split rate | 2-instrument correctly found |
|---|---|---|
| silhouette τ=0.30 | **49.4%** | 38.7% |
| silhouette τ=0.40 | **21.7%** | 20.4% |
| silhouette τ=0.55 | **4.8%** | 3.2% |
| silhouette τ=0.70 | **0.0%** | 1.1% |
| gap statistic | **61.4%** | 31.2% |
| eigengap (global σ) | **0.0%** | 0.0% |
| eigengap (local σ) | **3.6%** | 2.2% |
| GMM BIC | **83.1%** | 45.2% |

Read the two columns together. They move as one. At every threshold, the rate at
which a solo guitar chord is reported as two voices is *the same as or higher
than* the rate at which a genuine duet is correctly found. The selectors that
never false-split (eigengap, silhouette τ=0.70) also never find a real duet;
the selectors that find duets (BIC 45%) split solos 83% of the time.

The threshold table is a distraction, though, because it invites tuning. The
threshold-free statement is the AUC of each underlying statistic at separating
the 83 solos from the 93 duets:

| statistic | AUC, oracle notes | AUC, detected notes |
|---|---|---|
| silhouette | 0.700 | **0.541** |
| gap statistic | 0.522 | **0.430** |
| GMM BIC | 0.449 | **0.508** |
| eigengap, global σ | 0.861 | **0.610** |
| eigengap, local σ | 0.865 | **0.625** |

0.500 is chance. **On real detections nothing exceeds 0.64, and the two
selectors a sane implementation would reach for first — silhouette and BIC — are
at 0.54 and 0.51, which is indistinguishable from guessing.** The gap statistic
is *below* chance, i.e. it is mildly anti-correlated with the truth.

The oracle column is the interesting part: eigengap reaches 0.86 when the
detector's errors are removed. So the information is not entirely absent — it is
destroyed by the ghosts and misses documented in §5. That is a fact about this
pipeline's detection quality, not about clustering, and it means "fix the
detector first" rather than "tune the selector".

For completeness, the same statistics asked to separate a real duet from two
players of the *same* instrument — the discrimination this feature would need
to avoid telling a user their solo piano is two instruments — score **0.40 to
0.65**, i.e. chance.

---

## 3. Accuracy when the count is known

Two-instrument mixtures only, k fixed at 2, notes with ambiguous truth (ghosts,
shared pitches) excluded from scoring. n = 96 oracle, 46 detected.

**Oracle notes:**

| fingerprint | k-means acc / ARI | ward | average | GMM |
|---|---|---|---|---|
| logP | 82.6 / 0.437 | 82.0 / 0.424 | 79.2 / 0.323 | 81.6 / 0.426 |
| dbFund | 80.4 / 0.328 | 80.0 / 0.307 | 78.1 / 0.257 | 79.2 / 0.299 |
| shape | 83.8 / 0.453 | 83.8 / 0.457 | 81.8 / 0.391 | 82.7 / 0.420 |
| inharmB | 72.5 / 0.151 | 72.8 / 0.149 | 71.7 / 0.122 | 72.8 / 0.148 |
| shapeB | 84.2 / 0.475 | 83.0 / 0.420 | 81.7 / 0.392 | 82.5 / 0.426 |
| logPB | 85.1 / 0.513 | 83.6 / 0.459 | 78.5 / 0.288 | 82.7 / 0.442 |
| logPattr | 82.2 / 0.405 | 81.2 / 0.380 | 76.9 / 0.258 | 80.9 / 0.376 |
| logP6 | 76.1 / 0.224 | 75.7 / 0.207 | 74.5 / 0.182 | 76.6 / 0.246 |
| **all** | **85.2 / 0.516** | 85.1 / 0.506 | 82.0 / 0.404 | 83.9 / 0.481 |

**And the two baselines those numbers have to beat:**

| baseline | oracle | detected |
|---|---|---|
| random relabelling | 68.7% / 0.009 | 66.8% / 0.007 |
| **MIDI pitch alone** | **86.5% / 0.584** | **91.2% / 0.729** |

Note first that best-of-2-permutation accuracy at chance is **68.7%**, not 50%
— with few notes a random split matches a lot of the truth by luck. That is why
ARI, whose chance value is 0.000 by construction, is the number to read, and why
"85% accurate" in the table above is worth much less than it sounds.

Second: **a 1-D k-means on MIDI number, using no timbre information
whatsoever, beats every fingerprint in the table.** That is partly an artefact
of the corpus, and the honest breakdown is by how the two pitch sets sit against
each other:

| voicing | fingerprint (ARI) | MIDI pitch (ARI) | identical-timbre control (ARI) |
|---|---|---|---|
| separate registers | 0.560 | **1.000** | 0.266 |
| interleaved | **0.288** | 0.224 | 0.095 |
| shared pitches | **0.563** | 0.500 | 0.236 |

On register-separated voicings the pitch baseline is perfect *by construction* —
that is my corpus handing it a free win, and it should not be read as a result.
The meaningful cell is **interleaved**, the only case where pitch is not
trivially right: there the fingerprint reaches ARI 0.288 against 0.224 for
pitch. So the fingerprint does add something. It adds 0.064 ARI.

### Which fingerprint carries the signal

Ranked by ARI lift over the identical-timbre control (§4), which is the only
ranking that measures timbre rather than register:

| fingerprint | identical pair | real pairs | **lift** |
|---|---|---|---|
| **logPB** (log partials + inharmonicity) | 0.194 | 0.459 | **+0.265** |
| all | 0.284 | 0.506 | +0.221 |
| logPattr | 0.168 | 0.380 | +0.213 |
| logP | 0.225 | 0.424 | +0.199 |
| shape | 0.307 | 0.457 | +0.150 |
| inharmB | 0.055 | 0.149 | +0.094 |
| shapeB | 0.361 | 0.420 | +0.060 |
| logP6 | 0.175 | 0.207 | +0.033 |
| dbFund | 0.319 | 0.307 | **−0.012** |

- **The raw log partial series carries the signal.** Every winning variant is
  built on it.
- **Inharmonicity `B` is worth having and is not redundant.** Alone it is weak
  (ARI 0.149) because only one of the six timbres is inharmonic, but it is the
  *only* feature that separates the close pair — see §6 — and adding it to
  `logP` is the single largest improvement in the table (+0.066 ARI).
- **Normalising to the fundamental (`dbFund`) is actively harmful** — the only
  fingerprint with negative lift. It divides by the one partial most likely to be
  corrupted by a colliding note, injecting that note's error into all 11
  remaining dimensions.
- **Truncating to 6 partials destroys it** (lift 0.033). The discriminating
  information lives in partials 7–12, which is unfortunate, because those are
  the quietest and the most collided.
- **Collision attribution (`logPattr`) does not help** (+0.213 vs +0.199 for
  plain `logP`). Weighting each partial by the NNLS's own ownership share is the
  obvious fix for §6's problem and it recovers essentially none of the loss,
  because the shares are computed from a dictionary that already assumes the
  wrong spectral envelope.
- Ward, k-means and GMM are within noise of each other; average linkage is
  consistently worst.

---

## 4. The control: two players of the same instrument

144 segments in which the two players use *identical* timbres. There is no
timbral evidence to find. Whatever the method scores here it read out of
something that is not timbre.

**It scores 74.0% accuracy and ARI 0.194** with the winning fingerprint, against
83.6% / 0.459 on real pairs. So roughly **40% of the apparent ARI, and almost
all of the apparent accuracy, is not timbre.**

By timbre (accuracy on the identical control): formant 81.6%, geometric 76.0%,
dark 75.0%, inharmonic 74.3%, bright 73.6%, hollow 63.5%.

What is it reading? Register and collision pattern. A low note in a chord has
more partials inside the analysis range and receives collisions from every note
above it; a high note has fewer valid partials and is contaminated less. That
gradient correlates with the A/B split whenever the two players are not
perfectly interleaved, which is most of the time. It is a real cue and it would
work on a real duet — it is just not the cue this feature claims to use, and it
fails exactly when the two instruments share a register, which is when a user
most needs the separation.

---

## 5. Where it breaks

### The prerequisite: detection, before clustering is even reached

| slice | recall, instrument A | recall, instrument B | ghost fraction | both instruments found |
|---|---|---|---|---|
| **all mixtures** | 86.1% | **38.5%** | 30.5% | **47.9%** |
| separate registers | 86.6% | 78.2% | 24.0% | 91.7% |
| interleaved | 86.1% | **14.8%** | 34.5% | **22.2%** |
| shared pitches | 85.4% | **14.6%** | 34.4% | **20.8%** |
| B at 0 dB | 82.8% | 55.2% | 31.3% | 65.6% |
| B at −6 dB | 88.0% | 39.1% | 33.9% | 46.9% |
| B at −12 dB | 87.5% | **21.4%** | 26.4% | **31.3%** |

The detector finds the first instrument reliably and the second one less than
40% of the time. On interleaved voicings — the case where clustering would
actually be needed — it finds the second instrument's notes **14.8%** of the
time, and in only **22%** of those segments is there enough of both to cluster
at all.

This is not a new failure; it is the known 0.878 recall / 0.526 precision
baseline (`docs/STATUS.md`) meeting a chord with twice as many notes, where the
`thr=0.12` activation threshold is relative to the loudest note and `maxNotes`
caps at 12. But it means **half the `detected`-mode tables in this document are
computed on the 46 of 96 mixtures where detection happened to work**, which is a
favourable selection, and the real-world numbers are worse than they look.

30% of all detected notes across the whole corpus are ghosts. Those get
clustered too, and they have no correct answer.

### Degradation with the conditions the brief asked about

Ward, k = 2, oracle notes:

| condition | | accuracy | ARI |
|---|---|---|---|
| timbre distance | far (dark+bright) | 88.5% | 0.595 |
| | mid | 85.8% | 0.527 |
| | **close (geometric+inharmonic)** | **74.3%** | **0.186** |
| voicing | separate registers | 86.6% | 0.560 |
| | shared pitches | 88.5% | 0.563 |
| | **interleaved** | **77.3%** | **0.288** |
| level of B | 0 dB | 84.6% | 0.532 |
| | −6 dB | 82.6% | 0.412 |
| | −12 dB | 83.6% | 0.432 |

- **Close timbres are where it dies**: ARI 0.186 against an identical-timbre
  floor of 0.194. On the `geometric+inharmonic` pair the method is, within noise,
  reading nothing at all.
- **Interleaved voicings** cost 0.27 ARI against separated ones — and this is the
  oracle column, so it is not a detection effect. When the two instruments
  occupy the same register their partials collide, and §6 explains what that
  does.
- **Shared pitches** do *not* degrade the oracle score (0.563), which surprised
  me, but the reason is deflating: shared pitches are excluded from scoring
  because they belong to both instruments, so the metric simply cannot see the
  case. On real detections, shared-pitch voicings score ARI 0.200 on 5 scoreable
  segments. In practice a shared pitch is unrepresentable: one note, one cluster,
  and the harmonic-comb mask in `buildIso('notes')` would put its entire energy
  into whichever voice won it.
- **Level imbalance barely moves the oracle score**, because every fingerprint is
  level-invariant by construction. It shows up entirely in detection: recall on
  instrument B falls 55% → 21% from 0 to −12 dB, and the fraction of usable
  segments falls 66% → 31%.

### Segment length

| duration | recall B | both found | oracle ARI | detected ARI | lift over control |
|---|---|---|---|---|---|
| 2.5 s | 38.5% | 47.9% | 0.459 | 0.385 | +0.265 |
| 1.5 s | 38.0% | 47.9% | 0.484 | 0.357 | +0.303 |
| 1.0 s | 37.5% | 47.9% | 0.484 | 0.344 | +0.299 |
| 0.5 s | 38.4% | 51.0% | 0.426 | 0.338 | +0.228 |

Essentially flat. **Do not read this as "it works on half-second segments."**
The corpus notes are steady sustained tones with 2–4 s decay constants, so a
0.5 s slice contains the same partial structure as a 2.5 s slice — the duration
axis is under-stressed by this corpus. Real audio would lose partials to
vibrato, note changes and reverb tails. What the table does establish is that
nothing in the *method* needs a long window; if it fails at 0.5 s on real audio
it will be for a reason this corpus cannot show.

### Clustering stability

k-means at k = 2 over 20 seeds, oracle notes:

| | segments giving more than one partition | mean modal share |
|---|---|---|
| 1 k-means++ init | **99.0%** | 0.497 |
| 10 restarts | **27.1%** | 0.968 |

A naive single-init k-means gives a *different answer nearly every run* — the
modal partition wins half the seeds. With 10 restarts it stabilises for most
segments, but **27% of segments still return more than one partition across
seeds**, meaning a quarter of the time the user could press analyze twice and get
two different voice assignments. Ward is deterministic and should be preferred
for that reason alone; its accuracy is within noise of k-means anyway.

---

## 6. Why it fails — the mechanism

This is the measurement that explains all the others
(`test/exp/isolated.mjs`).

**Step 1 — the fingerprints work perfectly on isolated notes.** 20 pitches × 6
timbres, each note played completely alone, leave-one-out 1-NN over 6 classes
(chance 16.7%):

| fingerprint | 6-way 1-NN accuracy | within-timbre spread | between-timbre distance |
|---|---|---|---|
| logP | **100.0%** | 1.063 | 4.666 |
| logPB | **100.0%** | 1.218 | 5.011 |
| shapeB | **100.0%** | 1.212 | 3.642 |
| all | **100.0%** | 1.656 | 6.002 |
| shape | 99.2% | 1.042 | 3.220 |
| inharmB | 45.8% | 0.318 | 0.921 |

So the idea is sound. A note's partial profile identifies its instrument, and
does so with a 4:1 margin between timbres and across register.

**Step 2 — polyphony from the same instrument destroys it.** Take a note played
inside a chord by one instrument, and measure how far its fingerprint has moved
from the same note played alone by the same instrument. That displacement is
caused entirely by partials of the *other notes of the same instrument* landing
on it:

| fingerprint | in-chord displacement | between-timbre distance | SNR |
|---|---|---|---|
| shape | 1.204 | 3.220 | 2.674 |
| dbFund | 1.650 | 4.350 | 2.636 |
| shapeB | 1.640 | 3.642 | 2.220 |
| all | 3.120 | 6.002 | 1.924 |
| logP | 2.576 | 4.666 | 1.811 |
| logPB | 2.854 | 5.011 | 1.755 |

An SNR above 1 is the bare minimum for any clusterer to work at all. The best is
2.7. And it degrades with polyphony exactly as predicted:

| notes sounding | fingerprint displacement (`shape`) |
|---|---|
| 3 | 0.956 |
| 4 | 1.320 |
| 6 | 1.565 |

**Step 3 — and the mean between-timbre distance hides the pairs that matter.**
Broken out per pair, with SNR = that pair's separation divided by the in-chord
displacement:

| fingerprint | dark+bright | geom+inharm | hollow+formant | bright+formant |
|---|---|---|---|---|
| logP | 3.204 | **0.491** | 2.083 | **0.914** |
| shape | 4.651 | **0.563** | 3.358 | 1.848 |
| logPB | 2.897 | **0.971** | 1.880 | **0.826** |
| shapeB | 3.428 | 1.554 | 2.466 | 1.357 |
| inharmB | 0.463 | **2.855** | 0.078 | 0.075 |

**For `geometric+inharmonic`, the SNR of every envelope-based fingerprint is
below 1**: the two instruments are closer to each other than a single one of
them is to itself when it plays a chord. No clustering algorithm can recover
that. Only `inharmB` sees this pair (SNR 2.855), because inharmonicity is
literally the only thing that differs — which is why `shapeB` and `logPB` win
overall, and why no single fingerprint dominates: **the feature that separates
one pair is noise for the others.**

This is the whole story. A note's observed partial series is not that note's
timbre; it is that note's timbre plus every colliding partial from every other
note in the segment. In Western harmony the other notes are octaves, fifths and
thirds away, which is precisely the arrangement that maximises collision. The
fingerprint is measuring the chord as much as the instrument.

Worth noting that this corpus is *generous* on one axis: five of the six timbres
have partial amplitudes that are identical at every pitch. Real instruments have
fixed formants, so the same instrument's fingerprint changes across its range —
which is what the `formant` timbre models, and it is the timbre with the highest
identical-pair score (81.6%, i.e. most easily split when it should not be).
Real instruments would add within-instrument scatter on top of everything above.

---

## 7. Runtime

Not the problem. Against the ~1 s budget for the added step:

| step | mean | max |
|---|---|---|
| partial-profile extraction (all detected notes) | 0.15 ms | 0.62 ms |
| features + ward + silhouette | 0.24 ms | 0.68 ms |
| features + ward + all four count selectors | 5.37 ms | 12.71 ms |
| *(`analyzeSegment` itself, for scale)* | *102 ms* | — |

The shippable configuration costs **under 1 ms**. Even the expensive
configuration, with a 25-draw gap statistic and a GMM/BIC sweep, is 13 ms
worst-case — 1.4% of the budget.

---

## 8. What would have to change

Not recommendations to act on — the verdict is no — but a record of what the
measurements say the blockers actually are, in order:

1. **Detection recall on the quieter instrument (38.5%).** Nothing downstream
   matters until a segment reliably yields notes from both players. This is the
   existing `thr`/`maxNotes`/whitening work in `docs/STATUS.md`, not a
   clustering problem.
2. **Per-partial source separation before fingerprinting.** The fingerprint needs
   each note's *own* partial amplitudes, and a single averaged spectrum cannot
   provide them. The physically available handle is time: two instruments have
   different attack and decay envelopes, so per-frame partial tracking would let
   a partial be attributed by *how it behaves over time* rather than by a
   static ownership ratio. That is handoff Task 4 (per-frame fitting) and it is a
   much larger build than this experiment assumed.
3. **A blind count statistic that works.** The eigengap reaching AUC 0.86 on
   oracle notes and 0.63 on real ones says the ceiling here is set by detection
   quality, so this follows (1) rather than needing its own idea.

And a note on the resynthesis end, which this experiment did not reach: even a
perfect clustering would feed `buildIso('notes')`, whose harmonic-comb mask
keeps ±50 cents around each partial. Where two voices share a partial the mask
cannot split it, so a correctly-clustered shared pitch would still be audibly
wrong. RESEARCH.md §5 already says this ("it bleeds where partials collide —
that's physics"); the clustering does not change it.

For actually separating instruments, RESEARCH.md §5's ladder still holds and
Tier 4 (neural demixing, server-side) is still the honest answer.
