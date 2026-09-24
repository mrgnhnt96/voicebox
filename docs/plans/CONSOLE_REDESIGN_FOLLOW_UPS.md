# Console redesign: follow-ups

The Console redesign (dark graphite theme, labeled rail, status bar, the
64 × 24 HUD, the Captures/Models/Settings rebuild, first-run setup and the ⌘K
palette) shipped with some parts of the approved mockups left out. This file
lists them so they can be picked up later. Each item says what the mockup
showed, why it wasn't built, and what building it would take.

## Needs backend support

These were in the mockups but the API had nothing to build them on.

- **Turning off individual learned habits.** The writing-style summary
  ("Here's what Voicebox learned") and the Writing style page list habits
  without on/off switches. The API only returns habit codes, with no way to
  disable one. Needs a per-habit enabled flag stored with the style profile,
  and refinement that respects it.
- **Example lines under each habit.** The mockup showed a before → after
  example per habit (`"Hello team, I wanted to…" → "Heads up —"`). The API
  returns codes only, so the page shows a short label instead. Needs the style
  analysis to return one example pair per habit.
- **Skipping a calibration paragraph.** "Skip this one" was left out: there's
  no skip endpoint. Today the choices are "Looks like me" (accept unchanged)
  or "Save & next" (submit an edit).
- **Typed "what went wrong" categories.** The Teach flow's chips (Misheard
  word, Punctuation, Formatting, Tone) became a free-text note. Needs a
  category field on correction reports, ideally used by correction learning.
- **Fully undoing a correction.** Undo only removes the correction from the
  writing-style examples (`removePersonalExample('correction:<id>')`). The
  saved report stays in correction history and correction learning, because
  there's no endpoint to delete one.
- **Learning progress as a percentage.** The "writing model is updating" bar
  is indeterminate. Needs the learning job to report progress.
- **Stage timings.** The refined panel's "1.2s" and the setup Try-it line
  ("0.4s transcribe · 0.9s refine · Removed 'um'…") need per-capture timings
  and a short summary of what refinement changed.
- **"Pasted into <app>".** Captures don't record which app received the text.
  The focus snapshot has the bundle id at paste time; it would need saving on
  the capture.
- **Loaded vs downloaded.** The status bar says a model is `ready` (downloaded)
  or `missing`. The mockup distinguished models loaded in memory. The readiness
  endpoint only reports downloaded.
- **Queued downloads.** The setup flow can't show "queued": `/tasks/active`
  only lists downloads that are running.
- **Parameter counts and size descriptions on Models.** The mockup showed
  "74M", "1.7B", and descriptions like "fastest · light cleanup" and "best at
  matching your style". The server reports size on disk only (and only for
  downloaded models), so rows show that and the size comparison has no
  descriptions.

## Needs app work (no backend change)

- **HUD position setting.** Settings › Dictation in the mockup had "HUD
  position: Bottom center". The HUD is always bottom-center. Needs a setting
  plus `position_dictate_window` in Rust to read it.
- **Command palette commands.** Left out:
  - "Import audio file…": importing lives on the Captures session
    (`useCaptureRecordingSession().uploadFile`). One way: Captures listens for a
    window event such as `voicebox:import-audio` and opens its file input.
  - "Start dictation" (could call `dictation_start`).
  - "Re-refine selected capture" (needs the palette to know the selection).
  - "Move models to a new location…" (open the Models storage flow).
- **Model descriptions in translations.** Per-model descriptions are
  hard-coded English in `app/src/components/ServerSettings/modelCatalog.ts`,
  not in `translation.json`.
- **Logs "Errors only" filter.** It matches line text (`ERROR`, `Traceback`,
  `…Error:`), not stderr, because the server writes normal logging to stderr.
  A structured log level from the server would make this exact.
- **HUD illustrations.** The small HUDs in Setup › Try it and the Settings
  preview use a sample voice, not the live microphone.
- **Web build.** The browser recording path (non-Tauri) has no level readings,
  so its pill's bars stay flat while recording. The app is macOS-only in
  practice, so this path may be better removed than fixed.
- **Delete `DictationReadinessChecklist.tsx`.** The setup flow replaced it on
  Captures; Settings › Dictation still shows it at the top while something is
  missing. Either keep it there deliberately or point that spot at `/setup`.

## Not drawn in the mockups

These states exist but got no dedicated design, so they use the new styles
without a mockup to match.

- Server offline or failing to start (beyond the status bar dot).
- Empty search results in the command palette.
- Import in progress and import errors on Captures.
- The Models "Move models to a new location?" dialog and migration overlay.

## Verification still owed

- Nobody has run the redesigned app or looked at it on screen.
- `bun` wasn't available, so the app tests in `app/tests/` (including the new
  `capture-pill-level`, `native-dictation` and `word-diff` tests) haven't been
  run with `bun test`. The word-diff tests were run under Node with a
  stand-in for `bun:test`.
- Biome still reports findings the redesign didn't introduce: the loader
  `!important` rules in `index.css`, hook dependencies in `ShinyText.tsx` and
  `useChordSync.ts`, optional chains in `useDictationReadiness.ts`, and import
  order in `App.tsx` and `PlatformContext.tsx`.
