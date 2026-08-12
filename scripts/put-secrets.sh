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
#   ./scripts/put-secrets.sh --from-env         # take values from the environment
#   ./scripts/put-secrets.sh --from-env .env.local   # ...or from an env file
#
# --from-env exists for a stack that is destroyed and recreated daily: every
# apply makes the secrets fresh placeholders, and typing five credentials each
# morning is how one of them ends up wrong. The variable names are the same ones
# the services read (see packages/shared/src/config.ts), so one vocabulary
# covers local runs and this script.
#
# The file is PARSED, not sourced: values here contain spaces and are unquoted,
# which `source` mishandles in zsh. Only the keys below are read from it, and
# nothing is evaluated.

set -euo pipefail

PROJECT="${PROJECT_NAME:-cloud-harness}"
ENVIRONMENT="${ENVIRONMENT:-poc}"
PREFIX="${PROJECT}-${ENVIRONMENT}"

# Plain functions rather than associative arrays: macOS ships bash 3.2, where
# `declare -A` is not a syntax error but silently makes an INDEXED array and
# evaluates each subscript as arithmetic — so the script died on its own first
# lookup. Nothing here needs bash 4.
ALL_KEYS="jira_api_token bitbucket_token_read bitbucket_token_implementer bitbucket_token_reviewer llm_api_key"

# The Bitbucket identities, in the order they are prompted for.
BITBUCKET_KEYS="bitbucket_token_read bitbucket_token_implementer bitbucket_token_reviewer"

secret_name_for() {
  case "$1" in
    jira_api_token)              echo "${PREFIX}/jira-api-token" ;;
    bitbucket_token_read)        echo "${PREFIX}/bitbucket-token-read" ;;
    bitbucket_token_implementer) echo "${PREFIX}/bitbucket-token-implementer" ;;
    bitbucket_token_reviewer)    echo "${PREFIX}/bitbucket-token-reviewer" ;;
    llm_api_key)                 echo "${PREFIX}/llm-api-key" ;;
    *)                           echo "" ;;
  esac
}

# secret -> the environment variable --from-env reads it from. Mirrors the names
# the running services use, so .env.local works as the source unchanged.
env_var_for() {
  case "$1" in
    jira_api_token)              echo "JIRA_API_TOKEN" ;;
    bitbucket_token_read)        echo "BITBUCKET_TOKEN" ;;
    bitbucket_token_implementer) echo "BITBUCKET_IMPLEMENTER_TOKEN" ;;
    bitbucket_token_reviewer)    echo "BITBUCKET_REVIEWER_TOKEN" ;;
    llm_api_key)                 echo "LLM_API_KEY" ;;
    *)                           echo "" ;;
  esac
}

secret_exists() {
  aws secretsmanager describe-secret --secret-id "$1" >/dev/null 2>&1
}

write_secret() { # name value
  aws secretsmanager put-secret-value \
    --secret-id "$1" \
    --secret-string "$2" \
    --output text --query 'VersionId' >/dev/null

  echo "  updated ${1}"
}

put_secret() {
  local key="$1"
  local name
  name="$(secret_name_for "$key")"

  if [[ -z "$name" ]]; then
    echo "Unknown secret '$key'. Known: ${ALL_KEYS}" >&2
    exit 1
  fi

  if ! secret_exists "$name"; then
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

  write_secret "$name" "$value"
}

# Read the values we need out of an env file WITHOUT sourcing it.
#
# Sourcing is wrong twice over: values in .env.local contain spaces and are
# unquoted, which zsh will not parse, and a credentials file should not be
# executable input in the first place. Only the five keys in ENV_FOR are taken;
# an already-exported variable wins, matching how the shell beats --env-file
# everywhere else in this project.
load_env_file() {
  local file="$1"

  if [[ ! -f "$file" ]]; then
    echo "No such env file: ${file}" >&2
    exit 1
  fi

  local wanted="" key
  for key in $ALL_KEYS; do wanted="${wanted} $(env_var_for "$key")"; done
  wanted="${wanted} "

  local line value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *"="* ]] && continue

    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}" # ltrim
    key="${key%"${key##*[![:space:]]}"}" # rtrim
    [[ "$wanted" != *" $key "* ]] && continue

    value="${line#*=}"
    # Strip one layer of matching quotes; leave anything else alone.
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi

    [[ -n "${!key:-}" ]] && continue
    export "$key=$value"
  done < "$file"
}

# Write whatever the environment actually has, and say plainly what it does not.
#
# Missing values are skipped rather than prompted for: the point of this mode is
# that it does not stop and wait, so that it can run unattended right after an
# apply. A secret left at REPLACE_ME fails loudly at task start, which is a
# better place to find out than a half-finished script.
put_from_env() {
  local wrote=0 missing=""
  local key env_name name value

  for key in $ALL_KEYS; do
    name="$(secret_name_for "$key")"
    env_name="$(env_var_for "$key")"
    value="${!env_name:-}"

    if [[ -z "$value" ]]; then
      missing="${missing}${missing:+, }\$${env_name}"
      continue
    fi

    if ! secret_exists "$name"; then
      # Normal for llm_api_key under Bedrock; noteworthy for anything else.
      echo "  no secret ${name} in this deployment; skipped"
      continue
    fi

    write_secret "$name" "$value"
    wrote=$((wrote + 1))
  done

  echo "  ${wrote} secret(s) written from the environment"
  if [[ -n "$missing" ]]; then
    echo "  not set, left as-is: ${missing}" >&2
  fi
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

  local key name
  for key in $BITBUCKET_KEYS; do
    name="$(secret_name_for "$key")"
    if ! secret_exists "$name"; then
      echo "  secret '$name' does not exist; run terraform apply first" >&2
      continue
    fi
    write_secret "$name" "$value"
  done
}

if [[ "${1:-}" == "--shared-bitbucket" ]]; then
  put_shared_bitbucket
elif [[ "${1:-}" == "--from-env" ]]; then
  [[ -n "${2:-}" ]] && load_env_file "$2"
  put_from_env
elif [[ $# -gt 0 ]]; then
  for key in "$@"; do put_secret "$key"; done
else
  for key in $ALL_KEYS; do put_secret "$key"; done
fi

echo
echo "Restart the watcher so it picks up new values:"
echo "  aws ecs update-service --cluster ${PREFIX} --service ${PREFIX}-watcher --force-new-deployment"
echo
echo "Agent tasks pick up new values on their next launch — no action needed."
