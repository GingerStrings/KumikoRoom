# KumikoRoom

[中文说明](README.zh-CN.md)

KumikoRoom is a local-first music companion room centered on Oumae Kumiko. It combines a room-style chat UI, local memory, music search/playback tools, and runtime LLM configuration for OpenAI-compatible chat providers.

The project is a fan-made local development app. Keep credentials, personal data, and fan-provided media on your machine.

## What Is Included

- `apps/web`: Next.js room UI.
- `apps/api`: FastAPI backend for room state, chat, memory, music tools, and LLM access.
- `apps/desktop`: Electron shell that can open the local room URL.
- `docs`: design notes and implementation plans.
- `user-data`: local runtime data, ignored by git.

## Quick Start

Install workspace dependencies from the repo root:

```powershell
npm install
```

Start the API:

```powershell
cd apps\api
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
uvicorn kumikoroom.main:app --reload --port 8000
```

Start the web app in another terminal:

```powershell
npm run dev --workspace apps/web
```

Open:

```text
http://127.0.0.1:3000/room
```

The FL Studio creative archive is available at:

```text
http://127.0.0.1:3000/studio
```

If you want a different web port:

```powershell
npm run dev --workspace apps/web -- --port 3100
```

If the API is not on `8000`, point the web rewrite at the API before starting Next.js:

```powershell
$env:KUMIKOROOM_API_URL="http://127.0.0.1:8001"
npm run dev --workspace apps/web -- --port 3100
```

## Desktop Shell

The Electron shell opens the room URL. By default it uses `http://127.0.0.1:3000/room`, so start the API and web app first.

```powershell
npm run start --workspace apps/desktop
```

To open a different room URL:

```powershell
$env:KUMIKOROOM_WEB_URL="http://127.0.0.1:3100/room"
npm run start --workspace apps/desktop
```

## LLM Configuration

KumikoRoom can run with a local mock provider or an OpenAI-compatible chat completions endpoint.

### In-App Settings

Use the model settings panel in the room UI to set:

- Provider: `openai_compatible` or `deepseek`.
- Base URL: for example `https://api.openai.com/v1`, `https://api.deepseek.com`, or a compatible local endpoint.
- Model name.
- API key.

Keys entered in the UI stay in the current browser storage and are not committed to the repo.

The backend sends LLM requests directly and does not use the Windows system proxy environment by default. This avoids local proxy TLS failures such as `SSL: UNEXPECTED_EOF_WHILE_READING`.

### Environment Defaults

You can also provide DeepSeek defaults through environment variables. Copy `.env.example` to your own local env file or set the variables in your shell:

```powershell
$env:KUMIKOROOM_LLM_PROVIDER="deepseek"
$env:DEEPSEEK_API_KEY="<your-local-key>"
$env:DEEPSEEK_MODEL="deepseek-v4-flash"
$env:DEEPSEEK_BASE_URL="https://api.deepseek.com"
$env:KUMIKOROOM_MEMORY_DB_PATH="user-data/memory/kumikoroom-memory.sqlite3"
```

Do not commit `.env`, `.env.local`, API keys, or SQLite memory databases.

## FL Studio Creative Archive

The creative archive turns local FL Studio 21 projects into a searchable,
read-only library with project dashboards, arrangement and Pattern views,
plugin and Mixer inspection, dependency diagnostics, automatic-backup
timelines, semantic snapshot comparison, and printable project reports.

1. Start the API and Web app, then open `/studio`.
2. Use **Add project directory** to register one or more folders containing
   `.flp` files. Each root is scanned incrementally; cached results remain
   available while changed files are analyzed in the background.
3. Open a project card to inspect its dashboard and analysis tabs. Local open
   actions only resolve files already registered under a configured root.

Analysis metadata is stored in SQLite at
`user-data/studio/kumikoroom-studio.sqlite3` by default. Override it with
`KUMIKOROOM_STUDIO_DB_PATH`. The database contains local paths and parsed
structure, so treat it as private data and do not share it casually.

Source FLPs are opened for reading and are never saved, copied, restored, or
overwritten. Backup discovery checks `Backup`/`Backups` folders inside project
data and the standard FL Studio user backup directory. High-confidence matches
join the version timeline automatically; uncertain candidates remain separate
until confirmed. Confirmation only records an association in SQLite.

Current boundaries:

- The verified target is FL Studio 21. Newer or substantially older save
  formats can return partial analysis or a parse diagnostic.
- Third-party plugin internals, every native-plugin state block, and every
  Mixer route are not guaranteed to decode completely.
- Music-theory labels and section suggestions include confidence because they
  are structural inferences. Audio waveform, spectrum, loudness, mastering,
  project editing, cleanup, and restore are outside this release.
- Unavailable local dependencies remain diagnostics; the archive does not
  download or repair them.

To run the opt-in read-only contract against a private FLP outside Git:

```powershell
$env:KUMIKOROOM_TEST_FLP_PATH="D:\private\project.flp"
python -m pytest apps/api/tests/test_studio_local_flp.py -q
```

The contract verifies the source hash before and after parsing plus FL version,
tempo, Pattern, and Channel Rack structure. Leave the variable unset during
normal test runs; the local contract then reports as skipped.

## Local Novel RAG

KumikoRoom can build a local-only SQLite index from local Hibike! Euphonium / Kumiko EPUB files for persona and source grounding.

```powershell
cd apps\api
python -m kumikoroom.novel_rag rebuild
```

The corpus directory defaults to `D:\555\codex\jc`; if that path is missing, rebuild indexes zero sources. You can override it with `KUMIKOROOM_NOVEL_CORPUS_DIR`. The generated index defaults to `user-data/rag/kumiko-novels.sqlite3`, which is ignored by git. Set `KUMIKOROOM_NOVEL_RAG_ENABLED=false` to disable local novel RAG.

## Testing

API tests:

```powershell
python -m pytest apps/api/tests -q
```

Web tests:

```powershell
npm run test --workspace apps/web
```

Desktop tests:

```powershell
npm run test --workspace apps/desktop
```

All workspace tests:

```powershell
npm test
```

## Local Data And Fan Project Boundary

The repository ignores `.env`, `.env.local`, `user-data/`, and `*.sqlite3`.

Do not commit character images, voice samples, trained voice models, copyrighted audio, or other fan-provided media. Keep local-only assets under `user-data/`.
