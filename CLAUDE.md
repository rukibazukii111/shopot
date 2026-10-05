# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Shopot (Шёпот) is a local dictation desktop app for Windows and macOS. A global hotkey records speech, a Python worker recognises it on the CPU, and the text is pasted into the window that had focus when recording started. What the product does, for whom, and its four rules are in `README.md`; the 1.0 plan is `PRD.md`; what has been verified is `VALIDATION.md`. All user-facing strings, errors and docs are in Russian; keep new UI text in Russian. The code is the reference for limits, thresholds and timings: do not copy them into docs.

## Commands

Requires Node.js 24 and Python 3.11 (3.12 also works). Commands below use the Windows venv path; on macOS use `.venv/bin/python`.

```sh
npm ci
npm run setup            # creates .venv and installs backend/requirements.txt
npm start                # launches Electron via scripts/launch.cjs (strips ELECTRON_RUN_AS_NODE)

npm test                 # node --test tests/*.test.cjs
node --test tests/paste.test.cjs            # single Node test file
npm run test:ui          # Playwright + Electron, tests/ui/*.spec.cjs, 1 worker
npx playwright test tests/ui/widget.spec.cjs -g "cancels transcription"   # single UI test

.venv/Scripts/python.exe -m pip install -r backend/requirements-dev.txt
.venv/Scripts/python.exe -m pytest -q
.venv/Scripts/python.exe -m pytest -q tests/test_transcription.py -k raw_mode

npm run dist -- --publish never   # PyInstaller engine (dist/shopot-engine) + electron-builder -> release/
npm run test:packaged             # smoke-tests the packaged app
```

- The native Win32 SendInput paste test is skipped unless `SHOPOT_NATIVE_INPUT_TEST=1` is set (PowerShell: `$env:SHOPOT_NATIVE_INPUT_TEST = '1'`). It needs an interactive desktop.
- Build installers only on the target OS and architecture. `.github/workflows/build.yml` runs pytest, `npm test`, `test:ui`, `dist` and `test:packaged` on Windows x64, macOS arm64 and macOS Intel. It publishes a release for `v*` tags with `RELEASE_NOTES.md` as the release text.
- `scripts/evaluate.py` and `scripts/verify-microphone.cjs` check real recognition on a local recording. Outputs go to `.private/`, which is gitignored.

## Where things live

| File | Owns |
|---|---|
| `electron/main.cjs` | Controller: store, global shortcuts and push-to-talk polling, tray, widget window, recording sessions, worker, IPC |
| `electron/worker.cjs` | Spawns the engine; JSON lines on stdin/stdout (`{id, command, ...}` → `{id, result\|error, kind, expected}`, plus `ready`/`progress` events). No HTTP server |
| `electron/paste.cjs`, `native-input.cjs` | `PasteService` and the OS backends (Win32 `SendInput`, macOS Accessibility/CoreGraphics via Koffi), target-app detection |
| `electron/store.cjs` | `store.json`: settings, dictionary, snippets, per-app profiles, history, `pendingRecordings`; all validation |
| `electron/meetings.cjs` | Call detection (`MicWatcher`) and merging two channels into speaker turns (Windows) |
| `electron/corrections.cjs` | Dictionary suggestions from the user's edits in history |
| `electron/export.cjs` | Saving a transcript as .txt, .md or .srt |
| `electron/log.cjs` | Diagnostic journal in `<data>/logs`: a field schema per event, rotation, `pruneOlderThan` for history retention, `errorFields` |
| `electron/report.cjs` | «Сообщить о проблеме»: the GitHub new-issue link with a short form and the app and system versions |
| `renderer/app.js` | Main window, and the actual microphone capture (MediaRecorder), even for hotkey dictation while the window is hidden |
| `renderer/widget.*`, `widget-preload.cjs` | Non-focusable always-on-top widget with its own narrow IPC |
| `backend/engine.py` | Commands (`download`, `transcribe`, fire-and-forget `cancel`/`preload`), pinned model revisions in `MODELS`, audio path checks, idle and memory-pressure unload |
| `backend/text_processing.py` | Everything after recognition: fillers, dictionary, punctuation modes, layout, voice commands, snippets, subtitle cues |
| `backend/llm.py` | Optional smart formatting: Qwen3-4B through llama.cpp (Vulkan, ctypes) in a child process |
| `backend/memory.py` | Process and system memory through OS calls; returns None instead of raising |

Data dir: `SHOPOT_DATA_DIR`, else `.local/` from source, else `%APPDATA%/Shopot` or `~/Library/Application Support/Shopot` when packaged. In development the engine is `.venv` python `backend/engine.py --data-dir <dir>`; packaged, the PyInstaller binary in `resources/engine/`; `SHOPOT_PYTHON` overrides the interpreter.

## Invariants (keep them)

- **Security model.** Renderers are sandboxed, with contextIsolation and without Node. Navigation and window.open are denied. All `http(s)/ws(s)` requests from the session are cancelled; only the Python worker touches the network, and only for an explicit download. Every `ipcMain.handle` goes through `ipc()`/`trusted()`, which checks the sender and frame URL. Inputs are validated in main. A new IPC channel is registered via `ipc()` and exposed in `preload.cjs`.
- **Words never change.** Layout (rules or LLM) only tags sentences and rebuilds the text from the original sentences; the LLM never writes text. Tests check that the word sequence is unchanged.
- **Nothing is lost.** `runTranscription()` journals audio in `pendingRecordings` before inference; orphaned audio is recovered on startup.
- **No stale results.** A monotonically increasing `job` counter invalidates results after a cancel or restart. Late events must not reopen the widget or paste.
- **Paste never presses Enter.** `PasteService` sends only the standard paste shortcut and refuses with a coded reason (`focus-changed`, `modifiers`, `clipboard-changed`, `permission`, …) when anything changed. Target-app detection failures yield `app: null` and never block paste.
- **The journal never holds what the user said or typed.** Only main writes it, through `journal.write(event, fields)` with fields picked one by one: never a spread of a result, entry or settings, never `source` (an imported file's name), never `error.message` or the engine's stderr. A message is kept only for the engine's own `UserError`; library errors (some are `ValueError` and quote paths) and V8 errors go in by type and code. `tests/ui/journal.spec.cjs` checks this with marked private text.
- **No engine outlives the app.** A closed stdin or a failed stdout write makes the engine cancel its work, stop the formatter process and exit.
- **Unsupported combinations are refused twice**, in `validateSettings` and in the engine: GigaAM with a non-Russian language, translation with anything but Whisper small or large-v3.

## Non-obvious decisions

- Native modules are imported in the engine's main thread before the stdin reader thread starts: on Windows, loading a DLL deadlocks while another thread is blocked reading stdin.
- The LLM formatter runs in a child process (`engine.py --formatter-worker`): llama.cpp and ctranslate2 bring different OpenMP runtimes, and two in one process abort it. The child also contains crashes and hangs; any LLM failure falls back to the rules.
- Push-to-talk polls key state (`GetAsyncKeyState`, `CGEventSourceKeyState`) instead of a keyboard hook, which would route every keystroke in the system through Shopot.
- Whisper pads every chunk to a 30 s window, so even a short phrase costs a full encoder pass; decoder settings hardly change speed. GigaAM is the default for Russian. Measure with `.private/samples` before tuning.
- The engine uses at most 4 threads: more barely help and freeze laptops.
- `audio_path()` accepts only `<uuid>.<ext>` names resolving inside the audio dir, which guards against symlinks and MSIX redirection of `audio/` on Windows.
- Call recording merges the microphone (left) and WASAPI loopback system audio (right) into one stereo stream; each channel is recognised separately, and a microphone cue repeating overlapping system audio is dropped as echo.
- The page CSP (`style-src 'self'`) blocks inline `style` attributes, so dynamic sizes are set through the CSSOM. The UI is dark only; colour marks state only.

## UI tests

`tests/fixtures/harness.cjs` is the Playwright entry point: it stubs `Worker` with a fake ASR (`globalThis.__test.finish()/fail()/progress()`), captures the `globalShortcut` callbacks (`__test.toggle`, `__test.cancel`), wraps the real native input backend, then loads the real `main.cjs`. `tests/fixtures/app.cjs` runs the real app for the one test with the real worker. Both load `tests/fixtures/offscreen.cjs`, which keeps every test window off-screen, unfocused and off the taskbar; `SHOPOT_TEST_VISIBLE=1` shows them. Tests use Chromium's fake media devices and isolated data dirs under `.private/ui-test/`. `--hidden` starts the app in the tray without a window.

## Docs

Update docs in the same commit as the change:

- user-visible behaviour → `README.md` («Что умеет», «Где что работает», «Ограничения»);
- test coverage or a manual check → `VALIDATION.md`;
- version bump → `RELEASE_NOTES.md` (only what is new in this version);
- an architectural decision whose reason the code cannot show → this file.
