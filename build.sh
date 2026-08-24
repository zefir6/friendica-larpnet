#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --release: also promote this build to prod (:latest, :prod, :prod-<sha>),
# preserving the current :prod as :oldprod first. Without it, this script
# only builds and pushes the versioned tag - it never touches :latest/:prod
# on its own. This is the break-glass equivalent of pushing a release-*
# git tag (see .github/workflows/build.yml) for when CI isn't available.
RELEASE=false
if [[ "${1:-}" == "--release" ]]; then
  RELEASE=true
fi

# Load credentials
ENV_FILE="${SCRIPT_DIR}/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env not found — copy .env.example and fill in credentials" >&2
  exit 1
fi
source "$ENV_FILE"

: "${REGISTRY_URL:?REGISTRY_URL not set in .env}"
: "${REGISTRY_USER:?REGISTRY_USER not set in .env}"
: "${REGISTRY_PASSWORD:?REGISTRY_PASSWORD not set in .env}"

if $RELEASE; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$BRANCH" != "larpnet" ]]; then
    echo "ERROR: --release must be run from the larpnet branch (currently on ${BRANCH})" >&2
    exit 1
  fi
fi

# REGISTRY_PUSH_URL: optional SSH-tunnel endpoint to bypass Cloudflare upload limits.
# If set, the image is built+tagged with REGISTRY_URL (the real name) but pushed
# via REGISTRY_PUSH_URL (e.g. localhost:5000). The registry stores the same image
# and serves it under REGISTRY_URL normally.
PUSH_URL="${REGISTRY_PUSH_URL:-$REGISTRY_URL}"

# Derive image tags
FRIENDICA_VERSION=$(grep '^FROM friendica:' Dockerfile | sed 's/FROM friendica:\(.*\)-fpm/\1/')
LARPNET_VERSION=$(git rev-parse --short HEAD)
TAG="${FRIENDICA_VERSION}-${LARPNET_VERSION}"
IMAGE="${REGISTRY_URL}/friendica-larpnet"
PUSH_IMAGE="${PUSH_URL}/friendica-larpnet"

echo "Building ${IMAGE}:${TAG}"
[[ "$PUSH_URL" != "$REGISTRY_URL" ]] && echo "Pushing via tunnel: ${PUSH_IMAGE}"

docker login "$PUSH_URL" -u "$REGISTRY_USER" -p "$REGISTRY_PASSWORD"

docker build -t "${IMAGE}:${TAG}" "$SCRIPT_DIR"

if [[ "$PUSH_URL" != "$REGISTRY_URL" ]]; then
  docker tag "${IMAGE}:${TAG}" "${PUSH_IMAGE}:${TAG}"
fi
docker push "${PUSH_IMAGE}:${TAG}"

if ! $RELEASE; then
  echo "Done — pushed ${IMAGE}:${TAG} (not released; use --release to publish :latest/:prod)"
  exit 0
fi

echo "Releasing to prod..."

if docker buildx imagetools inspect "${PUSH_IMAGE}:prod" >/dev/null 2>&1; then
  docker buildx imagetools create --tag "${PUSH_IMAGE}:oldprod" "${PUSH_IMAGE}:prod"
else
  echo "No existing :prod tag yet — first release, nothing to preserve."
fi

for RELEASE_TAG in latest prod "prod-${LARPNET_VERSION}"; do
  docker tag "${IMAGE}:${TAG}" "${IMAGE}:${RELEASE_TAG}"
  if [[ "$PUSH_URL" != "$REGISTRY_URL" ]]; then
    docker tag "${IMAGE}:${TAG}" "${PUSH_IMAGE}:${RELEASE_TAG}"
  fi
  docker push "${PUSH_IMAGE}:${RELEASE_TAG}"
done

echo "Done — released ${IMAGE}:${TAG} as :latest, :prod, :prod-${LARPNET_VERSION} (previous :prod preserved as :oldprod)"
