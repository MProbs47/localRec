# MeetingRecorder

A local-first PWA that captures meeting audio and turns it into a speaker-labelled transcript entirely on-device. This glossary is the ubiquitous language: the words the code, the UI, and we should all use for the same concepts.

## Principles

Code comments cite short decision codes (`SD-`, `KTD`, `R…`) from internal planning
documents that live outside this repo (see `.gitignore`). The handful that recur
across the codebase are defined here so an outside reader can resolve them without
access to those private docs. One-off codes are instead spelled out in place, at
their single comment site.

These codes are numbered per planning document, not globally, so the same code
(e.g. `KTD4`) can denote something entirely different depending on which plan a
given comment traces back to — a definition below applies only where the
surrounding comment is actually discussing the topic that definition describes.

**SD-2** (speaker naming is user-correctable, not absolute truth): Speaker
labels resolve through a swappable `SpeakerNameResolver` that defaults to the
placeholder `speakerLabel` ("Sprecher N"/"Speaker N"). A user rename replaces
that default consistently everywhere the label is used — the on-screen turn
display and the exported speaker-labeled transcript never disagree — but it
never changes the underlying speaker index or the clustering result it came
from.

**SD-3** (graceful degradation): An optional feature failing must never take the
app down with it. Concretely: any diarization/speaker-detection failure (model
absent, download error, inference error) resolves to the plain transcript with no
speaker labels, instead of surfacing as an app-level error.

**KTD4** (no COOP/COEP): The app deliberately ships without
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`. WebGPU doesn't need
them, and `require-corp` would break the one-time model download from Hugging
Face. Consequence: no `SharedArrayBuffer`/`Atomics` anywhere in the codebase.

**KTD5** (model never precached): The ~1.5 GB Whisper model is never part of the
PWA's build-time precache (the service worker's Workbox manifest). It's fetched
at runtime into the browser's own Cache API (the diarization model set instead
uses an OPFS downloader), kept fully separate from the app-shell asset pipeline.

**KTD7** (feature detection, not a user toggle): Capability differences (e.g.
whether the File System Access API is available) are resolved by probing what
the running browser actually supports at the call site, never by a user-facing
switch or setting.

**KTD12** (Cloudflare Pages constraints): Deployment-shape assumptions baked into
the build: the app is served from the domain root, any single build asset over
25 MiB fails the whole deploy (Cloudflare Pages' per-file limit), and a future
same-origin model host would live on the same Cloudflare account (R2).

**R14** (long-run backpressure): Structures on the live audio/transcript path
(ring buffer, transcript store, live block driver) use fixed capacity that never
grows over a multi-hour session — a slow consumer degrades by losing the oldest
unread data instead of letting memory grow without bound.

**R17** (resumable model download): A Whisper/diarization model download can be
interrupted (e.g. at 60%) and resumed from where it left off via HTTP `Range`
requests, instead of restarting from zero.

**R19** (model lifecycle management): The model cache module supports deleting a
downloaded model set, gating a fresh download on available disk space, and
unloading an idle model from RAM after inactivity.

## Language

### Engine

**Engine**:
The on-device model stack that turns audio into text and speakers (Whisper for transcription, pyannote + WeSpeaker for diarization). It is *absent*, *downloading*, *ready*, or *failed* — this readiness tracks the primary (transcription) stack that gates recording; the diarization stack loads on demand at annotation. Readiness is its own concern, independent of whether a recording is happening. (`class Engine` in `src/engine/` — the main-thread host over the two model workers, distinct from the per-model `WhisperEngine`/`DiarizationEngine`.)
_Avoid_: model, AI, "the whisper" (the Engine is more than one model)

### Recording

**Recording Session**:
The live, in-memory act of capturing and transcribing audio, from one start to one stop. It is the aggregate that owns the recorder, the writers, and the durable Session Record for its lifetime. Its lifecycle is *idle → starting → active → stopping → stopped* (or *failed*) — an explicit state, not a scattered boolean.
_Avoid_: recording (also a Capture Mode), session (also the persisted Session Record)

**Live Capture**:
The live audio graph a Recording Session owns while active — the device microphone plus, in Online Meeting, the system audio, summed through one node into (a) a PCM feed for the Engine and (b) a smoothed level for the VU meter, torn down at stop. The capture half of the session, distinct from the output/persistence half the RecordingCoordinator owns. (`LiveCapture` in code.)
_Avoid_: the audio pipeline, the mic graph (informal)

**Capture Mode**:
How audio enters a Recording Session. Exactly one of Local Recording, Online Meeting, or File Import.
_Avoid_: source, type, kind

**Local Recording**:
Capture Mode using the device microphone only, transcribed live as it records. (`record` in code, "Lokale Aufnahme" in the UI.)

**Online Meeting**:
Capture Mode that mixes microphone + system audio into one stream, transcribed post-hoc from the recorded blob. (`meeting`, "Online Meeting".)
_Avoid_: meeting (ambiguous on its own)

**File Import**:
Capture Mode that ingests an existing audio file from disk. Nothing is ever sent anywhere. (`import`, "Datei laden".)
_Avoid_: upload (implies leaving the device — it never does)

### Transcript & persistence

**Segment**:
One finalized transcript utterance, sequence-ordered (`seq`) within its session and written append-only.
_Avoid_: utterance, line, chunk

**Transcript**:
The ordered sequence of Segments produced for one Recording Session.

**Session Record**:
The durable IndexedDB marker for a Recording Session and its Segments — the unit of crash recovery. It is *active* from creation until cleanly *closed*; an `active` record found at next launch is a crash candidate. Distinct from the live Recording Session that produced it.
_Avoid_: session (reserve for the live Recording Session)

**Cache**:
Browser-side storage (OPFS for audio, IndexedDB for Session Records) used only as crash-recovery scratch. Never the truth.
_Avoid_: storage, database (as if authoritative)

**Export**:
The file(s) written to the user-chosen location (`.txt` / `.srt` / `.webm`, plus speaker-labelled variants). Per the project's first principle, the Export at its chosen location **is the source of truth**; the Cache is not.
_Avoid_: output, save, download

**Recovery**:
Reconstructing a crashed Recording Session's Transcript from the Cache on the next launch, for viewing.

### Speakers

**Annotation**:
The post-hoc pass that labels a completed Transcript with speakers. It is *idle → running → done | skipped*, and runs against exactly one Recording Session — a result must never be applied to a different one.
_Avoid_: diarization (that is the underlying technique; Annotation is the run the user triggers)

**Speaker Timeline**:
Diarization output: time ranges attributed to speaker labels, aligned onto the Transcript.

**Speaking Turn**:
A merged contiguous region of the Speaker Timeline attributed to one speaker.
