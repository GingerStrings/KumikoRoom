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

## Fan Project Boundary

Do not commit character images, voice samples, trained voice models, or other fan-provided media. Local assets belong under `user-data/`, which is ignored by git.
