#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <investigation-request-id> [-- db-path]" >&2
  echo "example: $0 550e8400-e29b-41d4-a716-446655440000" >&2
  exit 1
fi

cd "$script_dir"
python3 inspectinvestigation.py "$@"
