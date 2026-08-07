#!/usr/bin/env bash
# Build the two images and push them to ECR.
#
# Two images, not four: the three agents ship as one image with three
# entrypoints, selected by the `command` in each task definition.
#
# Task definitions pin linux/arm64 (Graviton — cheaper per vCPU-hour), so this
# always builds arm64 regardless of the host.
#
# Usage:
#   ./scripts/build-and-push.sh              # both images, tag :latest
#   ./scripts/build-and-push.sh agents       # one image
#   TAG=v3 ./scripts/build-and-push.sh       # explicit tag

set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="${PROJECT_NAME:-cloud-harness}"
ENVIRONMENT="${ENVIRONMENT:-poc}"
TAG="${TAG:-latest}"
REGION="${AWS_REGION:-us-east-1}"
PLATFORM="linux/arm64"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

IMAGES=("${@:-}")
if [[ -z "${IMAGES[0]}" ]]; then
  IMAGES=(watcher agents)
fi

echo "Logging in to ${REGISTRY}"
aws ecr get-login-password --region "$REGION" |
  docker login --username AWS --password-stdin "$REGISTRY"

for image_name in "${IMAGES[@]}"; do
  repo="${PROJECT}-${ENVIRONMENT}/${image_name}"
  image="${REGISTRY}/${repo}:${TAG}"

  echo
  echo "==> Building ${image_name} for ${PLATFORM}"
  docker build \
    --platform "$PLATFORM" \
    -f "services/${image_name}/Dockerfile" \
    -t "$image" \
    .

  echo "==> Pushing ${image}"
  docker push "$image"
done

echo
echo "Roll the watcher onto the new image:"
echo "  make restart-watcher"
echo "# agents need no roll — each dispatcher launches the latest task revision"
