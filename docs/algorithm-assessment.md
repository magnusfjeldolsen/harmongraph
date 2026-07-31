# Assessment — note identification in Harmonograph

An independent review of the NNLS note-detection pipeline, written against
`test/harness.mjs` rather than against intuition. Every number below was
produced on this branch and can be reproduced with the commands quoted.

Companion documents: `RESEARCH.md` (architecture), `handoff.md` (a prior
research pass). Where this document and `handoff.md` disagree, the
disagreement is stated and measured.

**No shipped code was changed on this branch.** Every variant below was measured
through a throwaway copy of the pipeline under `test/exp/`, with each candidate
fix behind a flag, so that `js/` stayed byte-identical to `master` and the
baseline could not drift. That scaffolding was deleted before commit; the branch
contains this document and nothing else. To reproduce, recreate
`test/exp/segment.mjs` as a copy of `js/analyzeSegment.js` with the named flag
added — each section states the exact flag, the file it belongs in, and the line
it changes. The unmodified baseline reproduces today with
`node test/harness.mjs --compare baseline.json` (all deltas +0.000).

---

## 0. Verdict

**The handoff's plan is aimed at the wrong half of the problem.**

The handoff spends its ranking on ghosts that are *harmonic relatives* of real
notes — octave collapse, fifth/twelfth confusion — and proposes redundancy
pruning as the headline fix. Those ghosts are real and pruning does help. But
**38% of all ghosts (182 of 480) sit below the chord's lowest true note**, and a
large share of those are not harmonic relatives of anything. They are
**noise promoted to signal by the whitener**, and no amount of redundancy
pruning, L1 raising or evidence protection can touch them, because they are
individually well-supported by the whitened spectrum the whole pipeline reasons
about.

The handoff never mentions this failure mode. It is the single largest
correctable defect in the pipeline, it is a four-line fix, and it is free.

Second, **one of its three "do not attempt" negative results is wrong**, and it
is wrong in an instructive way. Auto-fitting the decay `s` failed for exactly the
reason the handoff diagnoses — no complexity penalty — and the handoff even names
the fix ("would need AIC/BIC") before filing the idea under *do not attempt*. Add
the penalty it names and the same idea becomes the **single best-scoring change I
measured** (§E). The `evidRaw` variant in §A is a second instance of the same
pattern: a sound idea rejected because of one badly chosen constant. The
handoff's negative-results table does not distinguish "the idea is wrong" from
"my first parameterisation was wrong", and at least two entries are the latter.

Third, its credibility as a source of *numbers* is poor. It cites a corpus and
harness that were never delivered. Its §2 baseline (precision 0.749) does not
reproduce here (0.526) on a harness that does exist, its Task 2 table does not
reproduce (§C), and its §2 claim about what drives ghosts is a category error
that its own example contradicts (§D). Its *reasoning* is frequently good — Task
2's mechanism is genuinely correct and Task 1 reproduces exactly — so read it for
hypotheses, never for measurements.

**What I would do instead, in order:**

1. **Floor the whitening σ** (§A). ~4 lines, F1 +0.132, no recall cost, no
   runtime cost.
2. **Auto-fit the decay with a BIC penalty** (§E). ~25 lines, +7 ms, a further
   F1 +0.075 — the handoff's rejected idea, repaired.
3. **Redundancy pruning** (§C) — the handoff's Task 2, which is real. But note
   it is a *substitute* for 2, not a complement: stacking both buys no F1 and
   costs 84 true notes. Ship it as the strictness slider it proposes.
4. Correct RESEARCH.md §10's multi-template recommendation (§B): measured dead
   along the axis anyone has actually tried, for a sharper reason than either
   document gives.
5. Everything else in the handoff is small, unmeasurable as specified, or
   measures the wrong thing.

Together, 1 + 2 take the harness from **F1 0.658 to 0.865** — precision
0.526 → 0.878 at a cost of 0.025 recall — in 103 ms/chord against a 900 ms
budget.

---

## A. The low-frequency noise ghosts — confirmed, and the fix is free

### The mechanism, stated precisely

`whiten()` (`js/dsp/nnls.js:44-54`) standardises each log-frequency bin against
the running mean and standard deviation of a ±1-octave window:

```js
out[i]=Math.max(0,(y[i]-mu)/Math.sqrt(va));           // nnls.js:51
```

with `va` floored only at `1e-12` (`nnls.js:50`) — numerically, not physically.
In a band containing no chord energy the local σ collapses to the noise floor,
so the ratio is scale-free: the whitener divides the noise by itself and returns
a z-score indistinguishable from a real partial's.

The fundamental-evidence gate then reads that same whitened spectrum
(`js/analyzeSegment.js:95-101` — `ym` is the max of `yw`, and `evid[i]` is
`yw` at the fundamental over `ym`), so the one check specifically designed to
reject invented notes is computed in the coordinate system that invented them.
`gate: 0.08` is a threshold on a quantity that has had absolute level divided
out of it.

### The signature: amplitude invariance

A clean C4/E4/G4 triad with white noise added at levels spanning 60 dB
(`test/exp/probe.mjs`, run on the shipped `analyzeSegment`):

```
noise dBFS   detected                       ghosts below the bass (whitened / raw at f0)
    none     30 60 64 67                    30  w=0.15  raw=1.3e-6
     -80     21 22 36 60 64 67              21  w=0.24  raw=5.6e-6
     -60     23 24 28 36 60 64 67           23  w=0.21  raw=6.9e-5
     -54     23 24 28 36 43 60 64 67        23  w=0.19  raw=1.4e-4
     -48     23 28 36 43 60 64 67           23  w=0.17  raw=2.8e-4
     -40     23 28 36 43 60 64 67           23  w=0.17  raw=6.9e-4
     -30     23 28 36 43 60 64 67           23  w=0.16  raw=2.2e-3
     -20     23 28 36 43 60 64 67           23  w=0.16  raw=6.9e-3
```

Read the two right-hand columns. Across the added-noise rows alone the **raw**
energy at the ghost's fundamental moves by a factor of 1230 — 62 dB, tracking the
noise level almost exactly — and 5300× (74 dB) counting the no-noise row. The
**whitened** value the gate actually reads sits still at 0.16–0.24 throughout.
The gate is 0.08. Every one of these passes at every level, including at
**−80 dBFS**, which is inaudible, and including with **no added noise at all**,
where spectral leakage alone is enough.

This is not a threshold that is set too low. It is a threshold on a quantity
that carries no information about whether anything is actually sounding.

### The fix, measured

Floor the whitening σ at a global noise estimate. In
`test/exp/segment.mjs::whitenF`, `wfloor` floors the local variance at
`(wfloor · rms(yraw))²`, i.e. the local σ may not fall below a fixed fraction of
the whole log-spectrum's RMS. Four lines inside `whiten()`.

`node test/exp/sweep.mjs` over the full 132-chord corpus. `below` counts
ghosts under the chord's lowest true note:

| config | recall | prec. | F1 | oct | 5th | oth | below | ghosts | conf-gap | ms |
|---|---|---|---|---|---|---|---|---|---|---|
| shipped baseline | 0.878 | 0.526 | 0.658 | 198 | 181 | 101 | **182** | 480 | +0.12 | 100 |
| wfloor 0.0003 | 0.875 | 0.566 | 0.687 | 176 | 162 | 69 | 148 | 407 | +0.18 | 100 |
| wfloor 0.001 | 0.876 | 0.631 | 0.734 | 143 | 131 | 36 | 52 | 310 | +0.30 | 99 |
| wfloor 0.003 | 0.876 | 0.670 | 0.759 | 124 | 113 | 25 | 5 | 262 | +0.38 | 98 |
| wfloor 0.01 | 0.876 | 0.674 | 0.762 | 123 | 112 | 22 | 2 | 257 | +0.39 | 99 |
| **wfloor 0.03** | **0.878** | **0.678** | **0.765** | **120** | **111** | **22** | **2** | **253** | **+0.39** | **99** |
| evidRaw (gate on `yraw`) | 0.863 | 0.685 | 0.764 | 117 | 109 | 15 | 1 | 241 | +0.38 | 99 |
| wfloor 0.003 + evidRaw | 0.861 | 0.678 | 0.759 | 117 | 113 | 18 | 1 | 248 | +0.40 | 99 |

**+0.107 F1 at zero recall cost and zero runtime cost.** Sub-bass ghosts
182 → 2. Precision 0.526 → 0.678.

This first sweep stops at `wfloor 0.03` because that is where the *sub-bass ghost
count* saturates. It is not the best setting — the gain keeps growing past the
point where the noise ghosts are gone, for a reason worth understanding, and the
recommended value ends up being **0.3** (F1 0.790). That comes two subsections
below, after ruling out a confound that would otherwise invalidate the whole
table.

Three things worth pulling out first.

**It also removes octave and fifth errors it has no business removing.** Octave
errors 198 → 120, fifths 181 → 111. Those ghosts are not below the bass, so the
whitening floor should not reach them. The explanation is that the sub-bass
ghosts were *competing in the fit*: a spurious low note's harmonic series covers
the whole chord, so removing it changes which columns explain the mid-register
energy. The mechanism is one defect, but it was corrupting the fit globally, not
just adding junk at the bottom.

**It fixes the `dark` confidence inversion for free.** Per-timbre, `dark` goes
from `P(real)` 0.68 hit / 0.89 ghost (inverted) to 0.68 / 0.31, and overall
conf-gap 0.12 → 0.39. That is handoff **Task 3's entire acceptance criterion**
("conf-gap ≥ 0.35, positive on every timbre including `dark`") met by a change
to the whitener, with no per-frame envelope correlation and no extra
computation. Task 3 was solving a symptom of this bug. See §F.

| timbre | baseline F1 | wfloor 0.03 F1 | baseline P(real) hit/ghost | wfloor 0.03 |
|---|---|---|---|---|
| geometric | 0.793 | 0.878 | 0.78 / 0.74 | 0.78 / 0.36 |
| bright | 0.589 | 0.669 | 0.82 / 0.61 | 0.84 / 0.44 |
| dark | 0.719 | **0.938** | 0.68 / 0.89 *inverted* | 0.68 / 0.31 |
| hollow | 0.631 | 0.730 | 0.78 / 0.58 | 0.79 / 0.39 |
| formant | 0.530 | 0.609 | 0.82 / 0.58 | 0.85 / 0.39 |
| inharmonic | 0.745 | 0.856 | 0.78 / 0.74 | 0.80 / 0.37 |

No timbre regresses on F1, octave errors or fifth errors. `dark` — the timbre
with the least energy above f0, therefore the widest dead bands, therefore the
most exposed to this bug — improves most (+0.219 F1), which is exactly what the
mechanism predicts. That prediction being borne out is the strongest evidence
the diagnosis is right and not a lucky threshold.

**Computing `evid` on the raw spectrum instead is *not* the right fix.** It
scores the same overall F1 (0.764) but buys it by cutting recall on `formant`
from 0.832 to 0.743 — 26 misses against 17. That is predictable: `evid` is
normalised by the spectral *maximum*, and `formant`'s defining property is that
f0 is never the loudest partial, so a real note's fundamental legitimately sits
far below the max. An absolute gate relative to the global peak punishes exactly
the instruments whose fundamentals are weak. Floor the whitener; don't move the
gate.

### Ruling out the obvious confound

Raising the σ floor shrinks the whole whitened vector, and `nnls` is called with
a **fixed** L1 of `0.004` (`js/analyzeSegment.js:85`). A smaller `yw` against a
fixed L1 is an effective *increase* in regularisation — so some of the gain
above could just be handoff Task 1's "raise L1" in disguise. That has to be
ruled out before any of this is believable.

Control: rescale `yw` to unit max after whitening (`wnorm`), which makes
`wfloor` change the *shape* only and leaves the effective L1 constant.

| config | recall | prec. | F1 | oct | 5th | below | ghosts | conf-gap |
|---|---|---|---|---|---|---|---|---|
| base | 0.878 | 0.526 | 0.658 | 198 | 181 | 182 | 480 | +0.12 |
| base + wnorm (control) | 0.878 | 0.530 | 0.661 | 194 | 178 | 181 | 471 | +0.12 |
| **base + L1 0.004 → 0.10** | 0.876 | 0.542 | 0.670 | 183 | 170 | 174 | 448 | +0.12 |
| wnorm + wfloor 0.01 | 0.876 | 0.676 | 0.763 | 122 | 110 | 2 | 254 | +0.39 |
| wnorm + wfloor 0.1 | 0.878 | 0.690 | 0.773 | 116 | 103 | 2 | 239 | +0.39 |
| wnorm + wfloor 0.3 | 0.878 | 0.722 | 0.792 | 97 | 96 | 2 | 205 | +0.41 |
| wnorm + wfloor 1.0 | 0.855 | 0.781 | 0.816 | 90 | 49 | 0 | 145 | +0.40 |
| wnorm + wfloor 3.0 | 0.799 | 0.787 | 0.793 | 84 | 42 | 0 | 131 | +0.31 |

`wnorm` alone is neutral (+0.003 F1), so the control is valid, and the whole
effect survives it. **The gain is not an L1 effect.**

Two things fall out of this table.

**The handoff's Task 1 reproduces, and it is as marginal as it says.** L1
0.004 → 0.10 moves precision +0.016 (the handoff claimed +0.013) and F1 +0.012,
for free. Real, correctly characterised, and roughly one tenth the size of §A.
Credit where it is due: this is the one handoff number that reproduces.

**The optimum is bracketed on both sides, which tells you what the whitener is
actually for.** Push the floor past ~1.0 and it binds everywhere; whitening
degenerates into plain local-mean subtraction and recall falls (0.878 → 0.799 at
`wfloor 3`). So local *variance* normalisation is doing genuine work in bands
that contain signal, and is doing pure harm only in bands that do not. That is
exactly the "floor it, don't remove it" story, and having the failure appear at
*both* ends is much better evidence than a monotone curve would have been.

### Choosing the constant

- `wfloor 0.3` — F1 0.658 → **0.790**, recall unchanged at 0.878, ghosts
  480 → 209. My recommendation: it costs nothing that was working.
- `wfloor 1.0` — F1 **0.816**, but recall 0.878 → 0.855 (74 → 88 misses). Better
  F1, but it buys precision with notes the user actually played. I would expose
  this end of the range through the existing threshold control rather than
  make it the default.

The curve is broad between 0.1 and 1.0 — a factor of ten in the constant moves
F1 by 0.04. That insensitivity is what you want from a noise floor and is why I
am comfortable recommending it without a real-audio corpus to tune against.

### An equally good fix, and why I prefer the whitening floor anyway

The separability data (`test/exp/evidsep.mjs`) shows the two populations are not
merely separable but *trivially* separable on raw energy:

| kind | n | p05 | p25 | median | p75 | p95 |
|---|---|---|---|---|---|---|
| hits | 532 | 1.1e-1 | 4.9e-1 | 6.8e-1 | 9.4e-1 | 1.0 |
| ghosts within range | 298 | 1.2e-4 | 1.2e-1 | 3.0e-1 | 6.0e-1 | 1.0 |
| ghosts below the bass | 182 | 9.6e-5 | 1.5e-4 | **2.3e-4** | 3.7e-4 | **5.8e-4** |

The sub-bass ghosts' 95th percentile (5.8e-4) is **190× below** the hits' 5th
percentile (1.1e-1). Any threshold in `[1e-3, 3e-2]` keeps **100% of hits** and
kills **99% of sub-bass ghosts**, and incidentally 12% of in-range ghosts too:

```
raw-evidence     hits kept      in-range ghosts   sub-bass ghosts
   1e-4        532/532 (100%)    290/298 (97%)     171/182 (94%)
   3e-4        532/532 (100%)    263/298 (88%)      58/182 (32%)
   1e-3        532/532 (100%)    262/298 (88%)       2/182 ( 1%)
   3e-2        532/532 (100%)    252/298 (85%)       2/182 ( 1%)
```

Measured as a gate ANDed on top of the existing one: `rawGate 1e-3` gives F1
0.759 at recall **0.878 — no recall cost at all**, on any timbre including
`formant`. This also explains why the `evidRaw` variant above lost formant
recall: it was not the idea that failed, it was reusing `gate: 0.08` as the
threshold, and `formant`'s hits have a raw-evidence 5th percentile of **0.071**,
just under it. A threshold of 1e-3 — two orders of magnitude lower — is entirely
safe. That is a good example of a sound idea being discarded because of a badly
chosen constant, and it is worth remembering when reading the handoff's negative
results.

I still prefer the whitening floor, for three reasons: it scores higher
(0.790 vs 0.759), it fixes the *fit* rather than filtering its output — so the
227 octave and fifth ghosts that disappear as a side effect actually disappear —
and it is a change to one function rather than a new post-filter stage. `rawGate`
is the better fallback if the floor ever proves to have a real-audio problem.

**What would falsify this.** A recording with a genuinely quiet low bass note
under a loud mid-register chord, more than ~40 dB below the spectral RMS. The
floor would suppress it. The corpus has low bass (`low-bass-C1`, MIDI 24) but
never *quiet* low bass, and it has one fixed noise level (`corpus.mjs:168`,
`pk*0.0035` ≈ −49 dBFS). Both belong in the corpus and neither is there. This
is the honest risk in the recommendation.

---

## B. The multi-template dictionary — settled, with a sharper reason than either document gives

RESEARCH.md §10 (fix 2) recommends "2–3 basis templates per key spanning
plausible pluck positions". Handoff §3 claims that idea drops precision
0.728 → 0.551. Neither is backed by anything reproducible, so I implemented it
(`test/exp/segment.mjs::buildDictN`, `decays` flag) and ran eleven variants.

### On the shipped baseline

| config | recall | prec. | F1 | oct | 5th | below | miss | ghosts | ms |
|---|---|---|---|---|---|---|---|---|---|
| baseline (1 template) | 0.878 | 0.526 | **0.658** | 198 | 181 | 182 | 74 | 480 | 96 |
| 3 templates, s ∈ {0.60, 0.72, 0.86} | 0.901 | 0.489 | 0.634 | 227 | 217 | 202 | 60 | 570 | 125 |
| 3 templates + group lasso 0.02 | 0.901 | 0.496 | 0.640 | 220 | 211 | 200 | 60 | 555 | 125 |
| 3 templates + group lasso 0.08 | 0.899 | 0.517 | 0.656 | 203 | 194 | 194 | 61 | 510 | 125 |
| 3 templates + per-note exclusivity | 0.908 | 0.482 | 0.630 | 234 | 225 | 199 | 56 | 590 | 128 |
| 3 templates + L1 retuned to 0.03 | 0.903 | 0.497 | 0.641 | 218 | 211 | 200 | 59 | 553 | 125 |
| 2 templates, s ∈ {0.65, 0.82} | 0.893 | 0.503 | 0.644 | 210 | 204 | 198 | 65 | 534 | 106 |

**The handoff's direction is right; its magnitude is not.** It claims precision
falls 0.728 → 0.551, a 24% relative collapse. Measured here: 0.526 → 0.489, a 7%
relative drop — same sign, a third of the size. And its stated cause
("overcomplete dictionary is degenerate; more ways to explain the same energy
means more ghosts") is at best half the story, as the per-timbre table below
shows.

Worth noting against its framing: **recall rises every time** (0.878 → 0.901,
misses 74 → 60). The extra templates genuinely find more real notes. The handoff
records this as "recall gained only +0.05"; the honest reading is that the idea
does something real and pays too much for it.

### The fair test: on top of the §A and §C fixes

The table above is contaminated. It measures a wider dictionary against a
baseline in which 38% of ghosts are whitening noise — and note that `below`
*rises* 182 → 202, so part of multi-template's apparent precision cost is §A's
bug, not dictionary degeneracy. The decisive test is whether it still loses once
the pipeline is fixed.

| config | recall | prec. | F1 | oct | 5th | miss | ghosts | ms |
|---|---|---|---|---|---|---|---|---|
| wfloor 0.3 | 0.878 | 0.718 | 0.790 | 99 | 97 | 74 | 209 | 96 |
| wfloor 0.3 + multi3 | 0.904 | 0.646 | 0.754 | 147 | 132 | 58 | 300 | 116 |
| **wfloor 0.3 + prune 0.07** | 0.800 | 0.915 | **0.854** | 27 | 18 | 121 | 45 | 96 |
| wfloor 0.3 + prune 0.07 + multi3 | 0.832 | 0.796 | 0.814 | 72 | 56 | 102 | 129 | 117 |
| … + group lasso 0.08 | 0.833 | 0.812 | 0.822 | 64 | 52 | 101 | 117 | 117 |
| … + 2 templates instead of 3 | 0.814 | 0.844 | 0.829 | 50 | 40 | 113 | 91 | 100 |

**It loses in all eleven variants, before and after the fixes.** Group sparsity
narrows the gap (0.814 → 0.822) but never closes it. Per-note exclusivity makes
it worse. Retuning L1 for the wider dictionary does not rescue it. The deficit
survives removal of the confound.

That is a definite answer to the question posed: for **this** form of the idea —
several *decay rates* per key — the failure is fundamental, not an artifact of
how it was tried.

### But the reason is not "overcomplete dictionaries are degenerate"

Per-timbre F1, against `wfloor 0.3 + prune 0.07`:

| timbre | single template | + multi3 | verdict |
|---|---|---|---|
| geometric | 0.885 | **0.904** | helped |
| dark | 0.885 | **0.932** | helped |
| bright | 0.818 | 0.792 | hurt |
| inharmonic | 0.922 | 0.911 | hurt |
| hollow | 0.860 | 0.806 | hurt |
| formant | 0.756 | **0.575** | destroyed |

**Multiple decay rates help exactly the two timbres that did not need help, and
hurt every timbre the idea was proposed to fix.**

The reason is that `{s^(h-1)}` is the wrong axis to widen along.
`geometric` and `dark` *are* members of that family — pure geometric rolloffs at
s = 0.72 and s = 0.45 (`test/corpus.mjs:80, 90`) — so a second template at
s = 0.60 models `dark` genuinely better and is rewarded. But:

- `hollow` is a **comb**: odd partials at full level, evens 26 dB down
  (`test/corpus.mjs:98-101`). No geometric decay rate, and no *non-negative*
  mixture of three of them, can put a null at h = 2. NNLS mixtures can only
  interpolate between smooth rolloffs; a notch is outside their convex hull.
- `formant` is a **resonance** at 900 Hz with the fundamental pushed down
  (`test/corpus.mjs:104-120`). Also outside the family, in a different direction.

So the three-template dictionary pays the full degeneracy cost — three ways to
explain every note — and buys modelling power only along the one direction where
a single template was already adequate. That is a sharper claim than the
handoff's, it explains a per-timbre pattern the handoff never reports, and it
predicts that `formant`, which is furthest from the family, should be hurt worst.
It is: 0.756 → 0.575.

### What this means for the two documents

**Handoff §3's negative result: confirmed, and strengthened.** Do not add
decay-rate templates. The magnitude it quotes is wrong; the conclusion is right.

**RESEARCH.md §10 fix 2: correct it, but not to "tried and failed".** Its actual
recommendation is templates spanning *pluck positions* — the comb family
`∝ (1/h²)·sin(πhβ)` — which is a **different template family** from decay rates,
and neither the handoff nor I tested it. `hollow` is in effect a
pluck-at-the-midpoint comb, and it is one of the timbres decay-rate templates
hurt, so §10's diagnosis of the *problem* survives even though the handoff's
rebuttal does not address the fix §10 actually proposed. The honest correction
is: *the decay-rate variant is measured dead; the pluck-comb variant is untested;
and since every measured attempt to widen this dictionary has cost more precision
than it gained, the prior on it should be poor.*

### What I would do instead of widening the dictionary at all

Estimate the spectral envelope rather than enumerating it. Fit once with the
current 88 columns; take the confidently detected notes; read the observed
amplitudes at *their own* partials to estimate one smooth per-segment envelope
`g(·)` — the instrument's response, which is a property of the source, not of
each key; re-weight the single dictionary by `g` and refit.

That covers `formant` and `bright` directly, covers `hollow` if `g` is indexed by
harmonic number rather than by frequency, costs one extra NNLS pass instead of
tripling the column count, and introduces **no** degeneracy because the
dictionary stays 88 columns wide. It is also the principled version of what
handoff §3 says an auto-fitted `s` would need ("envelope estimation from
already-detected notes") — the handoff names the idea in passing and then never
ranks it.

I did not implement this. It is my main speculative recommendation and it is
flagged as speculative in the ranking.

---

## C. Redundancy pruning — the handoff's Task 2 is real

Implemented as specified (`test/exp/segment.mjs`, `prune` flag): greedy backward
elimination over the post-gate candidate set, refit without each candidate, drop
the one whose removal costs least relative residual, stop when the cheapest
removal exceeds `PRUNE_TOL`.

| config | recall | prec. | F1 | oct | 5th | oth | below | miss | ghosts | conf-gap | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 0.878 | 0.526 | 0.658 | 198 | 181 | 101 | 182 | 74 | 480 | +0.12 | 96 |
| prune 0.02 | 0.837 | 0.611 | 0.706 | 131 | 127 | 65 | 138 | 99 | 323 | +0.10 | 96 |
| prune 0.05 | 0.787 | 0.806 | 0.796 | 46 | 52 | 17 | 51 | 129 | 115 | +0.11 | 97 |
| prune 0.10 | 0.658 | 0.930 | 0.771 | 15 | 11 | 4 | 11 | 207 | 30 | +0.16 | 96 |
| wfloor 0.3 (§A) | 0.878 | 0.718 | 0.790 | 99 | 97 | 13 | 2 | 74 | 209 | +0.41 | 96 |
| **prune 0.05 + wfloor 0.3** | **0.814** | **0.862** | **0.837** | **43** | **35** | **1** | **0** | 113 | **79** | **+0.39** | **96** |

**The mechanism is correct and the handoff deserves credit for it.** Octave
errors 198 → 46 and fifths 181 → 52 at `PRUNE_TOL 0.05`; the runtime cost is
**unmeasurable** (96 → 97 ms/chord), exactly as predicted, because the sub-fits
are ≤ 12 columns. The strictness-slider proposal is well supported by the shape
of the sweep: `0.02 → 0.10` traces recall 0.837 → 0.658 against precision
0.611 → 0.930, which is a genuinely useful user-facing trade rather than a
parameter with one correct value.

Three corrections to how the handoff presents it.

**The quoted numbers do not reproduce.** Handoff Task 2 claims prune 5% gives
recall 0.808 / precision 0.864 / F1 0.835 / 39 octave / 16 fifth errors. Here
prune 5% *alone* gives 0.787 / 0.806 / 0.796 / 46 / 52. The claimed figures are
in fact close to what we measure for prune 0.05 **combined with** the §A
whitening floor (0.814 / 0.862 / 0.837 / 43 / 35). That is a coincidence, not
evidence the handoff knew about §A — but it is a reminder that its table
describes a pipeline nobody can inspect.

**Pruning costs real notes, and more than the handoff admits.** Misses go
74 → 129 at `PRUNE_TOL 0.05` — from 12% of true notes to 21%. The handoff frames
this as "recall drops ~5 points because genuine octave doublings really are
redundant", which is true as far as it goes; but on `dark` recall falls
0.901 → 0.703, and that timbre has no unusual octave doublings. Pruning removes
notes whose evidence is thin for any reason, not only doubled octaves.

**Pruning alone makes the confidence readout worse.** With `prune 0.05` the
`P(real)` gap is inverted on `geometric` (0.81 hit / 0.86 ghost), `dark`
(0.75 / 0.89) *and* `inharmonic` (0.80 / 0.86) — three inverted timbres, up from
one at baseline; overall gap 0.12 → 0.11. This is a selection effect and it is
predictable: pruning preferentially removes the ghosts that were easiest to
identify, so the mean `pFund` over the survivors rises. Anyone shipping Task 2 on
its own would have improved F1 while making the tool's confidence display worse,
and would then have found Task 3's acceptance criterion *harder* to meet, not
easier.

Combined with §A none of that happens — no inverted timbre, gap holds at +0.39,
every timbre improves:

| timbre | baseline F1 | prune 0.05 + wfloor 0.3 | ghosts | P(real) hit/ghost |
|---|---|---|---|---|
| geometric | 0.793 | 0.889 | 36 → 4 | 0.80 / 0.49 |
| bright | 0.589 | 0.798 | 105 → 21 | 0.86 / 0.48 |
| dark | 0.719 | 0.891 | 61 → 1 | 0.72 / 0.35 |
| hollow | 0.631 | 0.829 | 92 → 12 | 0.83 / 0.37 |
| formant | 0.530 | 0.717 | 132 → 35 | 0.91 / 0.42 |
| inharmonic | 0.745 | 0.914 | 54 → 6 | 0.82 / 0.47 |
| **OVERALL** | **0.658** | **0.837** | **480 → 79** | **0.86 / 0.44** |

**Order matters: do §A first.** §A costs no recall; pruning does. Applying
pruning to a candidate set that still contains 182 noise ghosts spends the
elimination budget on them — which is why `prune 0.05` alone still leaves 51
sub-bass ghosts and why its recall cost is so high. Fix the fit, then prune the
genuine ambiguity that remains.

---

## D. What actually dominates the ghost population

The handoff's §2 claims: *"Timbre mismatch, not octave collapse, is the largest
single driver of ghosts."* That sentence is a category error, and its own
supporting example contradicts it.

**Timbre mismatch is a cause. Octave collapse is a manifestation.** They are not
alternatives, so "X, not Y" cannot be evaluated as stated. The handoff itself
writes two lines later that `formant` "produces 20 octave errors" *because* its
fundamental is not the loudest partial — that is timbre mismatch manifesting
precisely as octave collapse. We measure 67 octave errors on `formant`, and it
is the single largest cell in the whole table.

Here is the decomposition, done both ways (`test/exp/ghosts.mjs`).

### By manifestation — position × harmonic relation

| timbre | sub-oct | sub-5th | sub-free | in-* | top-oct | top-5th | top-free | total |
|---|---|---|---|---|---|---|---|---|
| geometric | 5 | 11 | 4 | 0 | 7 | 7 | 2 | 36 |
| bright | 12 | 7 | 11 | 0 | 39 | 25 | 11 | 105 |
| dark | 10 | 9 | 9 | 0 | 10 | 9 | 14 | 61 |
| hollow | 9 | 11 | 9 | 0 | 14 | 40 | 9 | 92 |
| formant | 10 | 17 | 16 | 3 | 55 | 26 | 5 | 132 |
| inharmonic | 13 | 11 | 8 | 0 | 12 | 7 | 3 | 54 |
| **TOTAL** | **59** | **66** | **57** | **3** | **137** | **114** | **44** | **480** |
| share | 12% | 14% | 12% | 1% | 29% | 24% | 9% | |

Three findings the handoff does not contain:

1. **Ghosts are never inside the chord.** 3 of 480 — 0.6% — fall between the
   bass and the top note. Every other ghost is *below the bass* (182, 38%) or
   *above the top note* (295, 61%). Inside the range the true notes already
   explain the energy and NNLS has no residual to spend. This is a strong
   structural regularity and nothing in the pipeline exploits it. It is also
   the reason redundancy pruning works at all (§C).

2. **57 ghosts (12% of all, 31% of the sub-bass group) have no harmonic
   relation to any true note** — not an octave, not a fifth, in any register.
   Those are the whitening artefacts of §A. Nothing in the handoff's plan can
   remove them: pruning tests whether a note explains residual energy, and a
   noise ghost sitting in an otherwise empty band genuinely does explain the
   (noise) energy there.

3. **59% of ghosts sit within 60 cents of some true note's h-th partial**;
   41% match no harmonic at all. Among those that do match, the distribution is
   `h3=53, h9=37, h6=26, h12=25, h5=23, h16=21, h2=17, h10=15` — i.e. the
   twelfth (h=3) and its octave-compounds dominate, which is why the fifth-error
   column is nearly as large as the octave column.

### By cause — the control-timbre subtraction

`geometric` is the only timbre `buildDict` reproduces exactly (corpus.mjs:78-82
uses `s=0.72`, which is `S.decay`). Its ghosts are therefore *structural*
ambiguity that survives a perfect dictionary; the excess on every other timbre is
attributable to template mismatch.

| timbre | ghosts | structural | timbre-mismatch excess |
|---|---|---|---|
| geometric | 36 | 36 | 0 |
| bright | 105 | 36 | 69 |
| dark | 61 | 36 | 25 |
| hollow | 92 | 36 | 56 |
| formant | 132 | 36 | 96 |
| inharmonic | 54 | 36 | 18 |
| **TOTAL** | **480** | **216 (45%)** | **264 (55%)** |

So the honest version of the handoff's claim is: **timbre mismatch accounts for
55% of ghosts, structural ambiguity for 45%.** A bare majority, not a dominant
driver — and 45% of ghosts would survive a dictionary that fit the timbre
perfectly. That materially weakens the case for the dictionary work the handoff
ranks (Tasks 5 and, via RESEARCH.md §10, multi-template): even a *perfect*
timbre model leaves 216 ghosts, whereas §A's four-line whitening fix removes 227
with no timbre modelling at all.

### The worst voicings are not the ones anyone expected

| voicing | ghosts (6 timbres) | per chord | true notes | of which sub-bass |
|---|---|---|---|---|
| cluster-semitone | 39 | 6.5 | 3 | 29 |
| triad-close-Cmaj | 38 | 6.3 | 3 | 28 |
| cluster-C-Cs-G | 38 | 6.3 | 3 | 27 |
| dim7-Fs | 33 | 5.5 | 4 | 23 |
| low-bass-E1 | 30 | 5.0 | 4 | 1 |
| min7-A-close | 28 | 4.7 | 4 | 19 |
| low-bass-C1 | 27 | 4.5 | 4 | 1 |

The worst case in the corpus is `triad-close-Cmaj` — RESEARCH.md's own "the easy
case" — with 6.3 ghosts per chord against 3 true notes. It is worst *because* it
is easy: three mid-register notes leave four octaves of empty spectrum below
them for the whitener to fill with noise (28 of its 38 ghosts are sub-bass).
The genuinely hard low-bass voicings have almost no sub-bass ghosts, because
there is no empty band left under them. This inverse relationship is further
confirmation of §A's mechanism, and it is a good reason to distrust any
intuition about "hard chords" formed before the bug was found.

---

## E. The remaining §3 negative results

### Evidence-protected pruning — confirmed dead, for the reason given

Handoff §3: skipping the pruning of notes with strong energy at their own
fundamental took F1 0.835 → 0.806, because "octave ghosts have strong fundamental
evidence *by definition* — the real note's 2nd partial sits exactly there."

Measured (`test/exp/segment.mjs`, `pruneEvid`), on top of `wfloor 0.3 + prune 0.07`:

| config | recall | prec. | F1 | oct | 5th | miss | ghosts |
|---|---|---|---|---|---|---|---|
| **no protection** | 0.800 | 0.915 | **0.854** | 27 | 18 | 121 | 45 |
| protect evid ≥ 0.5 | 0.827 | 0.760 | 0.792 | 85 | 71 | 105 | 158 |
| protect evid ≥ 0.3 | 0.843 | 0.719 | 0.776 | 97 | 96 | 95 | 200 |

Confirmed, and the handoff's reasoning is exactly right. The separability data in
§A shows why quantitatively: on the **whitened** spectrum the fundamental
evidence of in-range ghosts (median 0.525) overlaps heavily with that of hits
(median 0.694). Protecting on that quantity protects octave ghosts nearly as
often as it protects real notes, and the octave-error count triples.

One nuance the handoff could not have seen: on the **raw** spectrum the two
populations separate cleanly for *sub-bass* ghosts but still not for in-range
ones (in-range ghost p25 = 0.12 against hit p25 = 0.49). So evidence protection
is dead for octave ghosts specifically, which is what it was for. No further work
here.

### Auto-fitting the decay `s` — the handoff is wrong, and it named the fix itself

Handoff §3: auto-fitting `s` by minimising reconstruction residual took F1
0.835 → 0.755, because it is "degenerate model selection: picks the smallest `s`
on the grid for 100% of chords … Would need a complexity penalty (AIC/BIC) or
envelope estimation from already-detected notes."

It then files the whole idea under **"do not attempt"**.

That is the wrong conclusion from a correct diagnosis. I implemented both
versions — grid `s ∈ {0.58, 0.65, 0.72, 0.79, 0.86}`, selecting by
`NB·ln(RSS/NB) + pen·k·ln(NB)` where `k` is the number of active columns, i.e.
BIC with a tunable multiplier. `pen = 0` is exactly the handoff's degenerate
version; `pen = 1` is textbook BIC.

| config | recall | prec. | F1 | oct | 5th | miss | ghosts | conf-gap | ms |
|---|---|---|---|---|---|---|---|---|---|
| wfloor 0.3 (reference) | 0.878 | 0.718 | 0.790 | 99 | 97 | 74 | 209 | +0.41 | 96 |
| + auto-s, `pen = 0` (residual only) | 0.909 | 0.565 | 0.697 | 189 | 190 | 55 | 424 | +0.33 | 103 |
| + auto-s, `pen = 1` (BIC) | 0.896 | 0.681 | 0.774 | 113 | 123 | 63 | 254 | +0.34 | 103 |
| + auto-s, **`pen = 4`** | 0.853 | 0.878 | **0.865** | 35 | 36 | 89 | 72 | +0.42 | 103 |
| wfloor 0.3 + prune 0.07 (for comparison) | 0.800 | 0.915 | 0.854 | 27 | 18 | 121 | 45 | +0.38 | 96 |

**The handoff's diagnosis reproduces precisely.** `pen = 0` is a disaster: F1
0.790 → 0.697, ghosts 209 → 424. Unpenalised model selection prefers the peakiest
dictionary because a dictionary closer to the identity basis fits anything.

**Its conclusion does not.** Add the penalty it names and the same idea becomes
**the single best-scoring change I measured**: F1 0.865, above `prune 0.07`'s
0.854, and it gets there with **53 more true notes found** (recall 0.853 vs
0.800). Textbook BIC (`pen = 1`) is under-penalised for this problem and needs
roughly 4×; that is unsurprising, since the "observations" are 333 heavily
correlated log-frequency bins rather than 333 independent samples, so the
effective sample size in the BIC term is far below `NB`.

Runtime cost is 96 → 103 ms/chord — five extra 88-column NNLS fits at 160
iterations, well inside the 900 ms budget.

**The selection histogram confirms the handoff's diagnosis to the digit, and
shows the penalty repairing it** (`test/exp/shist.mjs`, count of chords choosing
each `s`; `nominal` is the value `test/corpus.mjs` actually generated the timbre
with, where it has one):

```
penalty 0 — residual only (the handoff's version)
timbre        0.58  0.65  0.72  0.79  0.86    modal   nominal
geometric       22     0     0     0     0     0.58      0.72
bright          22     0     0     0     0     0.58      0.86
dark            22     0     0     0     0     0.58      0.58
hollow          22     0     0     0     0     0.58        —
formant         22     0     0     0     0     0.58        —
inharmonic      22     0     0     0     0     0.58      0.79

penalty 4
timbre        0.58  0.65  0.72  0.79  0.86    modal   nominal
geometric        0     5     7     5     5     0.72      0.72   ✓
bright           0     0     0     2    20     0.86      0.86   ✓
dark            20     1     0     1     0     0.58      0.58   ✓
hollow           0     1     1     0    20     0.86        —
formant          0     0     4     6    12     0.86        —
inharmonic       0     0     9     6     7     0.72      0.79
```

At `pen = 0` the smallest grid value wins **132 chords out of 132 — 100%,
exactly as the handoff states**. At `pen = 4` the modal choice recovers the
generating parameter for all three timbres that have one (`geometric` 0.72,
`bright` 0.86, `dark` 0.58) and lands one grid step low on `inharmonic`. The
comb and resonance timbres, which have no true `s`, are pushed to the bright end
— which is the right compromise for spectra with strong high partials.

So this is not a lucky F1: the estimator is recovering the physical parameter it
is supposed to recover, and the failure the handoff observed was entirely the
missing penalty term.

This is the clearest case in the whole review of a **sound idea discarded because
of one badly chosen constant**, and it is the second such case (§A's `evidRaw`
was the first). Both were recorded as negative results. That is the strongest
practical reason to distrust `handoff.md`'s "do not attempt" list: it does not
distinguish "the idea is wrong" from "my first parameterisation was wrong".

---

## F. Tasks 3–5 on their merits

### Task 3 — envelope correlation replacing `pFund`

**Mechanism: right.** "A real note's partials all rise and fall together; a
ghost's are borrowed" is correct physics and is the same insight as RESEARCH.md
§10's fix 3.

**Acceptance criterion: invalid.** It asks for the confidence gap to rise from
0.18 to ≥ 0.35 and be positive on every timbre including `dark`. **§A's
four-line whitening floor already delivers +0.39 to +0.42 with no timbre
inverted** (§A, §C tables). The criterion is therefore satisfied by a change
that does none of what Task 3 proposes — which means it was never measuring
envelope coherence. It was measuring the whitening bug, because the `dark`
inversion the task is built around is a *symptom* of that bug: `dark` has five
partials and nothing above (`test/corpus.mjs:88-91`), so it has the widest dead
bands and the most noise ghosts, and those ghosts sat in bands where nothing
competed for their fundamental bin, giving them a `pFund` near 1.

**Two things that would break it as specified.**

*The extracted envelope is contaminated in exactly the case it is meant to fix.*
Step 1 says "extract the magnitude time-series at that harmonic's bin". In a
nested voicing — open E is E2 B2 E3 G♯3 B3 E4 — the bin at E2's 2nd partial
*is* E3's fundamental. The series you extract for E2's h = 2 is the sum of E2's
second partial and E3's fundamental, so a real E3 and a ghost E3 produce a
similar-looking correlation. The metric is least reliable on the guitar voicings
RESEARCH.md §10 says are the actual reported failure.

*It needs the notes to have different envelopes.* On a sustained source — organ,
bowed strings, a held piano chord well after the attack — all envelopes are flat
and the correlation is a ratio of noise. The tool's own use case is a *fenced
steady segment*; the user is being told to "fence tightly" (RESEARCH.md §4), which
is advice to remove precisely the temporal variation this metric consumes.

**Testability here: poor.** `test/corpus.mjs:147` staggers onsets by
`0.004·ni·rand()` — under 4 ms, deliberately "well under one analysis hop" — so
onset separation is untestable. Decay constants do differ per note
(`corpus.mjs:144`, τ ∈ 2.2–4.5 s), so envelope *slope* correlation is testable in
principle; I did not build it, because the acceptance criterion it would be
scored against is already met and the mechanism's weak spot is a case the corpus
does not contain.

**Verdict:** do not build this next. Re-derive the case for it after §A lands,
against a real strummed-guitar fixture, with an acceptance criterion that is not
already satisfied.

### Task 4 — per-frame fitting instead of one averaged spectrum

**Mechanism: right, and one sub-claim is straightforwardly correct and worth
doing on its own.** `nnls()` recomputes the Gram matrix `DᵀD` on every call
(`js/dsp/nnls.js:87-96`) even though `D` changes only when `a4` or `decay`
changes. Caching it is a pure win regardless of whether per-frame fitting
happens.

**But the headline claim — "this is the biggest structural weakness left" — is
asserted, and cannot be tested with what exists.** Every corpus chord is 22
simultaneous static voicings sustained for 2.5 s with no chord change and no
mid-fence entry (`test/corpus.mjs:132-175`). A corpus of static chords cannot
show that collapsing time is costly. On the evidence available, the biggest
structural weakness left is not this; it is that 38% of ghosts are noise (§A),
which the averaged spectrum has nothing to do with.

**Budget: plausible.** 2.5 s at 44.1 kHz with `n = 16384, hop = 4096`
(`js/analyzeSegment.js:70`) is ~24 frames. The current single fit is ~40 ms of
the ~96 ms total. Warm-started FISTA at ~40 iterations per frame should land
around +120 ms, comfortably inside 900 ms. The handoff's fallback (12 evenly
spaced frames) is sensible.

**The genuinely valuable part is the part that is not about accuracy.** The
stability figure — "segment is 87% one chord" vs "chord change at 1.4 s" — is
the only signal the tool can give that the user's fence is wrong, and it needs
none of the accuracy argument to justify it. Note it can be produced far more
cheaply than per-frame NNLS: per-frame *log-spectrum* distance, or per-frame
correlation against the mean spectrum, would flag a chord change at a small
fraction of the cost. I would build the cheap version of the stability figure and
leave per-frame fitting until there is a corpus with chord changes in it.

### Task 5 — inharmonicity in the dictionary

**Mechanism: right physics.** `f_h = h·f₀·√(1+B·h²)` is correct, and the
observation that at h = 10, B = 4e-4 the error is ~34 cents — over one log-bin at
3 bins/semitone — is arithmetically sound.

**The acceptance criterion cannot be met or failed meaningfully on this corpus,
and the test would be circular.** Task 5 proposes `B = 5e-5·2^((midi-21)/24)`.
`test/corpus.mjs:123` generates the `inharmonic` timbre with
`B = 5e-5·Math.pow(2,(midi-21)/24)` — **the identical expression**. Fitting a
model to a corpus generated by that same model is exactly the failure
RESEARCH.md §10 diagnoses in the old fixtures ("a fixture set that agrees with
the model rather than probing it"). Any improvement measured this way is
tautological.

**And the task's own rationale argues against itself.** It notes that
`inharmonic` already scores best, because inharmonicity destroys exact octave
coincidence and *helps* disambiguation. We confirm that: `inharmonic` is the top
timbre by F1 after §A (0.856) and after §A+§C (0.914). If inharmonicity is what
makes real pianos easier than synthetic ones, modelling it away removes the cue.
The measured risk is concrete: §B shows that every widening of this dictionary so
far has cost more precision than it gained, and adding a per-note `B` widens the
templates in frequency exactly as multi-`s` widened them in amplitude.

**Verdict: lowest priority of the three.** If it is attempted, it must be scored
on a corpus whose `B` is *not* the formula being fitted — a real piano recording,
or at minimum a corpus `B` drawn from a different functional form.

### Task 6 — per-note tuning readout

Cheap, useful, uncontroversial, and I have no criticism of the mechanism. The
`cents` field already exists and is hardcoded to 0 (`js/analyzeSegment.js:136`).

Two caveats worth writing into the task. Bin width at `n = 16384`, 44.1 kHz is
2.69 Hz; at C2 (65 Hz) that is ~70 cents per bin, so parabolic interpolation in
the bass is interpolating across a very coarse grid and the readout should be
suppressed or widened below ~E2. And on `formant`-like sources the fundamental
may not be a local maximum at all, so "interpolate the peak near f₀" needs a
fallback — measure the deviation on the strongest *detected* partial and divide
out `h`, which is more accurate anyway.

---

## G. What the handoff missed

Beyond §A, which is the big one, six things. I have rejected three with reasons
and kept three. Nothing in this section is measured unless it says so.

### Kept

**1. Cross-frame frequency coherence — the most interesting unexplored
direction.** The pipeline is magnitude-only: `magOf(SL)` at
`js/analyzeSegment.js:71` throws away phase, and then averages the magnitudes
across frames (`analyzeSegment.js:72-74`). But `stft()` returns the complex
spectrum and `SL` is still in scope, so the phase is **already computed and
free**. A real partial has a stable instantaneous frequency across frames; a
noise bin's phase advance is random. One phase-derivative pass gives a per-bin
"is this a steady sinusoid" weight that would suppress exactly §A's noise ghosts
*and* is orthogonal to every other proposal here — it discriminates on a
completely different axis from amplitude, harmonic relation, or envelope. It also
degrades gracefully on sustained sources, where Task 3's envelope correlation
does not. Cost is one pass over the STFT, no extra FFT. **Speculative — I did not
implement or measure this.**

**2. Spectral-envelope estimation from detected notes.** Covered in §B. This is
the non-degenerate alternative to widening the dictionary, and the handoff names
the idea once (in the auto-`s` negative result) without ranking it. **Speculative.**

**3. Explicit octave resolution via partial-amplitude consistency.** For a
candidate octave pair (n, n+12), the *odd* partials of n — 3f₀, 5f₀, 7f₀ — are
positions n+12 cannot explain at all. Ask directly whether the observed
amplitudes there are consistent with the fitted level of n. This is a targeted
test for the largest single error class (§D: 198 octave ghosts at baseline, still
27 after §A+§C), it is a handful of array lookups, and unlike redundancy pruning
it is *diagnostic*: it can name the relationship, which is RESEARCH.md §10's fix
1 ("display 'E4 — 84% explained by E2, 4th partial' instead of a bare
percentage") — the one fix in that document that improves the readout even when
detection is already correct, and which neither document has scheduled.
**Speculative, but cheap enough that it should just be tried.**

### Rejected, with reasons

**4. Onset detection and note-event segmentation — out of scope, but half of it
is already paid for.** Full note-event transcription is a different product: this
tool analyses a *user-fenced* segment and does not need note starts and ends.
Reject as specified. But note that `analyzeSegment` already computes the
percussive residual and returns it (`js/analyzeSegment.js:63`, `perc`), where it
is used only for playback. An onset envelope from `perc` is nearly free and would
serve Task 4's stability figure — see §F. So: reject the feature, harvest the
by-product.

**5. Iterative subtraction / matching pursuit instead of one-shot NNLS —
reject.** Greedy selection is precisely what joint NNLS was adopted to avoid: in
a nested voicing an early wrong pick is unrecoverable, and nesting is the whole
difficulty (RESEARCH.md §4). Substituting a greedy method for the joint fit would
give up the one property that makes the method work. Worth observing, though,
that §C's redundancy pruning is already a *backward*-greedy pass over the joint
solution, which keeps the good half of the idea — global fit first, greedy
refinement second — and that is the right order.

**6. HPSS percussive residual as evidence — reject as *evidence*, keep as a
gate.** The percussive stream is broadband and vertical by construction; it
carries no pitch information, so it cannot vote on which notes are sounding.
What it can do is tell you the segment is transient-dominated, i.e. that the
fence is on an attack rather than a sustain, which is a UI warning rather than a
detection input. Cheap, and it uses something already computed.

### One latent inconsistency, found while reading

`js/analyzeSegment.js:104` builds the amplitude-fit candidate set from
`detN[i] > 0.03`, while the displayed note list comes from `selectNotes` with
`thr = 0.12` plus the gate and NMS. The second NNLS therefore fits a much larger
set than is ever shown, and the displayed dB values (`analyzeSegment.js:130`) are
normalised against a maximum drawn from that larger set. This is defensible —
a better-conditioned amplitude fit — but it means a note's reported level depends
on notes the user cannot see, and the two thresholds can drift apart silently.
Worth a comment in the code at minimum.

---

## H. Chord naming

Out of scope per the handoff, and it is right that HMM/Viterbi chord-transition
priors cannot help note identification. But note that `idChord`
(`js/chords.js:32`) *already* chroma-collapses — `panels.js:45-48` builds a
12-bin `pcv` and octave is gone before naming starts — so "don't chroma-collapse"
is advice about a bridge already crossed.

I measured the namer in isolation (`test/exp/chordid.mjs`), scoring
automatically: expand the top-1 label back into its pitch-class set and compare
with the set actually played.

| condition | n | exact | over-claims | under-claims | both |
|---|---|---|---|---|---|
| **oracle** (pcv built from ground-truth notes) | 132 | **108 (82%)** | 12 (9%) | 6 (5%) | 6 (5%) |
| shipped detection | 132 | 86 (65%) | 27 (20%) | 12 (9%) | 7 (5%) |
| detection + `wfloor 0.01` | 132 | 91 (69%) | 22 (17%) | 11 (8%) | 8 (6%) |

Two separable problems: detection costs 17 points (82 → 65), of which §A
recovers 4; and the namer itself has an 18-point ceiling that no amount of
detection improvement can touch.

### The ceiling is template coverage, not scoring

My first hypothesis was a scoring asymmetry, and it was wrong. `js/chords.js:44`
accumulates `miss` only over pitch classes where the *template* is zero — it
penalises observed energy the chord fails to explain, but nothing penalises a
template tone with **no** observed energy. The only pushback is a flat
`0.012` per template tone (`chords.js:47`), which a five-tone template pays just
0.06 for. That looked like an obvious bug.

It is not the problem. Adding an explicit absent-tone penalty
`Σ(t_i − v_i)₊²` and sweeping its weight (`test/exp/chordfix.mjs`) changes
nothing:

```
oracle exact match over the 22 voicings
  beta   cx=0.012   cx=0.03   cx=0.06
  0.00      18/22     18/22     18/22
  0.40      18/22     18/22     18/22
  0.80      18/22     16/22     15/22
  1.20      15/22     15/22     14/22
```

Flat until it starts doing damage. A clean negative result: the scoring function
is fine.

The actual cause is that all four failures are voicings **no template in the
26-entry table can express**:

```
oct-quad-C        {C}             -> C5      (invents a G)
cluster-semitone  {C C# D}        -> Csus2   (invents G, drops C#)
cluster-C-Cs-G    {C C# G}        -> D#13    (invents D#, A#)
quartal-stack     {C D F G A A#}  -> A#6/9   (drops A)
```

### The namer already knows when it doesn't know

Sorting the 22 voicings by their top-1 score, oracle condition:

```
  0.382  FAIL  cluster-semitone     0.836  ok  maj9-wide-spread
  0.610  FAIL  quartal-stack        0.903  ok  min11-E-wide
  0.710  FAIL  cluster-C-Cs-G       ...
  0.736  FAIL  oct-quad-C           1.011  ok  low-bass-C1
  ---------------- 0.80 ----------------
```

**The four failures are the four lowest scores, with a clean gap.** A single
threshold at 0.80 separates them perfectly. The score is computed
(`chords.js:48`) and thrown away — `panels.js:55` prints the top-1 label
unconditionally, so a 0.38 guess is displayed with exactly the same authority as
a 0.99 certainty. The alternates line does show scores (`panels.js:59`) but only
for candidates 2–4.

### What I would change, in order

1. **Hedge below ~0.80.** Show the pitch classes found instead of a fabricated
   name — "C C♯ G — no clear chord". Zero risk, removes all four failures from
   the "wrong" column, and is honest. Measured: perfect separation on this
   corpus.
2. **Add `['(oct)', {0:1}]` to `TPL`.** Measured: 18/22 → **19/22**, and it
   steals nothing — all 18 previous wins are retained. `oct-quad-C` is four Cs
   and the tool currently calls it C5, asserting a fifth nobody played.
3. **Stop deriving `bass` from `pFund`.** `panels.js:50-51` picks the bass as
   the lowest note with `pf > 0.4`. `pFund` is the metric that was *inverted* on
   `dark` before §A (0.68 hit / 0.89 ghost), so on that timbre the bass was
   being chosen preferentially from ghosts, and the root-position bonus
   (`chords.js:46`) applied to the wrong root. §A fixes the metric; the coupling
   is still fragile and the lowest *detected* note is a more robust choice.
4. Clusters and six-pitch-class quartal stacks are genuinely outside a
   triad-and-extensions vocabulary. Recommendation 1 covers them honestly. Do
   not add templates to chase them — that way lies a table where `D♯13` is a
   plausible reading of three adjacent semitones.

The one thing I would *not* do is use the voicing (which the handoff correctly
protects) to disambiguate naming, until §A and §C land. Inversion and slash-chord
logic built on a note list that is 47% ghosts will encode the ghosts.

---

## Ranked recommendation

Everything below was measured on `test/corpus.mjs` — 22 voicings × 6 timbres,
606 notes — unless marked **speculative**. The stack that produced the headline
number:

| stack | recall | precision | F1 | ghosts | ms |
|---|---|---|---|---|---|
| shipped today | 0.878 | 0.526 | 0.658 | 480 | 96 |
| + §A whitening floor 0.3 | 0.878 | 0.718 | 0.790 | 209 | 96 |
| + §E auto-`s`, BIC × 4 | 0.853 | 0.878 | **0.865** | 72 | 103 |
| (alternative) §A + §C prune 0.07 | 0.800 | 0.915 | 0.854 | 45 | 96 |
| (all three) §A + §E + §C prune 0.05 | 0.769 | 0.967 | 0.857 | 16 | 103 |

**F1 0.658 → 0.865, precision 0.526 → 0.878, recall 0.878 → 0.853, runtime
96 → 103 ms against a 900 ms budget.** Two changes, both inside
`js/dsp/nnls.js` and `js/analyzeSegment.js`, no new dependencies, no new stage.

Note §C and §E are **substitutes, not complements** — both suppress
over-activation, and stacking all three buys nothing on F1 (0.857 vs 0.865)
while costing 84 more true notes. Pick one as the default; the other is the
better user-facing control.

| # | Recommendation | Effort | Expected effect | Status |
|---|---|---|---|---|
| 1 | **§A — floor the whitening σ** at ~0.3 × the log-spectrum RMS (`js/dsp/nnls.js:50`) | ~4 lines | **F1 +0.132**, precision +0.192, recall unchanged, sub-bass ghosts 182 → 2, conf-gap 0.12 → 0.41, runtime unchanged | **measured** |
| 2 | **§E — auto-fit `decay` per segment** over a 5-point grid, selected by `NB·ln(RSS/NB) + 4k·ln(NB)` | ~25 lines, +7 ms | **F1 +0.075** on top of 1 (0.790 → 0.865); also removes the *Timbre* slider's main burden on the user | **measured** |
| 3 | **§C — redundancy pruning**, exposed as the strictness slider the handoff proposes, default off or ~0.03 | ~30 lines, +1 ms | F1 +0.064 on top of 1 alone; as a *control* it spans precision 0.72 → 0.98 | **measured** |
| 4 | **§H — hedge the chord name below score 0.80**, and add `['(oct)',{0:1}]` to `TPL` | hours | removes 4/22 fabricated chord names; naming ceiling 18/22 → 19/22 | **measured (oracle)** |
| 5 | **§B/§G — estimate one spectral envelope** from confidently detected notes, re-weight the 88-column dictionary, refit | ~1 day | should cover `formant` and `bright`, the two worst timbres, without the degeneracy §B measures | **speculative** |
| 6 | **§G — cross-frame phase coherence** as a per-bin steadiness weight | ~half day | orthogonal to everything else; should suppress noise ghosts on a different axis from 1 | **speculative** |
| 7 | **§G — odd-partial consistency for octave pairs**, and *name the parent* in the UI (RESEARCH.md §10 fix 1) | hours | targets the largest remaining error class; improves the readout even when detection is right | **speculative, cheap** |
| 8 | **Task 6 — per-note cents readout** (`js/analyzeSegment.js:136`) | hours | orthogonal, user-visible | not measured, uncontroversial |
| 9 | **Task 1 — L1 0.004 → 0.10** | one line | F1 +0.012, precision +0.016, free | **measured** — real, and marginal |

### Do not do

- **Multi-template decay dictionaries** (§B) — measured dead in 11 variants, and
  it damages the timbres it was meant to fix.
- **Evidence-protected pruning** (§E) — measured dead; the handoff's reasoning
  for why is correct.
- **Task 3 as specified** (§F) — its acceptance criterion is already met by
  recommendation 1, so it would be scored against a target that no longer tests
  anything.
- **Task 4's accuracy claim** (§F) — untestable on a corpus of static chords.
  Build the cheap version of its stability figure instead; that part stands on
  its own.
- **Task 5** (§F) — the proposed `B` is the identical expression the corpus uses
  to *generate* the `inharmonic` timbre, so the test is circular.

### What would falsify each measured recommendation

**1 (whitening floor).** A recording with a genuinely quiet low bass note under a
loud mid-register chord, more than ~40 dB below the spectral RMS — the floor
would suppress it. Also: any real source with a very narrow-band spectrum, where
the global RMS is a poor proxy for the noise floor. The corpus has low bass but
never *quiet* low bass, and one fixed noise level (`test/corpus.mjs:168`,
≈ −49 dBFS). Add both and re-run.

**2 (auto-fit `s`).** A source whose spectrum is not near any member of
`{s^(h-1)}` — the grid then picks the least-bad member and the BIC penalty may
select the wrong complexity for the wrong reason. `hollow` and `formant` are
already outside that family (§B) and both still improve, which is reassuring but
not conclusive. It would also be falsified by a segment containing two
instruments with different rolloffs, where a single global `s` is wrong by
construction; the corpus never mixes timbres within one chord.

**3 (pruning).** A voicing with genuine octave doublings that the user needs
reported — the corpus has `oct-quad-C` and `oct-triple-E`, and pruning is
supposed to remove exactly those. If real users transcribing piano find the
doublings matter, the default must be off, not merely low.

**4 (chord naming).** The 0.80 threshold is fitted to 22 voicings with a clean
gap between four failures and eighteen successes. Twenty more voicings could
close that gap. The `(oct)` template could also start stealing wins on sparse
real-world detections where only the root survives the gate.

**9 (L1).** Nothing; it is small and free either way.

### The corpus is the limiting instrument

Every number in this document comes from synthetic audio, and the corpus was
built to probe `buildDict`'s amplitude assumption. It has no chord changes, no
onset stagger beyond 4 ms, one noise level, one dynamic range, no quiet notes, no
two-instrument segments and no real recordings. Five specific gaps matter for the
conclusions above, in priority order:

1. **A quiet low bass note under a loud chord** — the single case that could
   falsify recommendation 1, which is the largest recommendation.
2. **Varying noise levels**, since §A's whole mechanism is about the noise floor
   and the corpus holds it fixed.
3. **A chord change mid-segment** — without it, Task 4 can be neither justified
   nor refuted, and the stability figure cannot be validated.
4. **A pluck comb at β ≠ 1/2** — `hollow` is effectively β = 1/2 and is the only
   notched timbre; RESEARCH.md §10's actual proposal cannot be tested with one.
5. **Real recordings.** The handoff's closing paragraph says this and is right.
   It matters most for recommendations 1 and 2, both of which turn on constants
   estimated from the global spectrum.

I would add gaps 1 and 2 before shipping recommendation 1, because they are two
lines of corpus code and they test the thing most likely to be wrong.
