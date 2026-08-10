#!/usr/bin/env bash
# Populate the Secrets Manager entries Terraform created as placeholders.
#
# Terraform never sees these values: it creates each secret with "REPLACE_ME"
# and ignores subsequent changes, so nothing sensitive lands in state or tfvars.
#
# Usage:
#   ./scripts/put-secrets.sh                    # prompts for each secret
#   ./scripts/put-secrets.sh jira_api_token     # just one
#   ./scripts/put-secrets.sh --shared-bitbucket # one token -> all 3 identities

set -euo pipefail

PROJECT="${PROJECT_NAME:-cloud-harness}"
ENVIRONMENT="${ENVIRONMENT:-poc}"
PREFIX="${PROJECT}-${ENVIRONMENT}"

declare -A SECRETS=(
  [jira_api_token]="${PREFIX}/jira-api-token"
  [bitbucket_token_read]="${PREFIX}/bitbucket-token-read"
  [bitbucket_token_implementer]="${PREFIX}/bitbucket-token-implementer"
  [bitbucket_token_reviewer]="${PREFIX}/bitbucket-token-reviewer"
  [llm_api_key]="${PREFIX}/llm-api-key"
)

# The Bitbucket identities, in the order they are prompted for.
BITBUCKET_KEYS=(bitbucket_token_read bitbucket_token_implementer bitbucket_token_reviewer)

put_secret() {
  local key="$1"
  local name="${SECRETS[$key]:-}"

  if [[ -z "$name" ]]; then
    echo "Unknown secret '$key'. Known: ${!SECRETS[*]}" >&2
    exit 1
  fi

  if ! aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
    echo "Secret '$name' does not exist. Run terraform apply first." >&2
    echo "(llm_api_key is not created when llm_provider = bedrock.)" >&2
    return 0
  fi

  # -s keeps the value off the terminal and out of shell history.
  read -rsp "Value for ${name}: " value
  echo

  if [[ -z "$value" ]]; then
    echo "  skipped (empty input)"
    return 0
  fi

  aws secretsmanager put-secret-value \
    --secret-id "$name" \
    --secret-string "$value" \
    --output text --query 'VersionId' >/dev/null

  echo "  updated ${name}"
}

# Write one value to every Bitbucket identity. For a sandbox where the same
# service account plays all three parts — never for production, where the
# implementer and reviewer must be distinct or the reviewer's approval will not
# count towards a minimum-approval merge check.
put_shared_bitbucket() {
  echo "Writing ONE token to all three Bitbucket identities."
  echo "Sandbox only — in production these must be separate service accounts."
  read -rsp "Bitbucket token: " value
  echo

  if [[ -z "$value" ]]; then
    echo "  skipped (empty input)"
    return 0
  fi

  for key in "${BITBUCKET_KEYS[@]}"; do
    local name="${SECRETS[$key]}"
    if ! aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
      echo "  secret '$name' does not exist; run terraform apply first" >&2
      continue
    fi
    aws secretsmanager put-secret-value \
      --secret-id "$name" \
      --secret-string "$value" \
      --output text --query 'VersionId' >/dev/null
    echo "  updated ${name}"
  done
}

if [[ "${1:-}" == "--shared-bitbucket" ]]; then
  put_shared_bitbucket
elif [[ $# -gt 0 ]]; then
  for key in "$@"; do put_secret "$key"; done
else
  for key in "${!SECRETS[@]}"; do put_secret "$key"; done
fi

echo
echo "Restart the watcher so it picks up new values:"
echo "  aws ecs update-service --cluster ${PREFIX} --service ${PREFIX}-watcher --force-new-deployment"
echo
echo "Agent tasks pick up new values on their next launch — no action needed."
