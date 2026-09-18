# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Shopot (Шёпот) is a local dictation desktop app for Windows and macOS. Electron is the UI and controller. A Python worker runs GigaAM v3 (default, Russian only, via onnx-asr) or Whisper (faster-whisper) on the CPU (INT8). A global hotkey (`CommandOrControl+Shift+Space`) records audio, and the resulting text is auto-pasted into the window that had focus when recording started. All user-facing strings, error messages and docs are in Russian; keep new UI text in Russian.

## Commands

Requires Node.js 24 and Python 3.11 (3.12 also works). Commands below use the Windows venv path; on macOS use `.venv/bin/python`.

```sh
npm ci
npm run setup            # creates .venv and installs backend/requirements.txt
npm start                # launches Electron via scripts/launch.cjs (strips ELECTRON_RUN_AS_NODE)

npm test                 # node --test tests/*.test.cjs (store + paste unit tests)
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
- Build installers only on the target OS and architecture. `.github/workflows/build.yml` runs pytest, `npm test`, `test:ui`, `dist` and `test:packaged` on Windows x64, macOS arm64 and macOS Intel. It publishes a release for `v*` tags, using `RELEASE_NOTES.md` as the release notes.
- `scripts/evaluate.py` and `scripts/verify-microphone.cjs` check real recognition on a local recording. Outputs go to `.private/`, which is gitignored.

## Architecture

**Processes.** `electron/main.cjs` is the controller. It owns the store, the global shortcuts, the tray, the floating widget window, the paste service, and the worker process. `electron/worker.cjs` spawns the Python engine and talks to it over **JSON lines on stdin/stdout** (`{id, command, ...payload}` → `{id, result|error}`, plus `ready`/`progress` events). There is no HTTP server. In development the engine runs as `.venv` python `backend/engine.py --data-dir <dir>`. In a packaged build it is the PyInstaller binary in `resources/engine/`. `SHOPOT_PYTHON` overrides the interpreter.

**Engine (`backend/`).** `engine.py` handles the `download` and `transcribe` commands. Model repos are pinned to exact HF revisions in `MODELS`. A model counts as installed only when `shopot-ready.json` contains the matching revision. `audio_path()` accepts only `<uuid>.<ext>` names that resolve inside the audio dir; this guards against symlinks and redirection, including MSIX-redirected `audio/` on Windows. A reader thread takes commands off stdin: `cancel` (it cancels the running request and any queued ones, and the model stays loaded) and `preload` (sent by main in `beginCapture`, so the model loads while the user is still speaking) are fire-and-forget messages sent with `worker.notify()`. Only a model download is interrupted by restarting the process. The model is unloaded after 10 minutes idle. It runs on at most 4 threads: measurements showed more threads barely help and freeze laptops. Each model entry in `MODELS` has an `engine` (`gigaam` or `whisper`), its languages, and its file list. GigaAM audio is split at VAD pauses into windows of at most 20 s (`speech_windows`), and the chunks are joined with `join_segments`, which removes the capital a chunk starts with when the sentence continues. The GigaAM + non-Russian combination is rejected both in `validateSettings` and in the engine. Native modules are imported in the main thread before the stdin reader thread starts: on Windows, loading a DLL deadlocks while another thread is blocked reading stdin. Whisper pads every chunk to a 30 s window, so even a short phrase costs a full encoder pass (~4.5 s on a desktop CPU), and decoder settings such as `beam_size` hardly change speed. Measure with `.private/samples` before tuning. `text_processing.py` also lays out paragraphs and lists: `rule_tags` (or, later, a language model) tags every sentence as `new`/`same`/`num`/`bul`, and `render_layout` rebuilds the text from the original sentences. Words never change, which the tests check. Optional smart formatting (`formatting: 'llm'`, Windows x64) runs Qwen3-4B through the official llama.cpp Vulkan build loaded with ctypes (`backend/llm.py`; no server). The structs are pinned to `LLAMA_BUILD` and checked against known defaults. The fixed JSON answer is fed as text, and only the 4 tag logits are compared per sentence. The engine downloads the runtime zip (SHA-256 pinned) and the GGUF (`download-formatter`), and any LLM failure falls back to the rules. Long pauses come from recognition segments (`pause_sentences`). GigaAM windows are also split at pauses of `PARAGRAPH_PAUSE_SECONDS` or longer. `text_processing.py` implements the dictionary alias replacement (whole words, Unicode boundaries, no chained replacements) and the punctuation modes `natural` / `minimal` / `raw`.

**Recording flow.** The *main renderer* (`renderer/app.js`) does the actual microphone capture with MediaRecorder (webm/opus), even for global-hotkey dictation while the main window is hidden. The flow:
1. Main calls `beginCapture()`, which snapshots settings and dictionary and captures the paste target (foreground window and focus).
2. The renderer sends `capture-update` phases: `requesting → recording → stopping`.
3. The renderer sends the audio bytes via the `transcribe` IPC.
4. `runTranscription()` writes the audio to `audioDir` and **journals it in `pendingRecordings` before inference**, so a crash leaves it available to retry.
5. The result is added to history and handed to `PasteService.deliver()`.

A monotonically increasing `job` counter invalidates stale results after a cancel or restart. Late events must not reopen the widget or paste. On startup, any orphaned audio files are recovered into `pendingRecordings`.

**UI.** The interface is dark only (`nativeTheme.themeSource = 'dark'`). `renderer/styles.css` holds the colour and font tokens on `:root`: colour appears only for state (red recording, green done, yellow attention, blue recommendation). The main window has top tabs (`data-page`), and history and dictionary are list-plus-detail panes. The page CSP (`style-src 'self'`) blocks inline `style` attributes, so dynamic sizes such as waveform bars and progress are set through the CSSOM.

**Widget.** `renderer/widget.html/js` is a non-focusable, always-on-top window with its own narrow preload (`widget-preload.cjs`) and IPC (`widget-boot`, `widget-action`). Stopping a recording hides it immediately, and transcription continues in the background.

**Auto-paste.** `electron/paste.cjs` (`PasteService`) sends only the standard paste shortcut, never Enter. It refuses to paste and returns a coded reason (`focus-changed`, `modifiers`, `clipboard-changed`, `permission`, …) if the target window or focus changed, modifier keys are held, or the clipboard no longer holds the text. `electron/native-input.cjs` implements the OS backends with Koffi: Win32 `SendInput`, and macOS Accessibility/CoreGraphics.

**Security model (preserve it).** The renderers are sandboxed, run with contextIsolation and without Node. Navigation and window.open are denied. All `http(s)/ws(s)` requests from the session are cancelled; only the Python worker touches the network, and only for an explicit model download. Every `ipcMain.handle` goes through `ipc()`/`trusted()`, which checks the sender and frame URL. Inputs are validated in main (`validateSettings`/`validateDictionary` in `store.cjs`, `modelId`, `textValue`, and size limits). When you add an IPC channel, register it via `ipc()` and expose it in `preload.cjs`.

**Storage.** `store.cjs` keeps settings, the dictionary, history and `pendingRecordings` in `store.json` as plain JSON, written atomically (tmp + rename). The data dir is `SHOPOT_DATA_DIR`, or `.local/` when running from source, or `%APPDATA%/Shopot` / `~/Library/Application Support/Shopot` when packaged. Models live in `<dataDir>/models` and audio in `<dataDir>/audio`.

**UI tests.** `tests/fixtures/harness.cjs` is the Electron entry point for Playwright. It stubs `Worker` with a fake ASR (tests call `globalThis.__test.finish()/fail()/progress()`), captures the `globalShortcut` callbacks (`__test.toggle`, `__test.cancel`), and wraps the real native input backend. It then loads the real `main.cjs`. Tests use Chromium's fake media devices and isolated data dirs under `.private/ui-test/`.

`VALIDATION.md` lists what has been verified automatically versus manually. Update it when test coverage or verification scope changes.
