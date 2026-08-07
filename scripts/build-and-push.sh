#!/usr/bin/env bash
# Build and push every image this deployment needs.
#
#   watcher      the always-on poller
#   agents-base  agent code + git, no language toolchain (the refiner runs this)
#   agents-<s>   one per configured stack, FROM agents-base, adding that stack's
#                runtime so the implementer and reviewer can actually build and
#                test the target repo
#
# The base image is built first and the stack images are built FROM it, so the
# TypeScript compile happens once rather than once per stack.
#
# Task definitions pin linux/arm64 (Graviton — cheaper per vCPU-hour), so this
# always builds arm64 regardless of the host.
#
# Usage:
#   ./scripts/build-and-push.sh                # everything
#   ./scripts/build-and-push.sh watcher        # just the watcher
#   ./scripts/build-and-push.sh agents-python  # one stack (base is rebuilt first)
#   TAG=v3 ./scripts/build-and-push.sh
#   STACKS="node python" ./scripts/build-and-push.sh   # skip terraform lookup

set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="${PROJECT_NAME:-cloud-harness}"
ENVIRONMENT="${ENVIRONMENT:-poc}"
TAG="${TAG:-latest}"
REGION="${AWS_REGION:-us-east-1}"
PLATFORM="linux/arm64"
BASE_LOCAL_TAG="cloud-harness-agents-base:${TAG}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# Which stacks exist is Terraform's answer, not this script's. Falls back to the
# STACKS env var so the script still works before the first apply.
if [[ -z "${STACKS:-}" ]]; then
  if STACKS="$(cd infra && terraform output -json stacks 2>/dev/null | jq -r '.known | join(" ")')"; then
    :
  else
    echo "Could not read stacks from terraform. Set STACKS=\"node python\" to override." >&2
    exit 1
  fi
fi
read -ra STACK_LIST <<< "$STACKS"

TARGETS=("${@:-}")
if [[ -z "${TARGETS[0]}" ]]; then
  TARGETS=(watcher agents-base)
  for stack in "${STACK_LIST[@]}"; do TARGETS+=("agents-${stack}"); done
fi

echo "Logging in to ${REGISTRY}"
aws ecr get-login-password --region "$REGION" |
  docker login --username AWS --password-stdin "$REGISTRY"

push() { # repo_suffix local_tag
  local image="${REGISTRY}/${PROJECT}-${ENVIRONMENT}/${1}:${TAG}"
  docker tag "$2" "$image"
  echo "==> Pushing ${image}"
  docker push "$image"
}

build_base() {
  echo
  echo "==> Building agents-base for ${PLATFORM}"
  docker build --platform "$PLATFORM" \
    -f services/agents/Dockerfile.base \
    -t "$BASE_LOCAL_TAG" .
}

base_built=false
ensure_base() {
  $base_built && return 0
  build_base
  base_built=true
}

for target in "${TARGETS[@]}"; do
  case "$target" in
    watcher)
      echo
      echo "==> Building watcher for ${PLATFORM}"
      docker build --platform "$PLATFORM" \
        -f services/watcher/Dockerfile \
        -t "cloud-harness-watcher:${TAG}" .
      push watcher "cloud-harness-watcher:${TAG}"
      ;;

    agents-base)
      ensure_base
      push agents-base "$BASE_LOCAL_TAG"
      ;;

    agents-*)
      stack="${target#agents-}"
      dockerfile="services/agents/Dockerfile.${stack}"
      if [[ ! -f "$dockerfile" ]]; then
        echo "No Dockerfile for stack '${stack}' (expected ${dockerfile})." >&2
        echo "Add it, or remove the stack from the terraform \`stacks\` variable." >&2
        exit 1
      fi

      # Stack images are FROM the base, so it has to exist locally first.
      ensure_base

      echo
      echo "==> Building ${target} for ${PLATFORM}"
      docker build --platform "$PLATFORM" \
        -f "$dockerfile" \
        --build-arg "BASE_IMAGE=${BASE_LOCAL_TAG}" \
        -t "cloud-harness-${target}:${TAG}" .
      push "$target" "cloud-harness-${target}:${TAG}"
      ;;

    *)
      echo "Unknown target: ${target}" >&2
      exit 1
      ;;
  esac
done

echo
echo "Roll the watcher onto its new image:"
echo "  make restart-watcher"
echo "# agents need no roll — each dispatcher launches the latest task revision"
