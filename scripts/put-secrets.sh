#!/usr/bin/env bash
# Populate the Secrets Manager entries Terraform created as placeholders.
#
# Terraform never sees these values: it creates each secret with "REPLACE_ME"
# and ignores subsequent changes, so nothing sensitive lands in state or tfvars.
#
# Usage:
#   ./scripts/put-secrets.sh                 # prompts for each secret
#   ./scripts/put-secrets.sh jira_api_token  # just one

set -euo pipefail

PROJECT="${PROJECT_NAME:-cloud-harness}"
ENVIRONMENT="${ENVIRONMENT:-poc}"
PREFIX="${PROJECT}-${ENVIRONMENT}"

declare -A SECRETS=(
  [jira_api_token]="${PREFIX}/jira-api-token"
  [bitbucket_token]="${PREFIX}/bitbucket-token"
  [llm_api_key]="${PREFIX}/llm-api-key"
)

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

if [[ $# -gt 0 ]]; then
  for key in "$@"; do put_secret "$key"; done
else
  for key in "${!SECRETS[@]}"; do put_secret "$key"; done
fi

echo
echo "Restart the watcher so it picks up new values:"
echo "  aws ecs update-service --cluster ${PREFIX} --service ${PREFIX}-watcher --force-new-deployment"
echo
echo "Agent tasks pick up new values on their next launch — no action needed."
