# Polyglot

Polyglot is a multilingual live screen companion for the Gemini Live Agent Challenge.

## Current status

Backend MVP scaffold is in progress.

## Backend

The backend lives in `backend/` and provides:
- FastAPI health endpoint
- WebSocket relay for Gemini Live sessions
- audio, image, and text event forwarding
- multilingual voice/session configuration

## Run the backend locally

- Copy `.env.example` to `.env`
- Set `GOOGLE_CLOUD_PROJECT` to your Google Cloud project id
- Authenticate with Application Default Credentials using `gcloud auth application-default login`
- Create a virtual environment and install dependencies from `backend/requirements.txt`
- Start the API with `uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload` from the `backend/` folder

## Current backend endpoints

- `GET /health`
- `WS /ws/live`

## Next steps

- finish backend validation flow
- add local frontend capture client
- add Cloud Run deployment files
