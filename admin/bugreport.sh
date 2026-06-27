#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
env_file="${repo_root}/.env"

if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

if [[ $# -lt 1 ]]; then
  echo "usage: $0 [--url BASE_URL] \"bug report message here...\"" >&2
  exit 1
fi

base_url="${BUGFIXAGENT_URL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      if [[ $# -lt 2 ]]; then
        echo "error: --url requires a value" >&2
        exit 1
      fi
      base_url="$2"
      shift 2
      ;;
    --url=*)
      base_url="${1#*=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      echo "usage: $0 [--url BASE_URL] \"bug report message here...\"" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -lt 1 ]]; then
  echo "usage: $0 [--url BASE_URL] \"bug report message here...\"" >&2
  exit 1
fi

message="$*"

if [[ -z "$base_url" ]]; then
  port="${PORT:-3000}"
  host="${HOST:-localhost}"
  if [[ "$host" == "0.0.0.0" ]]; then
    host="localhost"
  fi
  base_url="http://${host}:${port}"
fi

base_url="${base_url%/}"

if [[ -z "${EBRAM_API_ACCESS_KEY:-}" ]]; then
  echo "error: EBRAM_API_ACCESS_KEY is not set (add it to .env or export it)" >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  payload="$(jq -n --arg message "$message" '{message: $message}')"
else
  payload="$(python3 -c 'import json, sys; print(json.dumps({"message": sys.argv[1]}))' "$message")"
fi

response="$(curl -sS -w "\n%{http_code}" \
  -X POST "${base_url}/investigations" \
  -H "Authorization: Bearer ${EBRAM_API_ACCESS_KEY}" \
  -H "Content-Type: application/json" \
  -d "$payload")"

http_code="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
  echo "$body"
  exit 0
fi

echo "request failed (HTTP ${http_code})" >&2
echo "$body" >&2
exit 1
