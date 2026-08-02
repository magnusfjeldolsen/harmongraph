# Where the work stands

Paused 2026-07-29. Written so this can be picked up cold.

---

## Live

<https://magnusfjeldolsen.github.io/harmongraph/> — Pages serves `master` from the repo root, HTTPS enforced, `.nojekyll` present. Confirmed serving the modular build.

The app must be **served**, not opened from disk: ES modules are CORS-blocked on `file://`, and `getUserMedia` is refused there too. Locally, `python -m http.server 8000` from the repo root.

---

## Branches

| Branch | State |
|---|---|
| `master` | Current. Everything below that says "done" is merged here. |
| `modularize` | Merged. Safe to delete. |
| `harness` | Merged. Safe to delete. |
| `assessment` | **Live WIP, not merged.** Interrupted mid-run. See below. |
| `worker` | **Not merged.** DSP moved into an abortable module worker. See below. |

---

## Done

- **Modularized** — one 64 KB `index.html` became 14 ES modules plus `css/app.css`. Verified by multiset-diff that only 3 executable lines changed, all forced by ESM's read-only imports. Zero DSP drift.
- **Mic capture rewritten.** Was `getUserMedia` → `MediaRecorder` → `Blob` → `decodeAudioData`, with `audio/mp4` first in the codec list, so any browser advertising MP4 encoded the take to AAC — lossy in exactly the high partials the NNLS fit reads. Now raw PCM through a `ScriptProcessor` straight into an `AudioBuffer`. Errors are also mapped to their real cause instead of one "Microphone blocked" string that hid five different failures.
- **Pinch-zoom no longer destroys the fenced selection** (`js/main.js`). The first finger collapsed the fence assuming a new selection; a second finger flipped to pinch mode and skipped the repair.
- **Note selection resets on a new analysis** (`js/analysis.js`, `js/audio.js`). `noteOn` was never cleared, so every analysis after the first inherited the previous chord's ticks; and the harmonic-comb isolation read it unfiltered, so it could mask for pitches the current fit never detected.
- **DSP moved into a worker** (branch `worker`, not merged). A real module worker; the signal is transferred in and handed back on the result. Cancellation is cooperative — a generation token checked between stages and inside the FISTA and HPSS loops — so a cancelled run unwinds and the worker is reused, with `terminate()` only as a backstop. The Analyze button becomes Cancel while a run is in flight. A browser that blocks module workers falls back to the main-thread path. `node test/worker.mjs` covers the cancellation and stale-reply races; the harness reports `+0.000` on every metric. **Not verified in a real browser** — see the branch's own notes.
- **Evaluation harness** — `node test/harness.mjs`, 132 chords (22 voicings × 6 timbres), zero dependencies, ~60 s, deterministic. Supports `--save`, `--compare <file>`, `--timbre`, `--voicing`, `--json`. `analyzeSegment()` was extracted as a pure DOM-free pipeline to make it possible; `analyze()` is now a thin wrapper.

## Baseline — measure every change against this

```
timbre        recall  prec.   oct  5th  oth  miss   P(real) hit/ghost
geometric    0.891  0.714    12   18    6    11   0.78 / 0.74
bright       0.852  0.450    51   32   22    15   0.82 / 0.61
dark         0.901  0.599    20   18   23    10   0.68 / 0.89   <- inverted
hollow       0.881  0.492    23   51   18    12   0.78 / 0.58
formant      0.832  0.389    67   44   21    17   0.82 / 0.58
inharmonic   0.911  0.630    25   18   11     9   0.78 / 0.74
OVERALL      0.878  0.526   198  181  101    74   0.78 / 0.66

F1 0.658 · conf-gap 0.12 · ~140 ms/chord mean (900 ms budget)
```

---

## The two things that should drive what happens next

### 1. `handoff.md`'s numbers are unverifiable

It cites `test/harness.mjs`, `test/corpus.mjs`, `test/baseline.json` and `reference/analyzeSegment.js` as "provided". **None were ever delivered.** So its §2 baseline, its three §3 negative results, and its Task 2 prune table all quote a harness nobody has.

Treat its *reasoning* as evidence and its *numbers* as narrative. Two of its claims already failed to reproduce here: "`inharmonic` scores best" (best recall, but `geometric` wins on F1), and its precision of 0.749 against our 0.526.

This matters most for §3, which is the stated reason not to attempt three specific ideas — including one that `RESEARCH.md` §10 recommends.

### 2. A third of all ghosts are low-frequency noise artifacts, and the handoff missed it

**38% of ghosts (182/480) sit below the chord's bass note.** `whiten()` (`js/dsp/nnls.js`) standardises over ±1 octave, so in a band with no chord energy the local σ collapses and noise reaches z-scores comparable to real partials. `evid` is computed on the whitened spectrum, so the fundamental-evidence gate passes them.

Confirmed independently on a clean C4/E4/G4 triad:

| noise floor | detected |
|---|---|
| none | C4 E4 G4 — clean |
| −54 dBFS | **A0 C2** C4 E4 G4 |
| −40 dBFS | **A0 C2** C4 E4 G4 |

The amplitude-invariance is the signature — whitening normalises absolute level away, so inaudible noise in an empty band is promoted to a real partial's z-score. −54 dBFS is quieter than any real recording.

**These ghosts are not harmonic relatives of anything**, so neither the handoff's Task 1 (raise L1) nor its Task 2 (redundancy pruning, whose whole premise is that a ghost's harmonics are a subset of a real note's) can touch them. This likely outranks both, and is cheaper. Candidate fixes: floor the whitening σ at a global noise estimate; compute `evid` on the raw spectrum; gate on absolute energy below the detected bass.

---

## Resume here

**Next action: task 10** — measure the three low-frequency-ghost fixes above. Then re-evaluate the handoff's ordering, because Task 2's expected gain is smaller than advertised once these ghosts are removed separately.

The `assessment` branch has interrupted scaffolding for exactly this and should be the starting point rather than a fresh build:
- `test/exp/sweep.mjs` — runs several configs over one corpus synthesis
- `test/exp/segment.mjs` — an alternative pipeline for experiments
- `EXP_SEG` / `EXP` env hooks in `harness.mjs` so an experiment is measured without editing shipped code — **must be reverted before that branch merges**
- `docs/algorithm-assessment.md` — a stub, baseline only, no findings

The assessment was interrupted three times by transient API errors (500, 529), not by anything about the task.

### Open work

| # | Task | Notes |
|---|---|---|
| 10 | Low-frequency noise ghosts | **Start here.** Measured, cheap, outranks the handoff's top two. |
| 2 | Finish the independent assessment | Settle the multi-template question by measuring it — group sparsity and per-note exclusivity were never tried. Audit the other two §3 negatives. Assess `js/chords.js` naming. |
| 4 | Handoff Tasks 1–2 | L1 0.004 → 0.10; redundancy pruning + a "Strictness" slider. Re-measure the expected gain after task 10. |
| 5 | Handoff Tasks 3–4 | Envelope correlation replacing `pFund`; per-frame fitting. Gap starts at 0.12 here, not 0.18, with −0.20 on `dark` — a bigger job than the handoff implies. |
| 6 | Handoff Tasks 5–6 | Inharmonicity in the dictionary; per-note cents readout. Task 5's stated rationale is already half-refuted. |
| 3 | Implement the interaction design | `docs/interaction-design.md`. Nothing built yet. |
| 8 | Reconcile `RESEARCH.md` | §10's multi-template recommendation is disputed by an unverifiable measurement — hold until task 2 settles it. §4's headline figures are superseded. §9 Phase 3 recommends a Viterbi smoother the handoff rules out, correctly. |

### Known bug, not yet filed as a task

`RESEARCH.md` §4's "90% recall / 96% precision / 14-of-14 chords" figures were measured on a corpus whose partial structure is what `buildDict` already assumes. That test set cannot expose a timbre-mismatch failure. Superseded by the baseline above.

---

## Interaction design, if picking that up instead

`docs/interaction-design.md` is complete and implementable. Its load-bearing observation: `selectedNotes()` caps candidates at 12, so the key map is never 88 targets. At 360 px the canvas gives 4.0 px per black key against a ~40 px finger — impossible — but 28 px per target at 12 candidates. So **the hit targets are the detected notes, not the keys.**

It also pushes back on the original framing in three ways worth reading before implementing: recall is 0.878, so a toggle-only UI caps at the detector's recall and needs an add-a-missing-note path; A/B against the recording is the real verification, not playback of your chosen set; and a piano preview of a guitar chord is judged through the wrong timbre.
