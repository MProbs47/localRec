# MeetingRecorder — Arbeitsrichtung

Local-first Transkriptions-PWA: Sprache wird vollständig on-device transkribiert (Whisper Large v3 Turbo, WebGPU), Sprecher on-device erkannt (pyannote + WeSpeaker, WASM). Nichts verlässt das Gerät.

## Haltung

- **YAGNI, DRY, lean.** One-Man-Show, kein Monetarisierungsdruck. Keine spekulativen Features, keine Abstraktion ohne zweiten Aufrufer. Ziel: **einfach, sicher, stabil** — Alltag erleichtern.
- Einfaches Gesicht, robuster Motor: die Oberfläche bleibt minimal (ein Knopf), Komplexität lebt unsichtbar dahinter.
- Bei Zweifel: die kleinere Lösung.

## Nicht verhandelbar

- **Nichts verlässt das Gerät.** Keine Cloud-Calls, kein Tracking, keine Analytics, keine Konten. CSP `connect-src 'self'` (nach Modell-Download idealerweise `'none'`). Netz nur beim einmaligen Modell-Download.
- Die **exportierte Datei am gewählten Ort ist die Wahrheit**; Browser-Storage ist nur Cache.

## Teure Fallstricke (nicht neu erfinden)

- **Kein COOP/COEP** — WebGPU braucht es nicht und `require-corp` bricht den Modell-Download.
- **Modell nicht ins PWA-Precache** (~1.5 GB) — separat in OPFS verwalten.
- **Inferenz im Web Worker**, nicht im Main-Thread; Persistenz **append-only** (Crash-Sicherheit).

## Rollen in `ce-work`

Sonnet 5 implementiert; Opus testet, prüft und entscheidet Architektur; **Opus macht die Schlussabnahme** jeder Einheit.

## Kontext

Pläne, Requirements, Recherche und Debug-Protokolle liegen ausserhalb des Repos (siehe `.gitignore`) — im Repo dokumentieren sich Entscheide über `CONTEXT.md`, `README.md` und die Kommentare am Code selbst.
