# Benchmarks

Two, because they answer different questions and neither is sufficient alone.

| | what it is | run |
|---|---|---|
| **Synthetic** | 132 generated chords, 22 voicings × 6 timbres | `node test/harness.mjs` |
| **Real audio** | 1272 windows of recorded acoustic guitar, annotated per string | `node test/real.mjs <dir>` |

The synthetic corpus is fast, deterministic and diffable, so it is what you
measure a change against. But it is generated from the same partial model
`buildDict()` assumes, so **it cannot expose a timbre-mismatch failure** — the
flaw §10 of `RESEARCH.md` identified in this project's original accuracy
figures applies to our own corpus too. The real-audio benchmark exists to stop
us fooling ourselves the same way twice.

---

## Real audio — GuitarSet

[GuitarSet](https://zenodo.org/records/3371780) — Xi, Bittner, Ye, Newbold,
Pauwels & Bello, *GuitarSet: A Dataset for Guitar Transcription*, ISMIR 2018.
**CC BY 4.0**, so it is free to use with attribution; it is not redistributed
here.

360 excerpts of solo acoustic guitar across five styles, six players, comping
and soloing. Recorded with a hexaphonic pickup, so every string is annotated
separately — which is what makes per-note ground truth possible at all. Real
inharmonicity, real pluck-position comb filtering, real room.

### Getting it

~700 MB. Put it anywhere outside the repo.

```sh
mkdir guitarset && cd guitarset
curl -L -o annotation.zip      "https://zenodo.org/records/3371780/files/annotation.zip?download=1"
curl -L -o audio_mono-mic.zip  "https://zenodo.org/records/3371780/files/audio_mono-mic.zip?download=1"
python -c "import zipfile;zipfile.ZipFile('audio_mono-mic.zip').extractall('audio')"
cd -
python test/guitarset_windows.py <path-to-guitarset>   # writes windows.json
node   test/real.mjs             <path-to-guitarset>
```

### How windows are chosen

`test/guitarset_windows.py` turns per-string note annotations into analysis
windows of two kinds. Ground truth is the set of rounded MIDI pitches that
genuinely sound across a window, not everything struck nearby.

- **comp** — one strum, fenced from just after its onset to just before the
  next. This is the app's actual use case: fence one chord, hit Analyze.
  Onsets within 80 ms are treated as one strum; a note counts only if it
  sustains through 70% of the window; windows shorter than 0.40 s are dropped.
- **solo** — one note with nothing else sounding across it, at least 0.35 s
  long. This exists to measure a specific complaint — *play one note and you
  get a stack back* — as a number rather than an impression.

Capped at six windows per source file so no single player or tempo dominates.

### Result, 2026-07-31

Current `master`, default settings.

```
kind   wins   recall  prec.    F1     oct  5th  oth   P(real) hit/ghost   ms
comp    367   0.704  0.675  0.689   216  148   88   0.71 / 0.59        21
solo    905   0.994  0.401  0.571   235  226  885   0.89 / 0.64        19

single notes: exactly one note returned, and correct, 262/905 = 0.290
              mean spurious extra notes per single note: 1.48
chords:       every note right and no ghosts, 30/367 = 0.082
```

**Read this next to the synthetic numbers, not instead of them.** The synthetic
corpus reports F1 0.790; real guitar gives 0.689 on chords. That gap is the
honest cost of a corpus that agrees with the model.

Three things it says plainly:

1. **Recall on single notes is 0.994 — the pitch is essentially always found.**
   The problem is never that the note is missed.
2. **Precision on single notes is 0.401**, with **1.48 spurious extra notes per
   note** and only **29%** of single notes returning exactly one note. This is
   the reported complaint, reproduced and quantified. It is a precision
   problem, and specifically an over-detection problem.
3. **`oth` ghosts dominate the solo case (885)** — more than octave (235) and
   fifth (226) errors combined. These are not harmonic relatives of the played
   note, so neither redundancy pruning nor anything else that reasons about
   harmonic subsets can remove them. That is a different failure from the one
   `handoff.md` is organised around.

The confidence readout does separate on real audio (0.89 hits vs 0.64 ghosts on
solo, 0.71 vs 0.59 on comp), but the margin is far narrower than the synthetic
corpus suggests (0.79 / 0.38).

### What this benchmark does not cover

Guitar only. No piano, no voice, no ensemble, nothing with drums — so the HPSS
path is untested against real percussion. Windows are short (0.30–1.20 s),
which is at the low end of what the app recommends fencing, and below the
~1.5 s the bass register wants. And GuitarSet is close-mic'd studio material,
so it understates room and noise.
