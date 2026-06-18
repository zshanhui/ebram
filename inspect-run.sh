#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <run-id> [agent-id]" >&2
  echo "example: $0 run-13b57da0-1ba0-4b89-a68a-37c47c0a124f" >&2
  exit 1
fi

cd "$script_dir"
pnpm exec tsx inspect-run.ts "$@"
