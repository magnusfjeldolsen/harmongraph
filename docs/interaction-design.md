# Interaction design — tapping notes on the key map, and hearing the result

Design note for the change from *"find the row, hit the checkbox, scroll down, press Play chord"* to
*"touch the note, hear it, keep listening."* Nothing here is implemented. Written against the current
files: `js/ui/keyboard.js`, `js/ui/panels.js`, `js/audio.js`, `js/state.js`, `js/main.js`, `css/app.css`.

---

## 0. The one number that makes this tractable

`selectedNotes()` in `js/ui/panels.js:32` ends with `out.slice(0,12)`. **There are never more than 12
candidates, and usually 4–7.** Every hard problem below dissolves once you stop thinking of the key map
as 88 targets and start thinking of it as *at most 12*.

The arithmetic that motivates this. At a 360 px viewport: `.wrap` takes 12 px padding each side, the
panel border takes 1 px each side, so `#keys` is **334 CSS px**. 52 white keys → **6.4 px per white
key**; black keys are `ww*0.62` → **4.0 px**. A finger contact patch is 8–10 mm ≈ 40 px. Direct
per-key tapping at full 88-key width is not a tuning problem, it is impossible, and no amount of
hit-slop fixes it while the target count is 88.

With 12 targets in 334 px you get 28 px each. With 6 you get 55 px. That is a usable control, and it
is usable *because the detector already narrowed the field*. So:

> **The hit targets are the detected notes, not the keys.** The keyboard underneath stays a picture.

Everything else follows from that sentence.

---

## 1. The widget

Three horizontal bands inside the existing `#keys` canvas. One canvas, one pointer handler, one draw
call — no new elements, no DOM per note.

```
┌────────────────────────────────────────────────────────────┐
│ A0 ▏   ▏  ▏▏   ▏      ▏          ▏               C8        │ ribbon   12 px
│         └───────── window ─────────┘                       │
├────────────────────────────────────────────────────────────┤
│    ▛▀▀▜   ▛▀▀▜  ▛▀▀▜      ▛▀▀▜  ▛▀▀▜        ▛▀▀▜           │ caps     26 px
│    ▌C2 ▐  ▌G2 ▐ ▌C3 ▐     ▌E3 ▐ ▌G3 ▐       ▌D4 ▐          │  ← targets
│    ▙▄▄▟   ▙▄▄▟  ▙▄▄▟      ▙▄▄▟  ▙▄▄▟        ▙▄▄▟           │
│      │      │     │         │     │           │            │ stems
│ ▐█▌▐█▌ ▌▐█▌▐█▌▐█▌ ▌▐█▌▐█▌▐█▌ ▌▐█▌▐█▌ ▌▐█▌▐█▌▐█▌ ▌▐█▌       │ keys    54 px
│ C2         C3         C4         C5                        │
└────────────────────────────────────────────────────────────┘
```

**Ribbon (12 px, not interactive).** Full A0–C8, one tick per detected note, a bracket showing where
the window below sits. Keeps the "voicing on an 88-key map" reading that the README promises, at the
one job 4 px per key is actually good at: showing register and spread at a glance.

**Caps (26 px, the only hit targets).** One cap per detected note. Positioned at its key's centre,
then de-collided: any two caps closer than the minimum width get pushed apart, and the stem slants to
keep pointing at the true key. Cap width is `clamp(available/N, 28, 56)` px. A minor 2nd in the
voicing is 7 px apart on the keys and 30 px apart in the cap lane — the stems cross, and that visibly
*means* "these two are adjacent", which is information rather than a defect.

**Keys (the rest).** Windowed, not full 88. The window is the detected span padded by four semitones
each side, expanded to a minimum of two octaves, clamped to A0–C8. A typical C2–D5 voicing gives
27 white keys → **12.4 px per white key**, three times the current density. There is no key hit test
at all, so the white/black overlap geometry stops being a correctness problem and becomes purely a
drawing problem — which `drawKeys()` already solves.

**Desktop** (`.wrap` maxes at 1080, so `#keys` is ~1054 px) has room for both: keep the window fitted
but let it default wider, and extend each note's hit region down from the cap to include its key
column, so the pointer target is the whole vertical strip. On a mouse, 12 px is a fine target.

### Colour, and where confidence goes

- **Key fill** keeps `dynColor(db, …)` exactly as now. The level ramp is the primary channel and does
  not change.
- **Cap fill** is the same `dynColor` when the note is **on**. When the note is **off** the cap is
  hollow — 1 px stroke in that same colour, transparent interior, name dimmed to `--dimmer`, and the
  key underneath drops to the plain unselected `#e2e8ea` / `#141d23`. An excluded note therefore stays
  in the same place, at the same size, with the same colour identity, and one tap brings it back. It
  is never removed from the layout — the row of caps is stable for the life of an analysis.
- **Violet** (`--vi`, "likely overtone") becomes a thin underline beneath the cap, not an outline
  around the key. It marks the note as *nested in another note's harmonic series*, which is a claim
  about the voicing's geometry, and it must never change a target's size, position or default state.
- **Delete the 3 px confidence tick strip** (`js/ui/keyboard.js:47-53`). At 92 px canvas height on a
  phone it is three pixels of a number that `handoff.md` §2 says is inverted on one of six test
  timbres. It reads as data and is not.

---

## 2. Gestures

`#wave` has `touch-action:none` and owns one finger, two fingers, and the wheel (`css/app.css:92`,
handlers at `js/main.js:19-87`). That was the right call there — RESEARCH §3 — because fencing *is*
the product on that canvas and the waveform is a viewport the user navigates.

The key map is the opposite case: it is 92 px of a long scrolling page, it has no viewport to
navigate (the window is chosen for you), and stealing vertical drag would recreate exactly the
wavesurfer bug §3 rejects — region drag competing with container scroll.

> **Rule: `#keys` keeps `touch-action:pan-y`, takes one pointer only, and never calls
> `preventDefault()` on a touch.** Vertical belongs to the page. Horizontal belongs to the widget.
> Multi-touch belongs to nobody.

The two canvases then have *visibly* different contracts — you can read which is which off the CSS —
rather than a convention someone has to remember.

| Gesture | What happens | What you hear |
|---|---|---|
| **Tap a cap** | Toggles that note. Commits on `pointerup`. | The note sounds on `pointerdown`, single note, current voice, at its measured velocity. Direction-independent — you hear it whether you are adding or removing it. |
| **Tap a cap that is off** | Turns it on. | Same. |
| **Horizontal drag across caps** | **No toggling.** Auditions each cap as the pointer crosses it, previous note released. | A scrub across the voicing — the fastest way to check "which of these do I actually hear in the recording?" |
| **Vertical drag** | The browser scrolls the page. We get `pointercancel`, drop the pending toggle, release the preview with a 40 ms ramp. | A brief blip if the finger started on a cap. Accepted; see §6. |
| **Long press (450 ms)** | Solos that note in the running loop while held. Release restores the set. No toggle on release. | Everything else muted. This is the "is that E4 in there?" test at zero cost. |
| **Second finger** | Ignored, and cancels any pending toggle. | Nothing. |
| **Tap the ribbon** | Re-centres the window there. | Nothing. |
| **Tap a bare key** | Nothing. Deliberately — see §4. | Nothing. |
| **Keyboard (desktop)** | ←/→ move a focus ring between caps, Space toggles, Enter auditions. | As above. |

Tap detection: `pointerdown` records `(x, y, t)`; `pointerup` commits only if movement < 10 px and
`t < 500 ms`. Long press is a 450 ms timer armed on `pointerdown` and cleared by any of move, up,
cancel. No double-tap anywhere — see §6.

Canvas needs `user-select:none; -webkit-touch-callout:none` and a `contextmenu` `preventDefault`, or
iOS fires the selection callout on the long press.

---

## 3. Playback: the loop is the instrument

RESEARCH §6 is unambiguous — *"the strongest verification loop isn't visual, it's aural"* — and the
current UI buries that finding under four buttons at the bottom of a panel that is ~400 px below the
key map on a phone. That distance is the actual reason playback "feels like a separate step". The
sequencing of state changes is secondary; the scroll is primary.

### 3.1 The primary control is A/B, not Play chord

Playing your chosen set on its own tells you it is *a* chord. It does not tell you it is *the* chord.
`buildAB()` (`js/audio.js:339`) already makes the comparison — recording → gap → resynthesis, looped —
and it is demoted to a `mini` button in the third row. Promote it. One primary button, always visible:

```
▶ A/B loop
```

with a segmented control for what the loop contains: `rec` · `A/B` · `synth`. Default `A/B`.

### 3.2 It must be reachable while you are touching the keys

Put the transport in a sticky bar pinned to the bottom of the viewport whenever `#resPanel` is
visible and the key map is on screen:

```css
.transport{position:sticky;bottom:0;background:var(--panel);
           border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
```

Roughly 48 px. That is the whole "make playback immediate" problem on a phone, and it is CSS.

### 3.3 Edits must not re-trigger the loop

Today every toggle runs `clearSynthCache()` then `restartSynth()` (`js/ui/panels.js:94-95`), which
throws away the rendered chord, re-renders (90–240 ms per RESEARCH §6) and **restarts the loop from
the top**. Tap three notes quickly and you get three stutters and never hear a complete cycle. This
is fatal to "tap and listen" and it is the single biggest implementation change here.

**Fix: render per note, schedule per cycle.**

Split `renderChord()` (`js/audio.js:313`) into

```js
renderNote(midi, vel, voice) -> Float32Array   // one note, ~2.5 s, normalised to a fixed reference
```

cached by `voice|midi|velBucket` (8 velocity buckets). `pianoVoice` and `rhodesVoice` already take
exactly these arguments and already write into a shared buffer at an offset — the per-note function
is what is inside the `rows.forEach` at `js/audio.js:317-324`, extracted. The per-mix normalisation
and the Rhodes tremolo move out to a master `GainNode` chain, where the tremolo belongs anyway.

A chord is then N `AudioBufferSourceNode`s started at the same time. Consequences:

- **Toggling costs nothing.** The next cycle reads `noteOn` and schedules a different set. Nothing
  re-renders, nothing restarts, the loop never stutters. The user hears their edit at the top of the
  next bar, which is how every musician expects an edit to land.
- **Tap preview is free** — it is the same cached buffer, started immediately, on the same voice at
  the same velocity as the loop uses. Preview and loop cannot disagree, because they are one buffer.
- **"Roll it up"** stops being a re-render and becomes a 110 ms stagger in the scheduler.
- **A/B** stops needing `buildAB()`'s concatenated buffer: schedule the selection region straight
  from `S.buf` (the transport already does this, `js/audio.js:74-77`), then the note stack after the
  gap. Dropping `buildAB` also drops the 3.2 s clamp it imposes on the recording half.
- `synthCache`, `clearSynthCache()` and `restartSynth()` all disappear, along with the exported
  bindings that exist only because a module cannot assign to an imported one (`js/audio.js:396-400`).

Cost, honestly: a ~40-line lookahead scheduler (100 ms tick, 250 ms horizon) replaces one
`source.loop = true`, and you lose sample-exact loop points. Worth it — live editing is the entire ask.

Pre-render the ≤12 candidate notes in an idle loop right after `renderResult()`, while the user is
reading the chord name. 12 notes × ~30 ms ≈ 400 ms of background work buys a zero-latency first tap.
Cap the buffer cache at 24 entries (24 × 2.5 s × 44.1 kHz × 4 B ≈ 10 MB — acceptable, but bound it).

### 3.4 One caveat worth putting in front of the user

The tap preview is a **piano synth**, and the recording is probably not a piano. When you compare a
synthesised E4 against a guitar chord, timbre difference dominates and your ear is answering the
wrong question. The unbiased comparison is the harmonic-comb isolation — *"Ticked notes only"*,
`buildIso('notes')` at `js/audio.js:205-225` — because it is made out of the actual recording.

So: synth preview is the *fast* answer, comb isolation is the *true* one. Keep comb isolation one tap
away from the selected note (see the detail line, §5) with a visible spinner, since it costs an ISTFT.
Do not pretend the instant preview is the same thing.

---

## 4. Adding a note the algorithm missed

The baseline in `handoff.md` §2 is **recall 0.857**. About one note in seven never appears in the
candidate list at all. A pure toggle interface over the detected set has a hard ceiling at 86% and
cannot be argued out of it.

Tapping a bare key to add a note would break the §0 bound — the target count goes from 12 back to 88,
and we are back at 4 px. So do not do that on a phone.

**The control already exists and is in the wrong panel.** The note threshold slider
(`index.html:92-94`) re-runs `renderResult()` with no refit (`js/main.js:100`) and is instant, and
`xamp` is computed for every candidate with `detN > 0.03` (`js/analysis.js:110-113`), well below the
0.12 default. So notes surfaced by lowering the threshold arrive with a valid level *and* a valid
`pFund` — they are fully-formed candidates, not guesses.

Mirror that slider directly under the key map and relabel it for what it does here:

```
how many notes to consider    few ◀──────●────────▶ many
```

Adding a note is a *detector* operation, not a UI operation. Say so with the placement.

On desktop, additionally allow tap-on-bare-key to force a note on, since 12 px targets and a mouse
make it safe. It is a superset feature, not the load-bearing path.

---

## 5. The voicing table

**It survives, it loses its checkbox, and it stops being the control.**

Two live controls over one boolean is a synchronisation liability for no benefit, and the table's real
value was never the checkbox — it is the numbers, and there are about to be more of them
(`cents` from `handoff.md` Task 6, "explained by E2, 4th partial" from RESEARCH §10 fix 1). Those are
reading material.

- The checkbox column (`js/ui/panels.js:91-97`) goes. The `solo →` eyebrow at `index.html:122` that
  points at it goes with it.
- Rows become *reflective*: a row for an off note drops to `opacity:.45` with the name struck. The
  whole row is a 40 px tap target that toggles — that is the accessible path and the desktop path,
  and it costs one `tr.onclick`. Give the row `role="switch"`, `tabindex="0"`, `aria-checked`, and
  Space/Enter, so there is a real focusable control behind the canvas.
- On a phone the table collapses into `<details>` labelled `Voicing detail (6 notes)`, closed by
  default. On desktop it sits open beside the transport.

Its place at the top of the panel is taken by a **detail line** under the key map, one row high,
showing whichever note was last touched:

```
E4 · 329.6 Hz · −7 dB · 38% real          [ isolate from recording ]
sits on E2's 4th partial
```

That second line is buildable **today, with no DSP change**: for each detected note, look for a lower
*selected* note `j` where `2^((midi_i − midi_j)/12)` is within ~30 cents of an integer `h`. It is
pitch arithmetic, not analysis. RESEARCH §10 fix 1 sharpens it — the `argmax_j` is already computed
and thrown away in the `pfund` loop at `js/analysis.js:118-130` — but the geometric fact is the part
the user needs, because it is what makes the doubt *testable*: mute E2, listen, decide.

---

## 6. Where the algorithm's uncertainty goes

The requirement is that the interaction must not depend on `pFund` being trustworthy. It currently
does, in the worst possible place:

```js
// js/ui/panels.js:49
if(noteOn.size===0) rows.forEach(r=>{ if(r.pf>0.5) noteOn.add(r.i); });
```

**The default selection is chosen by the one number `handoff.md` §2 says is unreliable, and inverted
on the `dark` timbre.** On guitar (RESEARCH §10) almost everything comes back below 0.5, so the app
opens with most of the chord already muted and the user's first job is to undo the algorithm's least
defensible opinion.

Three changes, in order of value:

1. **Default every detected note to on.** One line. Thresholding already happened in
   `selectedNotes()`; `pf` is a second, weaker gate applied on top of it, and it should not be a gate
   at all. The user's job becomes subtractive — listen to the loop, mute what is not there — and
   subtraction with instant audio is far easier than addition, because you can hear a note vanish
   from a mix but you cannot imagine one appearing.

2. **Make a user decision outrank the detector.** Today, moving the threshold slider re-runs
   `renderResult()`; if a note the user explicitly turned on falls below the new threshold it leaves
   `S.rows`, and `playSynth`'s `(S.rows||[]).filter(r => noteOn.has(r.i))` (`js/audio.js:373`)
   silently drops it. The user's explicit choice loses to a slider. Add a tri-state vote:

   ```js
   // js/state.js
   let noteVote = new Map();          // nnlsIndex -> 1 (forced on) | -1 (forced off)
   ```

   `renderResult()` then builds rows from `detector candidates ∪ {i : noteVote.get(i) === 1}` and
   seeds `noteOn` as `vote === -1 ? off : on`. `noteOn` stays the single source of truth that
   `audio.js` and `buildIso` read, so their code is untouched. Forced-on notes render with a distinct
   cap outline (cyan, `--cy`) so "I decided this" is visually different from "the detector found this".

3. **Reframe the violet.** Not "probably fake" — *"nested in another note's series, here is which
   one, go and check"*. Same colour, same data, a claim the ear can adjudicate instead of a number
   the user has to trust.

**Bug found while reading, unrelated to the redesign but in the same lines.** `noteOn` is created once
at `js/state.js:27` and **never cleared** — no `noteOn.clear()` exists anywhere in `js/`. After a
second analysis `noteOn.size !== 0`, so the seeding line at `panels.js:49` is skipped and the new
chord inherits whichever NNLS indices happened to be ticked for the previous one. For a different
chord those indices are arbitrary. `analyze()` must clear `noteOn` (and `noteVote`) before calling
`renderResult()`.

---

## 7. Layout

### Phone, 360 px

```
┌────────────────────────────────┐
│           C maj9               │  chordbox, unchanged
│      Cmaj7 93   Em7 71         │
├────────────────────────────────┤
│ A0 ▏  ▏  ▏▏  ▏     ▏      C8   │  ribbon
│      └──── window ────┘        │
│   ▛▀▜  ▛▀▜ ▛▀▜  ▛▀▜  ▛┄┄▜      │  caps — hollow = off
│   ▌C2▐  ▌G2▐ ▌C3▐  ▌E3▐  ┊G3┊  │
│     │    │    │     │      │   │
│ ▐█▌▐█▌ ▌▐█▌▐█▌▐█▌ ▌▐█▌▐█▌▐█▌   │  keys
│ C2       C3       C4           │
├────────────────────────────────┤
│ quiet ▬▬▬▬ loud    ▪ nested    │  legend
├────────────────────────────────┤
│ E3 · 164.8 Hz · −7 dB · 38%    │  detail line
│ sits on E2's 4th partial  [iso]│
├────────────────────────────────┤
│ notes to consider  few ●── many│  threshold, mirrored
├────────────────────────────────┤
│ ▸ Voicing detail (6 notes)     │  <details>, was the table
├────────────────────────────────┤
│ ▸ Log spectrum                 │
│ ▸ Listen to a layer            │
└────────────────────────────────┘
 ────────── sticky, 48 px ────────
│ ▶ A/B loop  │rec│A/B│syn│ pno ▾│
```

Everything from the chord name to the threshold slider is above the fold on a 360×640 screen, and the
transport is pinned. Touching a note and hearing the loop change never requires a scroll.

### Desktop, 1080 px

```
┌──────────────────────────────────────────────────────────────────────┐
│                              C maj9                                  │
│                    Cmaj7 93    Em7 71    Am11 64                     │
├──────────────────────────────────────────────────────────────────────┤
│ A0 ▏  ▏ ▏▏  ▏    ▏        ▏                                    C8    │
│         └──────────────── window ──────────────┘                     │
│      ▛▀▀▜   ▛▀▀▜   ▛▀▀▜      ▛▀▀▜   ▛▀▀▜        ▛┄┄┄▜                │
│      ▌ C2 ▐ ▌ G2 ▐ ▌ C3 ▐    ▌ E3 ▐ ▌ G3 ▐      ┊ D4 ┊               │
│        │      │      │         │      │           │                  │
│  ▐█▌▐█▌ ▌▐█▌▐█▌▐█▌ ▌▐█▌▐█▌▐█▌ ▌▐█▌▐█▌▐█▌ ▌▐█▌▐█▌▐█▌ ▌▐█▌▐█▌         │
│  C2          C3          C4          C5          C6                  │
├──────────────────────────────────────────┬───────────────────────────┤
│ Note  Hz     Level      Real   Nested in │  ▶ A/B loop               │
│ C2    65.4  ████████    91%    —         │  │ rec │ A/B │ synth │    │
│ G2    98.0  ██████      78%    —         │  Grand piano │ Rhodes     │
│ C3   130.8  █████       62%    C2 · 2nd  │  Measured dynamics  [on]  │
│ E3   164.8  ████        38%    C2 · 5th  │  Roll it up               │
│ G3   196.0  ███         44%    C2 · 6th  │                           │
│ D4   293.7  ██          31%    — (off)   │  notes to consider        │
│                                          │  few ◀───●──────▶ many    │
├──────────────────────────────────────────┴───────────────────────────┤
│ Log spectrum …                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

The transport is not sticky here — it is already beside the keyboard.

---

## 8. Implementation order

Each step is independently shippable and leaves the app working.

**1. State model — `js/state.js`, `js/analysis.js`, `js/ui/panels.js`.** *(new, ~30 lines)*
Add `noteVote`. Clear `noteOn` and `noteVote` at the top of `analyze()` — fixes the stale-selection
bug on its own. Change the `pf > 0.5` seed at `panels.js:49` to all-on, honouring votes. Ship this
first: it is the largest behaviour improvement per line in the whole document, and it needs no canvas
work.

**2. Per-note rendering — `js/audio.js`.** *(rewiring, ~60 lines)*
Extract `renderNote(midi, vel, voice)` from `renderChord`'s `forEach` body. Cache by
`voice|midi|velBucket`. Move normalisation and the Rhodes tremolo to a master gain chain. Keep
`playSynth` working on top of it. No UI change yet — verify by ear that the piano and Rhodes still
sound identical.

**3. Scheduler — `js/audio.js`.** *(new, ~50 lines)*
Lookahead loop scheduling the current `noteOn` set each cycle. Re-implement A/B as
`S.buf` region + gap + note stack. Delete `synthCache`, `clearSynthCache`, `restartSynth`, `buildAB`
and their imports in `panels.js`. Add `previewNote(midi)` and `soloHold(midi)/soloRelease()`.
After this the existing checkboxes already edit a running loop with no stutter — worth stopping here
to confirm the audio behaviour before touching the canvas.

**4. Keyboard geometry — `js/ui/keyboard.js`.** *(substantial rewrite, ~120 lines)*
Window fitting; the ribbon band; the cap band with de-collision; stems. Have `drawKeys(rows)` return
and cache a geometry object `{caps:[{i, midi, x, w, y, h}], window, ribbon}` and export
`hitTest(x, y) -> row | null` beside it. Drop the confidence tick strip. Draw off notes hollow.
Nothing is interactive yet — this step is purely visual and reviewable as a screenshot.

**5. Pointer wiring — `js/main.js`.** *(new, ~70 lines)*
Next to the existing waveform gestures, which is where the file already keeps cross-module pointer
code. Single-pointer tap / horizontal audition / long-press solo, `pointercancel` handling, focus ring
and arrow keys. `css/app.css:125` keeps `touch-action:pan-y`; add `user-select:none` and
`-webkit-touch-callout:none`.

**6. Panel restructure — `index.html`, `css/app.css`, `js/ui/panels.js`.** *(rewiring)*
Detail line; table demoted to `<details>` on phone with row-toggle and no checkbox; threshold slider
mirrored under the key map; the sticky transport with the A/B segmented control.

**7. Nested-partial caption — `js/ui/panels.js`.** *(new, ~15 lines)*
Pure pitch arithmetic over the row list, no DSP change. Feeds both the detail line and the new table
column. Swap in the real `argmax_j` when RESEARCH §10 fix 1 lands.

Steps 1–3 are audio and state and can be done without opening the canvas files. Steps 4–5 are the
canvas. Step 6 is layout. They can go in that order over roughly two sittings.

---

## 9. Decided against

**Pinch-zoom on the key map.** Tempting for the density problem, but it puts a second two-finger
gesture into a page that already has one on a different canvas, and it competes with page scroll —
the exact failure §3 documents. The window auto-fits the voicing instead, which removes the need. If
someone wants full 88 they tap the ribbon.

**Double-tap for anything.** Double-tap is a browser zoom gesture on mobile and would add ~300 ms of
ambiguity to *every single tap*, in a UI whose whole point is that a tap is immediate.

**Drag-to-toggle across keys.** One horizontal flick would flip six notes, and undoing that on a
canvas requires an undo stack that does not exist. Drag auditions; only a tap commits. This is also
why drag can be free and unambiguous — nothing destructive rides on it.

**A separate `<button>` per note in the DOM instead of a canvas.** Genuinely tempting: free hit
targets, free accessibility, free focus handling. Rejected because it cannot render the *spatial*
information — the point of the key map is that you see a wide-open drop-2 voicing differently from a
close cluster, and a row of buttons erases that. The `role="switch"` table rows cover the
accessibility case instead.

**Rebuilding the chord buffer on every toggle (i.e. keeping the current architecture and just moving
the checkbox to the canvas).** Would have been a much smaller diff. It also would have made every tap
cost 90–240 ms and restart the loop, which is precisely the thing that makes the current UI feel like
playback is a separate step. The per-note scheduler is the price of "immediate".

**Showing `pFund` as a number on the key map.** It is on the detail line and in the table, which is
enough. Putting an untrustworthy percentage on the primary control invites people to act on it.

---

## 10. Where the framing needs pushing back

Three things, plainly.

**"Tap on identified notes to activate or deactivate them" cannot be the whole interface.** Recall is
0.857. One note in seven is not in the list to be tapped. A toggle-only UI silently caps the tool's
accuracy at the detector's recall and gives the user no way to notice, let alone disagree. The
missing-note path has to exist, and §4 argues it should be the threshold slider rather than a
keyboard gesture — but it has to be *somewhere*, and right now it is in a different panel under a
label that does not suggest it.

**"Just play the notes you have chosen" is the weaker half of the verification loop.** Your chosen
set played on its own always sounds like a plausible chord — that is what a chord is. RESEARCH §6
found the value is in the *comparison*, and `buildAB()` already implements it while sitting in a
`mini` button in the third row of the fourth section. The primary control should be A/B, and "play
the notes alone" should be a mode of that loop rather than the headline. This is a small
disagreement with the request and I think the request is wrong on it.

**The instant preview is a piano playing your guess, not the recording playing it.** For guitar —
the material RESEARCH §10 says is currently failing — the timbre gap is large enough to swamp the
judgement you are trying to make. The comb isolation is the honest test and costs an ISTFT. The
design above keeps both and labels which is which; do not let the fast one quietly become the only
one.

And one thing the framing gets exactly right, which is worth stating because it constrains everything
above: **"this is mostly a surfacing problem, not a new-engine problem."** `noteOn`, `buildIso`,
`pianoVoice`, `rhodesVoice` and `buildAB` all work. Of the seven implementation steps, three are
rewiring, three are new canvas code, and one is a thirty-line state change that fixes a bug and
removes the app's dependence on its own least reliable number.
