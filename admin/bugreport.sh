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
  echo "usage: $0 \"bug report message here...\"" >&2
  exit 1
fi

message="$*"

if [[ -z "${API_ACCESS_KEY:-}" ]]; then
  echo "error: API_ACCESS_KEY is not set (add it to .env or export it)" >&2
  exit 1
fi

port="${PORT:-3000}"
host="${HOST:-localhost}"
if [[ "$host" == "0.0.0.0" ]]; then
  host="localhost"
fi
base_url="${BUGFIXAGENT_URL:-http://${host}:${port}}"

if command -v jq >/dev/null 2>&1; then
  payload="$(jq -n --arg message "$message" '{message: $message}')"
else
  payload="$(python3 -c 'import json, sys; print(json.dumps({"message": sys.argv[1]}))' "$message")"
fi

response="$(curl -sS -w "\n%{http_code}" \
  -X POST "${base_url}/investigations" \
  -H "Authorization: Bearer ${API_ACCESS_KEY}" \
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
