# Playing music and recording it at the same time — what iOS actually allows

Written against the W3C Audio Session spec, the WebKit source, Apple's
AVFoundation documentation and the relevant bug trackers, as of **August 2026**.
No shipped file was touched.

Every claim below is tagged: **[spec]** = normative text in a published
specification; **[source]** = read directly out of WebKit or Chromium; **[docs]**
= Apple/Mozilla/W3C documentation; **[reported]** = developer reports, bug
trackers, forum threads; **[inference]** = my reasoning from the above, not
independently confirmed; **[untested]** = worth five minutes on a real device
before anyone builds on it.

Companion documents: `RESEARCH.md` §2 (the four recording traps),
`js/state.js:55-86` (`audioSession()`, `acReady()`), `js/audio.js:185-221`
(the record handler).

---

## 0. Verdict

**Not possible on iOS Safari, and it will not become possible by trying harder.
Two independent walls, either of which alone is fatal.**

**Wall one — the platform.** `getUserMedia({audio:true})` forces the process's
`AVAudioSession` into `AVAudioSessionCategoryPlayAndRecord`, which is
*non-mixable by default* **[docs]**. Native apps escape by passing
`AVAudioSessionCategoryOptionMixWithOthers`. WebKit never passes it — the string
does not appear anywhere in `AudioSessionIOS.mm` **[source]** — and the Audio
Session API exposes no way to ask for it. There is one open W3C issue requesting
that options be exposed (`w3c/audio-session#18`, opened Aug 2024, no assignee,
no PR, no implementer position). The spec's only mixable type is `ambient`, and
the spec *ends microphone tracks* when the type is anything other than
`play-and-record` or `auto` **[spec]**. So the one type that mixes is definitionally
the one type that cannot record. This is not an oversight to route around; it is
the design.

**Wall two — physics, and it is the more interesting one.** Suppose the wall
came down tomorrow. What you would then capture is your own phone's speaker,
20 cm from your own phone's mic. An iPhone speaker rolls off at roughly
12 dB/octave below 1 kHz **[reported]**, so every bass note in the voicing —
the notes this app exists to find — is simply not in the recording. This is also
exactly what Snapchat gets: iOS has *no* public API for capturing another app's
audio digitally (`replayd` runs capture out-of-process specifically "to ensure
the recorded content is never accessible to the app process" **[docs]**), so the
music in a Snapchat video arrives through the microphone as acoustic bleed,
which is why it vanishes entirely when the user has headphones in **[reported]**.
**The feature the user is asking to copy would, if it existed, produce audio
this app cannot analyse.**

**What to do instead:** play the music from a *different device* and record it
acoustically — which already works, needs no code, and costs pitch accuracy
almost nothing (§5.1) — or get the file into the app and skip the acoustic path
entirely, which is already shipped and is strictly better (§5.3).

---

## 1. The Audio Session API as it actually stands

**Status.** W3C Working Draft, **13 November 2024** — still the latest `/TR/`
publication as of August 2026 **[spec]**. Editors: Youenn Fablet (Apple),
Alastor Wu (Mozilla), Media Working Group.

This API is young but it is **not moving**. The `w3c/audio-session` repository
took exactly three substantive-looking commits in all of 2025 — two on 25 March
renaming "suspend" to "interrupt" and linking interruption definitions, one on
21 August updating `CONTRIBUTING.md` — and **nothing in 2026** **[source]**.
Roughly two dozen issues are open, none are assigned, there are **0 open pull
requests**, and the Candidate Recommendation tracking issue (#44) has sat open
since June 2025. Anyone planning around "this will improve soon" should not.

### The six types

```webidl
enum AudioSessionType {
  "auto", "playback", "transient", "transient-solo", "ambient", "play-and-record"
};
```

| Type | Spec wording **[spec]** | WebKit `CategoryType` **[source]** | iOS `AVAudioSessionCategory` **[source]** |
|---|---|---|---|
| `auto` | "lets the user agent choose" | `None` (clears the override) | whatever `updateSessionState()` picks |
| `playback` | "should not mix with other playback audio" | `MediaPlayback` | `AVAudioSessionCategoryPlayback` |
| `transient` | "such as a notification ping… maybe also 'duck'" | `AmbientSound` | `AVAudioSessionCategoryAmbient` |
| `transient-solo` | "should pause/mute all other audio and play exclusively" | `SoloAmbientSound` | `AVAudioSessionCategorySoloAmbient` |
| `ambient` | "mixable with other types of audio" | `AmbientSound` | `AVAudioSessionCategoryAmbient` |
| `play-and-record` | "used for recording audio" | `PlayAndRecord` | `AVAudioSessionCategoryPlayAndRecord` |

Two details in that table are worth pausing on. `transient` and `ambient` map to
the *same* WebKit category, so the "ducking" the spec describes for `transient`
is not implemented on iOS — you get plain ambient. And `auto` does not mean
"ambient"; it means "clear my override and let `MediaSessionManagerCocoa` decide",
which is a different thing with an important consequence (§2).

### Is there any way to say "mix with others"?

**No.** Three separate confirmations:

1. **The type enum has no such value.** `ambient` is the only type the spec calls
   mixable — "Ambient audio, which is mixable with other types of audio. This is
   useful in some special cases such as when user wants to mix audios from
   multiple pages" **[spec]**. Note "pages", not "applications". The spec's
   exclusivity rule is: "An `AudioSessionType` is an exclusive type if it is
   playback, play-and-record or transient-solo" **[spec]**.
2. **There is no options dictionary at all.** The whole API surface is
   `navigator.audioSession.type`, plus `.state` and `.onstatechange` gated behind
   a separate flag. `w3c/audio-session#18`, "Consider exposing/implementing
   audioSession options" (opened August 2024), is the request to expose
   AVAudioSession's `CategoryOptions`. It is open, unassigned, unlabelled, with
   no linked PR and no implementer response **[source]**.
3. **WebKit hard-codes its options and `mixWithOthers` is not among them.**
   `Source/WebCore/platform/audio/ios/AudioSessionIOS.mm` builds the options mask
   for `PlayAndRecord` as **[source]**:

   ```objc
   options |= AVAudioSessionCategoryOptionAllowBluetooth
            | AVAudioSessionCategoryOptionAllowBluetoothA2DP
            | AVAudioSessionCategoryOptionAllowAirPlay;
   // and, unless the receiver is the preferred speaker:
   options |= AVAudioSessionCategoryOptionDefaultToSpeaker;
   ```

   The strings `MixWithOthers` / `mixWithOthers` do not occur in that file. There
   is no path from JavaScript to that mask.

### And `ambient` cannot record

This is the part that closes the loop, and it is normative, not incidental. From
the spec's microphone-track update steps **[spec]**:

> If `audioSession`.`[[type]]` is not `play-and-record` or `auto`, end `track`.

The API's own editor filed the issue that produced this rule.
`w3c/audio-session#3`, "In case an AudioSession is explicitly set, should some
incompatible APIs start failing?", opened by **youennf on 8 November 2022**,
states the constraint directly **[source]**:

> If a web page sets an explicit audio session to ambient, a call to
> `getUserMedia({audio:true})` can only succeed if the active audio session is
> set to play-and-record.

WebKit enforces it at acquisition. `w3c/audio-session#46` (19 August 2025)
reports that setting `type = "playback"` makes a subsequent `getUserMedia()`
throw `InvalidStateError` without ever prompting the user **[reported]** — which,
incidentally, is precisely the bug `js/audio.js:196-198` already avoids by
refusing to call `acReady()` (which sets `playback`) on the record path. That
comment is correct and should stay.

### Browser support

`navigator.audioSession` is **Safari 16.4+ and Safari iOS 16.4+ only**. Chrome:
not supported. Firefox: not supported. Every other engine mirrors one of those
two, i.e. also no **[docs — MDN browser-compat-data, `api/AudioSession.json`]**.
MDN flags it "Limited availability — not Baseline". Shipping it by default was
deliberately partial: WebKit commit `c393587` by youennf, "Enable AudioSession
Web API by default, but only a reduced subset", enables `navigator.audioSession`
and `.type` but gates `.state` and `.onstatechange` behind
`DOMAudioSessionFullEnabled` **[source]**. The app's `audioSession()` helper
therefore has, and will keep having, exactly one lever: the type string.

---

## 2. What Safari actually does with `play-and-record`

**It interrupts. There is no option. Say this plainly to the user.**

### The mechanism, from the source

`MediaSessionManagerCocoa::updateSessionState()` **[source]**:

```cpp
auto category = AudioSession::CategoryType::None;
auto mode = AudioSession::Mode::Default;
if (sharedSession->categoryOverride() != AudioSession::CategoryType::None)
    category = sharedSession->categoryOverride();
else if (captureCount || (isPlayingAudio && sharedSession->category() == PlayAndRecord)) {
    category = AudioSession::CategoryType::PlayAndRecord;
    mode = AudioSession::Mode::VideoChat;
}
...
else if (webAudioCount)
    category = AudioSession::CategoryType::AmbientSound;
...
if (mode == AudioSession::Mode::Default && category == PlayAndRecord)
    mode = AudioSession::Mode::VideoChat;
```

Four things fall out of those fifteen lines.

**(a) `auto` is not an escape hatch.** `DOMAudioSession::setType` maps `auto` to
`CategoryType::None`, which *clears* the override and hands the decision to the
block above **[source]**. `captureCount` non-zero then selects `PlayAndRecord`
unconditionally. So `auto` + a live mic = `play-and-record`, same as asking for
it explicitly.

**(b) `webAudioCount` → `AmbientSound` is the documented silent-switch trap.**
The comment at `js/state.js:55-67` says Web Audio starts in the ambient category
and the ring/silent switch mutes it. That is this line. The comment is correct
and now has a source.

**(c) The mode is always `VideoChat`.** Not sometimes — the final `if` forces it
whenever the category is `PlayAndRecord`, with no conditional on the
`echoCancellation` constraint **[source]**. On iOS that becomes
`AVAudioSessionModeVideoChat` (or `ModeVoiceChat` when the receiver is the
preferred speaker) **[source]**. It is a voice-communication mode, and iOS
applies system-supplied input signal processing in it. The mode that would be
right for this app — `AVAudioSessionModeMeasurement`, which "minimally processes
the input signal" and exists precisely for measurement apps **[docs]** — is
never used by WebKit and cannot be requested from JavaScript. **A web page on
iOS cannot obtain a measurement-grade capture. That is a hard bound on this
app's input quality independent of everything else in this document.**

**(d) A page's explicit type wins over `captureCount`.** `categoryOverride` is
checked *first*. So `audioSession.type = 'ambient'` after a mic track is live
would set the category to `AVAudioSessionCategoryAmbient` while capture is
running. `AVAudioSessionCategoryAmbient` has no input route. **[inference]** the
capture goes silent or the track ends; **[untested]** but see §7.4 — it is a
two-minute experiment and it is the only remaining "maybe" in this whole
document, so someone may as well run it.

### Does it interrupt, duck, or mix?

**Interrupt.** `AVAudioSession.Category.playAndRecord` **[docs]**:

> By default, using this category implies that your app's audio is *nonmixable* —
> activating your session will interrupt any other audio sessions which are also
> nonmixable. To allow mixing for this category, use the `mixWithOthers` option.

Spotify, Apple Music and YouTube all use non-mixable `playback`. Safari
activating `PlayAndRecord` therefore stops them. This is not theoretical — it is
the same mechanism behind the reported cases of a Safari tab stopping Spotify
playback, and behind WebKit's own YouTube-interrupts-Music bug **[reported]**.

**Not ducking.** `duckOthers` is strictly opt-in and implicitly sets
`mixWithOthers` **[docs]**; WebKit sets neither. Anything the user hears is a
route change, not ducking (§3).

### Platform differences

| Context | Behaviour |
|---|---|
| **iOS Safari (tab)** | Interrupts. `AVAudioSession` is the governing mechanism, category is exclusive, no option. |
| **iOS home-screen web app** | Same. See §4.3. |
| **macOS Safari** | **Does not interrupt.** `AVAudioSession` category exclusivity is an iOS mechanism; `AudioSessionMac::setCategory` delegates to `AudioSessionCocoa` and then does routing *arbitration*, not exclusion, and it returns early for ambient/audio-processing **[source]**. macOS apps mix freely through CoreAudio. **[inference]** from the source structure plus platform architecture: on a Mac you can play music in one app and record it in Safari with no session conflict at all. |

That asymmetry is worth remembering: **the thing the user wants already works on
a Mac and cannot work on the phone.** If they have a laptop, §5.4 is the real
answer.

---

## 3. Is the Snapchat comparison sound?

**The mechanism is right. The lag is right. The conclusion does not transfer —
and the reason it does not transfer is the most useful finding here.**

### What Snapchat does — confirmed

`AVAudioSessionCategoryPlayAndRecord` with `mixWithOthers`, and in practice also
`defaultToSpeaker` and `allowBluetoothHFP`. The recipe is documented on Apple
Developer Forums thread 681319, where a developer explicitly sets out to match
Snapchat's behaviour **[reported]**:

```swift
try AVAudioSession.sharedInstance().setCategory(.playAndRecord,
    options: [.mixWithOthers, .allowBluetoothA2DP, .defaultToSpeaker, .allowAirPlay])
```

So yes: native iOS has exactly the "play and record without silencing everyone
else" switch, it is called `mixWithOthers`, and it is settable only on
`playAndRecord`, `playback` or `multiRoute` **[docs]**. The user's diagnosis of
the mechanism is correct.

### What the lag is — mostly right, with one correction

Separate two moments, because they have different causes.

**Opening the camera.** Camera startup dominates, and it is large. An Apple Media
Engineer on Developer Forums thread 792147 puts hardware-configuration calls at
**100–500 ms** each, driven by IPC with the capture server **[reported]**. WWDC26
session 303 calls output initialisation "the most expensive part of camera
launch" and demonstrates ~1.0 s versus ~0.5 s with Deferred Start — and never
mentions audio session configuration at all **[docs]**.

**Tapping record, with preview already live** — which is the moment the user is
describing. The camera is warm; that cost is already paid. What remains is
`setActive(true)` on a reconfigured session, adding the audio capture input, and
encoder init. `AVAudioSession.h` states verbatim: **"activating an audio session
is a synchronous (blocking) operation"**, with the recommendation not to activate
from a thread where blocking is a problem **[docs]**. Apps that keep the camera
screen silent do so precisely by *deferring* the audio session work to the record
tap — which by construction moves that cost into the record-tap latency.

So: **the user is right about the record-tap lag** (audio session activation and
route reconfiguration dominate there), and would be wrong if they extended it to
camera-open lag (video path dominates there, by a lot). No published Apple number
exists for `setActive(true)` latency, so do not quote one.

### The audible change in the music is a route change, not ducking

`mixWithOthers` alone triggers no ducking **[docs]**. What the user hears is one
of three route effects **[docs/reported]**:

1. **Speaker → receiver.** Without `defaultToSpeaker`, `playAndRecord` output
   defaults to the earpiece receiver. This is the dramatic "volume fell off a
   cliff" symptom, and it is *the same one* `js/audio.js:164` and
   `js/state.js:60-64` already work around.
2. **A2DP → HFP.** With Bluetooth input allowed, enabling the BT mic drags the
   *output* onto the same Hands-Free Profile — mono, 8–16 kHz. iOS cannot play
   A2DP while taking HFP input. Apple Community thread 253733617 reports Snap and
   Instagram video lagging "for a second" *specifically* on AirPods, which is the
   clearest real-world evidence that route reconfiguration, not camera warm-up,
   drives the record-tap delay.
3. **Sample-rate / IO-buffer reconfiguration**, producing a brief stutter in the
   other app's stream even with everything set correctly.

### Why the comparison does not transfer

Not because the web is missing a flag — though it is — but because of what
Snapchat actually captures.

> **"Screen and audio capture occurs out of the app's process in the ReplayKit
> daemon `replayd`. This is designed to ensure the recorded content is never
> accessible to the app process."**
> — Apple Platform Security, *ReplayKit security in iOS and iPadOS* **[docs]**

iOS has no public API by which any app — native or web — captures another app's
audio digitally. When Snapchat records with music playing, **the music reaches
the file through the microphone**, as acoustic bleed off the phone's own speaker.
The giveaway is well known to users: put headphones in, and the music disappears
from the Snap entirely **[reported]**.

So the honest translation of "make harmongraph do what Snapchat does" is: *record
your phone's loudspeaker with your phone's microphone.* Which is not a
capability. It is the worst possible acoustic path, and §6 is about why.

---

## 4. Home-screen apps, feature flags, and getUserMedia constraints

### 4.1 Does `echoCancellation:false` change the session?

**It is honoured, and it does more than it says — but it does not buy a clean
measurement path.** Three separate findings, and they do not all point the same
way.

**It works, and it also turns off AGC.** WebKit bug **179411**, "getUserMedia
echoCancellation constraint has no affect" (reported 7 November 2017), was
**RESOLVED FIXED on 19 November 2019** for both macOS and iOS **[reported]**.
Before that fix it genuinely was a no-op on iOS, which is where the folklore
comes from. youenn fablet's comment 7 states: *"When setting echoCancellation to
false, we both disable AGC and echo cancellation."* So on WebKit the app's
`autoGainControl:false` is redundant with `echoCancellation:false` — harmless,
and worth keeping for other engines, but the AGC behaviour on Safari is already
implied by the first constraint. `RESEARCH.md` §2 trap 1 stands, with that
footnote.

**Use `false`, not `{exact:false}`.** WebKit bug **286680** (reported 29 January
2025, fixed 31 January 2025) was `{echoCancellation:{exact:false}}` throwing
`OverConstrainedError` **[reported]**. `js/audio.js:200` already uses the plain
form, which is the correct choice — but note what that means: a plain value is an
*ideal* constraint, so a UA that cannot comply is permitted to ignore it silently.
The app never learns whether it got what it asked for.

**It does not change the session category or mode.** The mode is forced to
`VideoChat` whenever the category is `PlayAndRecord`, with no conditional on the
constraint anywhere in `updateSessionState()` **[source]**. The constraint
governs the capture unit, not what the session asks the OS for. The mode that
would be right here — `AVAudioSessionModeMeasurement`, "minimally processes the
input signal" **[docs]** — is unreachable from the web (§2c).

**And there is an open bug that matters a great deal to this app.** WebKit bug
**204467**, "Raw digitally modulated audio not producing correct FFT results in
mobile/desktop/webclip PWA Safari" (reported 21 November 2019, **still NEW**),
was split off from 179411 as the *residual* audio-quality problem after the
constraints were fixed. The reporter's claim: on Safari, `getUserMedia` audio fed
to an `AnalyserNode` is **all zeros above ~10 kHz**, with the same code working
in Chrome, Firefox and Opera **[reported]**.

**[untested]**, and I would not repeat that number without checking it — it is
one reporter, from 2019, and the methodology is not visible. But if it is even
partly true it is directly load-bearing here: `RESEARCH.md` §4 turns on partial
structure, `js/audio.js` walks 14–18 harmonics per note, and a note at 1 kHz has
its 10th partial at 10 kHz. **This is worth a measurement**: record the synthetic
demo chord (`#demoBtn`) off a speaker, run it through the existing analysis, and
compare the high-frequency spectrum against the same buffer analysed directly. If
the mic path really dies at 10 kHz, that is a bigger finding than anything else
in this document and it belongs in `docs/algorithm-assessment.md`, not here.

### 4.2 The Bluetooth trap — actionable, and not currently handled

WebKit passes `AllowBluetooth | AllowBluetoothA2DP | AllowAirPlay` for
`PlayAndRecord`, unconditionally **[source]**. With AirPods or any BT headset
connected, iOS will happily route capture to the headset mic over HFP: **mono,
8–16 kHz** **[docs/reported]**. A 16 kHz capture puts Nyquist at 8 kHz and
removes most of the partial structure the NNLS fit reads to separate a note from
an overtone.

The app cannot prevent this — the options mask is not reachable from JavaScript —
but it can *detect* it cheaply, and it currently does not. See §7.5.

Note the second-order effect, which explains a symptom that would otherwise look
like a bug in this app: HFP is bidirectional, so allowing the Bluetooth *mic*
drags the Bluetooth *output* onto the same profile. iOS cannot play A2DP while
taking HFP input **[docs]**. So on AirPods, pressing record makes everything the
app subsequently plays back — the loop, the resynthesis, the A/B — sound mono and
tinny, and it stays that way until the session category changes. This is the same
family of problem as the receiver-routing issue `js/audio.js:164` already handles,
and the existing `audioSession('playback')` handback is probably the fix for it
too **[untested]**.

### 4.3 Home-screen web app

**No difference, and installing is not an entitlement grant.**

**[inference]**, and I want to be clear that it is inference: no source I found
documents any audio-session difference for `display-mode: standalone` on iOS.
The mechanism is process-wide `AVAudioSession` state managed by WebKit's
`MediaSessionManagerCocoa`, and nothing in that code branches on standalone mode
**[source]**.

The one thing standalone mode *did* historically change is worth knowing so it is
not mistaken for a session issue: `getUserMedia` was flatly broken in home-screen
web apps for two years. WebKit bug **185448**, "getUserMedia not working in apps
added to home screen that run in standalone mode" (reported May 2018), was
**RESOLVED FIXED in iOS 13.4**, February/March 2020 **[reported]**. Related: bug
**180551** on `navigator.mediaDevices` being undefined in standalone mode, and
**208667** for the same problem in third-party iOS browsers, which are WKWebView
and are a separate matter. Anyone testing on an old device may still meet the
symptom; on anything current, installing changes nothing either way.

### 4.4 Feature flags — the full audio inventory, and nothing in it helps

Checked against WebKit trunk `main` @ `917b750511ac` (**1 August 2026**, WebKit
626.1.1, the Safari 27 beta line) and against `safari-7624-branch` (WebKit
624.2.5, shipping Safari 26.x), so trunk-only entries are marked as such
**[source]**.

The iOS *Settings → Apps → Safari → Advanced → Feature Flags* list is generated
by `Source/WTF/Scripts/GeneratePreferences.rb`: a preference appears if its
`status` is one of `developer`, `testable`, `preview` or `stable`, and is hidden
if `unstable` or `internal`. `mature` preferences have no toggle at all. Note
that the preference files most references still name — `WebPreferences.yaml`,
`WebPreferencesExperimental.yaml` — **no longer exist**; there is now a single
`Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml`.

Audio-related flags actually visible on iOS:

| Flag (display name) | Key | Status | Default | What it does |
|---|---|---|---|---|
| AudioSession full API | `DOMAudioSessionFullEnabled` | testable | **OFF** | `.state` + `.onstatechange` only |
| Use Microphone Mute Status API | `UseMicrophoneMuteStatusAPI` | testable | **OFF** | routes hardware/system mute into capture |
| MediaSession capture related API | `MediaSessionCaptureToggleAPIEnabled` | stable | **ON** (Cocoa) | `setMicrophoneActive()` etc., see below |
| Async Audio Session Activation | `AsyncAudioSessionActivationEnabled` | stable | ON — **trunk only** | async IPC for session activation |

**Confirmed not to exist**, having been grepped for by name: "Manage Audio
Session", "Audio Session Type", per-element AudioSession, any Voice Isolation
flag, any Voice Activity Detection flag **[source]**. There is no flag exposing
AVAudioSession options, because the WebKit code to pass them does not exist
(§1, point 3).

Two structural points worth recording:

- **The AudioSession API itself is no longer togglable.** `DOMAudioSessionEnabled`
  is `mature`, i.e. permanently on with no UI switch. The flag people remember
  from the Safari 16.4 betas is gone; only the `.state`/`.onstatechange` half
  (§1) is still gated.
- **`shouldManageAudioSessionCategory` is not a web preference.** The switch that
  would disable the whole category-management machinery described in §2 is
  `s_shouldManageAudioSessionCategory`, a C++ global at `AudioSession.cpp:51`,
  set by the embedder **[source]**. Safari is the embedder. A page cannot reach
  it, and neither can the user.

Two shipped capabilities the research turned up that are genuinely usable, though
neither solves the mixing question:

- **`navigator.mediaSession.setMicrophoneActive()` is shipped, not experimental.**
  `MediaSessionCaptureToggleAPIEnabled` is `stable` and ON by default on Cocoa,
  gating `setMicrophoneActive()` / `setCameraActive()` / `setScreenshareActive()`
  and the `togglemicrophone` / `togglecamera` / `voiceactivity` action handlers
  **[source]**. Widely-repeated advice that this is Tech-Preview-only traces to a
  stale comment on WebKit bug 236219.
- **Voice-activity detection**, via `setActionHandler("voiceactivity", …)`, exists
  on Apple platforms — but it is implemented on the voice-processing audio unit
  (`CoreAudioCaptureUnit.mm`, hooking
  `kAUVoiceIOProperty_MutedSpeechActivityEventListener`), so **it does not fire
  when `echoCancellation` is false** **[source]**. Irrelevant here, and a neat
  illustration of how much of iOS's web-audio input surface is welded to the
  voice path.

Finally, Safari Technology Preview 248 records a fix so "the WebProcess
AudioSession remains active while microphone capture is live" **[docs]** — a
stability fix on the path this app already uses, not a capability change.

### 4.5 Other constraints

**`suppressLocalAudioPlayback` is not a microphone constraint and is not a
mediacapture-extensions feature** — it belongs to the **Screen Capture** spec
(`w3c.github.io/mediacapture-screen-share`), applies to `getDisplayMedia`, and is
**not implemented in WebKit at all**: zero source hits, zero Bugzilla hits, no
standards position **[source]**. Doubly irrelevant on iOS, where `getDisplayMedia`
does not exist (§5.5).

**`voiceIsolation` has no WebKit signal whatsoever.** It is a
mediacapture-extensions proposal; WebKit standards-positions issue **#314**, filed
**2 February 2024** by a Google engineer, still carries `"position": null` on
`main` today — WebKit has never responded in two and a half years **[source]**.
Chrome shipped it ChromeOS-only. Even if it landed it would *add* processing,
which is the opposite of what this app wants. Do not plan around it.

**[inference]** No capture constraint in any current or proposed spec affects
session exclusivity. The constraint layer describes the *track*; the session
layer describes the *process*; the exclusivity lives in the latter, and there is
no constraint that reaches it.

### 4.6 System Mic Modes — the processing you cannot see or control

This one is worth knowing because it can silently change what the app records,
and nothing in JavaScript reports it.

iOS and macOS let the *user* pick a Mic Mode from Control Centre — Automatic
(iOS 18+), Standard, Voice Isolation, Wide Spectrum. Apple Support article
**101993** (published **7 November 2025**) states the selection "affects only the
app you're using" and "persists for that app until you choose a different Mic
Mode" **[docs]**. iOS 26 extends the panel to recording apps.

Three findings:

1. **Nobody can set it programmatically — not even native apps.**
   `AVCaptureDevice.activeMicrophoneMode` and `.preferredMicrophoneMode` are both
   read-only, documented as "the microphone mode that the user selects in Control
   Center"; `showSystemUserInterface(_:)` only deep-links to the panel **[docs]**.
2. **WebKit never touches it.** Grepping WebCore's mediastream/audio trees, PAL
   and the WebKit process layer for `microphoneMode` / `wideSpectrum` /
   `showSystemUserInterface` returns **zero hits** **[source]**. It is not
   readable, not settable, and not reflected in `getSettings()`.
3. **But Safari is eligible for it**, because it takes exactly the two code paths
   that qualify an app: the voice-processing IO unit, and
   `AVAudioSessionModeVoiceChat`/`VideoChat` (§2c) **[source]**. Corroborated by
   users reporting the macOS Control Centre Voice Isolation panel appearing for
   Safari and not for Firefox **[reported]**. Apple has never written this down —
   **[inference]**, and it should be read as such.

**The practical upshot is good news, and it is the same lever as everywhere else
in this section:** `echoCancellation:false` swaps WebKit to
`createNonVPIOUnit()`, taking capture off the voice-processing path and therefore
out of Voice Isolation's reach entirely **[source]**. The app is already doing
the right thing. But it is a blunt on/off — there is no way to *select* Wide
Spectrum, which is the mode a musical app would actually want.

**And the state can change under you mid-session.** WebKit migrates a track
between VPIO and non-VPIO units at runtime — `CoreAudioCaptureSource.cpp` has
`vpioUnitWillChangeCaptureDeviceTo` forcing `setEchoCancellation(false)` when
another page takes the shared VPIO unit **[source]**. *WebKit Features in Safari
26.0* (15 September 2025) records the matching fix: "the `configurationchange`
event [now fires] when a microphone's audio unit changes its echo cancellation
mode" **[docs]**. See §7.6.

---

## 5. Practical alternatives, ranked

The app is zero-dependency static files served from GitHub Pages. Everything
below respects that.

### 5.1 External speaker + phone mic — works today, and costs less than you'd think

**Requires:** the music plays from a *different device*. A laptop, a second
phone, a Bluetooth speaker fed by something that is not the recording phone. If
the recording phone is the Bluetooth source, its own session still governs and
you are back at §2.

**No code. Already the shipped path.** What it costs, honestly split:

| Property | Effect | Verdict |
|---|---|---|
| **Pitch content** | Room reverb adds decaying copies of a signal that is already stationary over a 2.5 s fence. Partial frequencies are unchanged. | **Survives.** This is the app's core job and it is fine. |
| **Per-note level (dB)** | Room modes swing low-frequency response by ±10 dB and the iPhone mic rolls off below ~200 Hz **[reported]**. The dB figure the results table shows becomes a property of where you stood. | **Corrupted, and the app does not say so.** This is the real cost, and it is under-communicated. |
| **Bass fundamentals** | Depends entirely on the speaker. A decent monitor is fine; a laptop speaker is not. | Speaker-dependent. |
| **Level** | Fine. Peak normalisation at `js/audio.js:157-159` already handles it. | Handled. |

**[inference]** The honest summary is: acoustic capture from a good external
speaker is adequate for chord and voicing identification and unreliable for the
dynamics readout. Given that §4 of `RESEARCH.md` treats voicing as the product
and dynamics as a bonus, that is an acceptable trade — but the app should stop
presenting acoustically-captured dB figures with the same confidence as
file-loaded ones.

### 5.2 The app plays the file itself — already true, and it dissolves the question

`createMediaElementSource` is unnecessary: the app already decodes the file to an
`AudioBuffer` and analyses the samples directly (`js/audio.js:18-26`). There is
no acoustic path, no session conflict, no echo, no bandwidth loss.

So if the audio exists as a file, **the feature the user is asking for is
strictly worse than what the app already does.** The only scenario where
simultaneous play-and-record makes sense is when the audio is *not* available as
a file — i.e. it is inside another app. Which is §5.3 and §5.5.

**[inference]** Worth stating outright, because it reframes the request: the goal
is almost certainly not "play and record simultaneously" but "analyse what
Spotify is playing". Those are different problems, and only the second has any
answers — §5.3 and §5.5 address it, and both are about obtaining *digital* audio,
not about recording at all.

### 5.3 Get the file into the app — the underrated answer

On iOS, `<input type="file">` reaches Files, iCloud Drive, and anything another
app has exported via "Save to Files". Voice Memos exports. AirDrop from a Mac
lands in Files. This is lossless, needs no permissions, and is already
implemented.

**iOS Screen Recording is a genuine digital path** and deserves a mention: the
built-in Control Centre recorder captures internal app audio and writes a `.mov`
to Photos, which the file picker can then reach. Two caveats:

- **DRM apps block it.** Spotify, Netflix, Disney+ produce silent recordings
  **[reported]**. So it does not solve the Spotify case, which is probably the
  one the user has in mind.
- **[untested]** whether `decodeAudioData` accepts a `.mov` on iOS Safari. The
  W3C's own guidance discourages video containers, though the platform decoder
  usually handles them. Five-minute test; if it fails, a `<video>` element plus
  `createMediaElementSource` and the existing ScriptProcessor capture is the
  fallback, at real-time speed.

### 5.4 Desktop — the constraint simply is not there

On macOS Safari the exclusivity mechanism does not exist (§2), so play-and-record
already coexists with other apps. And on **desktop Chrome/Edge**,
`getDisplayMedia({audio:true})` gives genuinely digital tab audio — no
microphone, no room, no speaker. Support, as of August 2026 **[docs — MDN BCD
`api/MediaDevices.json`, fetched 2026-08-02]**:

| | Tab audio | System audio |
|---|---|---|
| Chrome/Edge, Windows + ChromeOS | yes (Chrome 74+) | yes, sharing entire screen |
| Chrome/Edge, **macOS** | yes | **yes — new.** Chrome 141/142+ on macOS 14.2+, via CoreAudio process taps |
| Chrome/Edge, Linux | yes | no |
| Firefox desktop | **no** — Bugzilla 1541425 still NEW after 7 years | no |
| Safari macOS | **no** — BCD `version_added: false` | no |
| Chrome Android | **no** — `getDisplayMedia` not supported at all | no |
| **iOS / iPadOS Safari** | **does not exist** | — |

macOS system audio is the one thing that genuinely changed recently: Chromium
commit `4d26c694` (2 June 2025) added `NSAudioCaptureUsageDescription` for
CoreAudio taps, and Google Workspace's 17 December 2025 announcement gives the
floor as macOS 14.2+ with Chrome 142+. MDN's own compat note ("on Linux and macOS,
only the audio of a tab can be captured") is **stale** and should not be relied on.

### 5.5 `getDisplayMedia` on iOS — does not exist, and nothing replaces it

MDN browser-compat-data carries an explicit `"safari_ios": {"version_added": false}`
on `getDisplayMedia` — an explicit `false`, deliberately overriding the usual
mirror-from-desktop policy **[docs]**. caniuse shows Not supported for every iOS
Safari version through the current one. WebKit bug 186294 was resolved for
desktop in February 2022; a December 2020 comment asking about iPadOS never got a
WebKit reply, and no bug tracks iOS support **[reported]**.

Feature-detect it (`typeof navigator.mediaDevices?.getDisplayMedia === 'function'`);
do not call and catch.

Every adjacent idea is also closed **[docs/reported]**: `MediaStreamTrackProcessor`
transforms a track you already own and cannot manufacture a source; `setSinkId`
is output routing by definition; Media Session is metadata only; ReplayKit has no
web binding and is out-of-process by design; AirPlay is a sink, not a source.
**There is no web route on iOS to another app's audio.** The microphone is the
only audio input a page can have.

### 5.6 An external audio interface — the one avenue I could not close

**[untested], and I flag it as the single genuine unknown.** WebKit bug 174833,
"`mediaDevices.enumerateDevices()` is missing audioinput devices on iOS", is
**still NEW and unresolved**, last touched 2020. Eric Carlson (WebKit) explains
that iOS returns only default devices to limit fingerprinting; the reporter
confirmed that even an Apogee Duet is not enumerated — iOS returns exactly one
`audioinput`, labelled "iPhone Microphone" **[reported]**.

So `deviceId` constraints are useless on iOS: there is nothing to select. But it
is plausible that a USB-C audio interface, once connected, becomes the *system
default input* and is therefore what `getUserMedia` captures anyway — iOS
promotes connected USB interfaces at the `AVAudioSession` level. I found no
source confirming that path through Safari specifically. If the user owns an
interface, **this is the one experiment in this document with a real chance of
paying off**: it would bypass the acoustic path entirely, on the phone, with no
code change. It would also be invisible from JavaScript — the track would still
be labelled "iPhone Microphone" — so it needs an ear test, not a feature test.

---

## 6. The echo problem — why the question is largely moot anyway

Suppose every wall in §1–§2 came down. Would simultaneous play-and-record be
musically useful on a phone?

**No.** Four reasons, in descending order of severity.

**1. The phone speaker has no bass, and bass is the product.** The best published
measurement I found puts an iPhone speaker's rolloff at about **12 dB/octave
below 1 kHz** (Faber Acoustical) **[reported]** — that measurement is of an
iPhone 3G and modern iPhones are better, so treat the slope as indicative rather
than current. But the direction is not in doubt: a driver that small cannot
reproduce 65 Hz. C2 is 65 Hz. Four octaves below a 1 kHz corner at 12 dB/octave
is nearly 50 dB of attenuation — i.e. gone. This app's headline output is a voicing, bass note included, and
`js/audio.js` renders isolation layers and A/B comparisons that assume the bass
is present in the recording. A capture through the phone's own speaker would
report a rootless voicing every time, confidently and wrongly. **This alone ends
the idea.**

**2. AEC is off, deliberately, and that is correct.** `RESEARCH.md` §2 trap 1 disables
`echoCancellation` because AEC is a nonlinear, adaptive, speech-tuned filter that
mangles sustained tones. Turning it back on to fight bleed would trade one
unanalysable recording for a differently unanalysable one. There is no setting
that makes this work: with AEC off you capture your own speaker at high SPL; with
AEC on you capture something an NNLS fit cannot interpret.

**3. The bleed is not a small addition — it dominates.** The iPhone's speaker and
bottom mic are centimetres apart. At any normal listening distance, the phone's
own output arrives at its own mic tens of dB above an external source
**[inference]**, and near the speaker the mic is being driven into nonlinearity.
The result is not "the music plus some room" — it is a band-limited, distorted
copy of the phone's speaker with the room somewhere underneath.

**4. It is redundant even if it worked.** The only case where the app plays and
records simultaneously is one where it *already holds the samples*. Recording
them back through a speaker and a microphone can only lose information. §5.2.

**Conclusion.** The interesting result of this whole investigation is that the
platform limitation and the acoustic limitation point the same way, and the
acoustic one is the harder of the two. Even a native app with `mixWithOthers`
cannot get musically useful audio out of "phone plays, phone records". Snapchat
does not need to — a bit of tinny background music is exactly the aesthetic. This
app does need to, and cannot.

---

## 7. What to actually do, ranked

**7.1 Record it as a known limitation and stop.** [do this]
The goal as stated is unreachable on iOS Safari and would be undesirable if it
were reachable. This document is the artefact; `RESEARCH.md` §2 should gain a
one-line pointer to it. Do not spend engineering time on the mixing question.

**7.2 Say it in the UI, once, where it happens.** [cheap, high value]
The record button currently sets `play-and-record` and says "Recording — mic
processing disabled for musical accuracy" (`js/audio.js:216`). It could also say
that other apps' audio will stop, because that is a surprising, unavoidable,
platform-mandated behaviour the user will otherwise read as a bug in the app.
One sentence.

**7.3 Recommend the external-device path explicitly.** [documentation]
"Play the music from another device, through the best speaker you have, and
record that" is the supported answer and it mostly works (§5.1). It belongs in
the README next to the mic instructions, with the honest caveat that the per-note
dB figures are then measuring the room as much as the performance.

**7.4 Run three experiments.** [~30 minutes total, on a real iPhone]
In descending order of what they could change.

- **Does the mic path die above 10 kHz?** (§4.1, WebKit bug 204467). Record the
  synthetic demo chord off a speaker and compare its high-frequency spectrum
  against the same buffer analysed directly. This is the only experiment here
  that could change how the *detector* is judged rather than how recording is
  described, and the harness to run it already exists.
- **`ambient` after capture starts** (§2d): call `getUserMedia`, then set
  `navigator.audioSession.type = 'ambient'`, and listen. Predicted: the track
  goes silent or ends, because `AVAudioSessionCategoryAmbient` has no input
  route. If it does *not* — if capture survives while another app keeps playing —
  that is the one loophole in this document and it would change the verdict.
  I expect it to fail; it is cheap enough to be worth knowing.
- **USB-C audio interface** (§5.6): plug one in, record, listen. If iOS promotes
  it to default input, the acoustic path disappears on the phone with zero code.
  Nothing in JavaScript will tell you — the track is labelled "iPhone Microphone"
  either way — so this is an ear test.

**7.5 Detect the Bluetooth downgrade.** [small, real bug prevention]
§4.2: an AirPods connection silently downgrades capture to mono 8–16 kHz over
HFP, which quietly wrecks the analysis and reads as the *detector* getting worse.

Do **not** use `track.getSettings().sampleRate` — `sampleRate` and `channelCount`
are among the settings WebKit does not reliably populate **[reported]**. Use the
context rate the recorder already reads at `js/audio.js:145` (`R.ctx.sampleRate`),
which follows the session's hardware rate: anything below ~24 kHz means the
capture came over HFP. The app already *displays* it — `#srcInfo` prints
"… · 16000 Hz" — but shows it as neutral metadata rather than as a warning, so
nobody reads it as the cause. One conditional in `stopRec()` next to the existing
"very quiet" advice would do it.

This is the one concrete code change this research argues for, and it is
unrelated to the question that prompted it — which is often how these go.

**7.6 Listen for `configurationchange` on the audio track.** [small, prevents a
genuinely confusing failure]
§4.6: WebKit can migrate a live track between the voice-processing and plain
capture units *while recording*, and `vpioUnitWillChangeCaptureDeviceTo` forces
`setEchoCancellation(false)` when another page grabs the shared VPIO unit
**[source]**. So the processing state of a take is not fixed at
`getUserMedia` time. Safari 26.0 (September 2025) fixed the `configurationchange`
event to actually fire for this case **[docs]**, which makes it observable:

```js
track.addEventListener('configurationchange', () => track.getSettings().echoCancellation);
```

The realistic symptom is one take in a session analysing worse than the others
for no visible reason — the kind of thing that gets blamed on the detector. The
app records takes it will compare against each other (the A/B loop at
`js/audio.js:481-492` is built for exactly that), so a take whose input
processing silently differed is worth flagging rather than silently ranking.
**[untested]** how often this actually fires in practice on a single-tab phone;
possibly never. Cheap to log, and the log answers the question.

**7.7 Do not build `getDisplayMedia` support for iOS.** It does not exist and no
bug tracks it (§5.5). If desktop capture is ever wanted for a laptop workflow,
feature-detect and offer it there only.

---

## Sources

**Specifications**
- W3C, *Audio Session*, Working Draft **13 November 2024** — `https://www.w3.org/TR/audio-session/`; Editor's Draft `https://w3c.github.io/audio-session/`. Editors Youenn Fablet (Apple), Alastor Wu (Mozilla).
- `w3c/audio-session` repository, `index.bs` and commit history — read 2026-08-02. Last substantive commits March/August 2025; none in 2026.
- `w3c/audio-session` issue **#3**, "In case an AudioSession is explicitly set, should some incompatible APIs start failing?", youennf, **8 November 2022**.
- `w3c/audio-session` issue **#18**, "Consider exposing/implementing audioSession options", **August 2024** — open, unassigned.
- `w3c/audio-session` issue **#46**, "Some websites misuse AudioSession type, preventing microphone access", **19 August 2025**.

**WebKit source** (read from `WebKit/WebKit` `main`, 2026-08-02)
- `Source/WebCore/platform/audio/ios/AudioSessionIOS.mm` — category mapping and the `PlayAndRecord` options mask. No `mixWithOthers`.
- `Source/WebCore/platform/audio/cocoa/MediaSessionManagerCocoa.mm` — `updateSessionState()`, `captureCount` → `PlayAndRecord` + `Mode::VideoChat`.
- `Source/WebCore/platform/audio/mac/AudioSessionMac.mm` — routing arbitration, not exclusion.
- `Source/WebCore/Modules/audiosession/DOMAudioSession.cpp` — `setType`, `fromDOMAudioSessionType`, `setCategoryOverride`.
- WebKit commit `c39358705b79ccf2da3b76a8be6334e7e3dfcfa6`, youennf, "Enable AudioSession Web API by default, but only a reduced subset".
- WebKit PR #7190, youennf, "Add experimental support for AudioSession Web API".
- WebKit bug **174833** — enumerateDevices missing audioinput on iOS. **Still NEW.**
- WebKit bug **186294** — getDisplayMedia; resolved for desktop 25 February 2022, never for iOS.
- WebKit bug **179411** — "getUserMedia echoCancellation constraint has no affect", reported 7 Nov 2017, RESOLVED FIXED 19 Nov 2019; youenn fablet comment 7 on AGC.
- WebKit bug **286680** — `echoCancellation:{exact:false}` OverConstrained, 29–31 Jan 2025, fixed.
- WebKit bug **204467** — "Raw digitally modulated audio not producing correct FFT results…", reported 21 Nov 2019, **still NEW**.
- WebKit bug **185448** — getUserMedia in home-screen standalone apps; reported May 2018, RESOLVED FIXED in iOS 13.4 (Feb/Mar 2020). Related: **180551**, **208667**.
- `Source/WTF/Scripts/GeneratePreferences.rb` and `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml` — which flags appear in the iOS Feature Flags UI, and their statuses. Read against trunk `main` @ `917b750511ac` (**1 August 2026**, WebKit 626.1.1) and `safari-7624-branch` (WebKit 624.2.5, shipping Safari 26.x).
- `Source/WebCore/platform/audio/cocoa/AudioSession.cpp:51` — `s_shouldManageAudioSessionCategory`, embedder-controlled, not a web preference.
- `Source/WebCore/platform/mediastream/mac/CoreAudioCaptureSource.cpp` — `vpioUnitWillChangeCaptureDeviceTo`, runtime VPIO migration; `createNonVPIOUnit()`.
- `Source/WebCore/platform/mediastream/mac/CoreAudioCaptureUnit.mm` — voice-activity detection on `kAUVoiceIOProperty_MutedSpeechActivityEventListener`.
- `Source/WebCore/Modules/mediasession/MediaSession.idl` / `.cpp` — `setMicrophoneActive()` and the `voiceactivity` action, gated by the **stable** `MediaSessionCaptureToggleAPIEnabled`.
- WebKit standards-positions issue **#314** — `voiceIsolation`, filed 2 February 2024, `"position": null` as of August 2026.
- *WebKit Features in Safari 26.0*, **15 September 2025** — `configurationchange` fires on echo-cancellation-mode change.
- W3C, *Screen Capture* — `suppressLocalAudioPlayback` (not mediacapture-extensions; not implemented in WebKit).
- Apple Support **101993**, *Use Mic Modes*, published **7 November 2025**; `AVCaptureDevice.activeMicrophoneMode` / `.preferredMicrophoneMode` (read-only).
- *Release Notes for Safari Technology Preview 248* — WebProcess AudioSession stays active during capture.

**Apple documentation**
- `AVAudioSession.Category.playAndRecord` — "nonmixable… use the `mixWithOthers` option".
- `AVAudioSession.CategoryOptions.mixWithOthers`, `.defaultToSpeaker`, `.duckOthers`, `.allowBluetoothHFP`.
- `AVAudioSession.Mode.measurement` — minimal input processing; `.videoChat`.
- `AVAudioSession.h` — "activating an audio session is a synchronous (blocking) operation".
- Apple Platform Security, *ReplayKit security in iOS and iPadOS*.
- WWDC26 session **303**, *Build a responsive camera app that launches quickly*.
- Apple Developer Forums **792147** (Apple Media Engineer: 100–500 ms hardware reconfiguration), **681319** (the Snapchat-alike recipe), **4340** (HFP quality loss), **775765** (USB audio input and AirPlay).
- Apple Community **253733617** — Snap/Instagram record lag on AirPods.

**Compatibility data**
- MDN browser-compat-data, `api/AudioSession.json` and `api/MediaDevices.json`, `main` branch, fetched **2026-08-02**.
- MDN, *AudioSession: type property*, last modified **12 February 2026**.
- caniuse: `getDisplayMedia`, `getDisplayMedia audio capture support` — checked 2026-08-02.
- Bugzilla **1541425** — Firefox getDisplayMedia audio capture, **still NEW** after 7 years.
- Chromium commit `4d26c694` (**2 June 2025**) — `NSAudioCaptureUsageDescription` for macOS CoreAudio taps.
- Google Workspace Updates, **17 December 2025** — macOS 14.2+ / Chrome 142+ for device-audio sharing.
- addpipe, **19 February 2026** — *Capturing the Screen With System Sounds on Chrome on macOS*.

**Acoustics**
- Faber Acoustical, *iPhone Microphone Frequency Response Comparison* — speaker rolls off ~12 dB/octave below 1 kHz; mic low end down 15 dB+ at 20 Hz.
