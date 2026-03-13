#!/usr/bin/env bash
# Polyglot — Automated Cloud Deployment
# Deploys both backend and frontend to Google Cloud Run in one command.
#
# Usage:
#   ./deploy.sh                          # Deploy both services
#   ./deploy.sh --backend-only           # Deploy backend only
#   ./deploy.sh --frontend-only          # Deploy frontend only
#
# Prerequisites:
#   - gcloud CLI authenticated (gcloud auth login)
#   - Docker installed and running
#   - Project ID set in .env or passed via GCP_PROJECT env var

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT:-intrepid-kiln-469706-g1}"
REGION="${GCP_REGION:-us-east1}"
REPO="cloud-run-source-deploy"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"

BACKEND_IMAGE="${REGISTRY}/polyglot-backend"
FRONTEND_IMAGE="${REGISTRY}/polyglot-frontend"

BACKEND_SERVICE="polyglot-backend"
FRONTEND_SERVICE="polyglot-frontend"

# ── Parse args ────────────────────────────────────────────────────────
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=true

for arg in "$@"; do
  case $arg in
    --backend-only)  DEPLOY_FRONTEND=false ;;
    --frontend-only) DEPLOY_BACKEND=false ;;
    --help) echo "Usage: ./deploy.sh [--backend-only|--frontend-only]"; exit 0 ;;
  esac
done

echo "============================================"
echo "  Polyglot Cloud Deployment"
echo "  Project:  ${PROJECT_ID}"
echo "  Region:   ${REGION}"
echo "============================================"
echo ""

# ── Ensure Artifact Registry repo exists ──────────────────────────────
echo ">> Checking Artifact Registry..."
if ! gcloud artifacts repositories describe "${REPO}" \
  --location="${REGION}" --project="${PROJECT_ID}" &>/dev/null; then
  echo ">> Creating Artifact Registry repository..."
  gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --description="Polyglot Docker images"
fi

# ── Configure Docker auth ─────────────────────────────────────────────
echo ">> Configuring Docker authentication..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# ── Deploy Backend ────────────────────────────────────────────────────
if [ "$DEPLOY_BACKEND" = true ]; then
  echo ""
  echo ">> Building backend image..."
  docker build -t "${BACKEND_IMAGE}:latest" ./backend

  echo ">> Pushing backend image..."
  docker push "${BACKEND_IMAGE}:latest"

  echo ">> Deploying backend to Cloud Run..."
  gcloud run deploy "${BACKEND_SERVICE}" \
    --image="${BACKEND_IMAGE}:latest" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --allow-unauthenticated \
    --set-env-vars="\
GOOGLE_CLOUD_PROJECT=${PROJECT_ID},\
GOOGLE_CLOUD_LOCATION=${REGION},\
GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio,\
ALLOWED_ORIGINS=*,\
DEFAULT_VOICE=Aoede,\
DEFAULT_LANGUAGE_CODE=en-US" \
    --timeout=3600 \
    --session-affinity \
    --min-instances=0 \
    --max-instances=3 \
    --memory=512Mi \
    --cpu=1 \
    --port=8080

  BACKEND_URL=$(gcloud run services describe "${BACKEND_SERVICE}" \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --format="value(status.url)")
  echo ">> Backend deployed: ${BACKEND_URL}"
fi

# ── Deploy Frontend ───────────────────────────────────────────────────
if [ "$DEPLOY_FRONTEND" = true ]; then
  # Get backend URL if we didn't just deploy it
  if [ -z "${BACKEND_URL:-}" ]; then
    BACKEND_URL=$(gcloud run services describe "${BACKEND_SERVICE}" \
      --region="${REGION}" --project="${PROJECT_ID}" \
      --format="value(status.url)" 2>/dev/null || echo "")
  fi

  if [ -z "${BACKEND_URL}" ]; then
    echo "ERROR: Backend not deployed yet. Run ./deploy.sh --backend-only first."
    exit 1
  fi

  WS_URL="wss://${BACKEND_URL#https://}/ws/live"

  echo ""
  echo ">> Building frontend image (WS_URL=${WS_URL})..."
  docker build \
    --build-arg "NEXT_PUBLIC_WS_URL=${WS_URL}" \
    -t "${FRONTEND_IMAGE}:latest" \
    ./frontend

  echo ">> Pushing frontend image..."
  docker push "${FRONTEND_IMAGE}:latest"

  echo ">> Deploying frontend to Cloud Run..."
  gcloud run deploy "${FRONTEND_SERVICE}" \
    --image="${FRONTEND_IMAGE}:latest" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --allow-unauthenticated \
    --min-instances=0 \
    --max-instances=3 \
    --memory=256Mi \
    --cpu=1 \
    --port=3000

  FRONTEND_URL=$(gcloud run services describe "${FRONTEND_SERVICE}" \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --format="value(status.url)")
  echo ">> Frontend deployed: ${FRONTEND_URL}"
fi

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  Deployment Complete!"
echo "============================================"
if [ "$DEPLOY_BACKEND" = true ]; then
  echo "  Backend:  ${BACKEND_URL}"
fi
if [ "$DEPLOY_FRONTEND" = true ]; then
  echo "  Frontend: ${FRONTEND_URL}"
fi
echo ""
echo "  GCP Console: https://console.cloud.google.com/run?project=${PROJECT_ID}"
echo "============================================"
