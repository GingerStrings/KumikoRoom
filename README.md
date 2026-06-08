# KumikoRoom

KumikoRoom is a local-first music companionship app centered on Kumiko Oumae.

The main entry is the companion room. The Creative Archive is an internal feature area for local music projects, demo audio, notes, and FL Studio project metadata.

## Development

Web app:

```powershell
cd apps\web
npm install
npm run dev
```

API:

```powershell
cd apps\api
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
uvicorn kumikoroom.main:app --reload --port 8000
```

Desktop shell:

```powershell
cd apps\desktop
npm install
npm start
```

## DeepSeek Chat Setup

KumikoRoom uses DeepSeek for the first real LLM provider. Keep credentials local.

1. Copy `.env.example` to `.env.local` or set the same variables in your shell.
2. Set `DEEPSEEK_API_KEY` locally.
3. Keep `DEEPSEEK_MODEL=deepseek-v4-flash` unless you want to test `deepseek-v4-pro`.
4. Start the API and web app.

PowerShell API example:

```powershell
$env:KUMIKOROOM_LLM_PROVIDER="deepseek"
$env:DEEPSEEK_API_KEY="<your-local-key>"
$env:DEEPSEEK_MODEL="deepseek-v4-flash"
cd apps\api
uvicorn kumikoroom.main:app --reload --port 8000
```

The repository ignores `.env`, `.env.local`, `user-data/`, and `*.sqlite3`.

## Fan Project Boundary

Do not commit character images, voice samples, trained voice models, or other fan-provided media. Local assets belong under `user-data/`, which is ignored by git.
