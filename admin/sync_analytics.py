#!/usr/bin/env python3
"""Sync SQLite ops DB into DuckDB snapshot + rollup tables."""

from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path

from record_store import resolve_db_path, resolve_duckdb_path

ADMIN_DIR = Path(__file__).resolve().parent
SYNC_SQL = ADMIN_DIR / 'sync-duckdb.sql'


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main() -> int:
    sqlite_path = resolve_db_path()
    duckdb_path = resolve_duckdb_path()

    if not sqlite_path.is_file():
        print(f'sqlite record store not found: {sqlite_path}', file=sys.stderr)
        return 1

    duckdb_cli = shutil.which('duckdb')
    if not duckdb_cli:
        print('duckdb CLI not found. Install with: brew install duckdb', file=sys.stderr)
        return 1

    duckdb_path.parent.mkdir(parents=True, exist_ok=True)
    sync_body = SYNC_SQL.read_text(encoding='utf-8')
    sql = '\n'.join([
        'LOAD sqlite;',
        f'ATTACH {sql_string(str(sqlite_path))} AS ops (TYPE sqlite, READ_ONLY);',
        sync_body,
        "SELECT 'investigations' AS table_name, count(*)::BIGINT AS rows FROM investigations",
        "UNION ALL SELECT 'log_events', count(*)::BIGINT FROM log_events",
        "UNION ALL SELECT 'hourly_stats', count(*)::BIGINT FROM hourly_stats",
        'ORDER BY 1;',
    ])

    started = time.monotonic()
    result = subprocess.run(
        [duckdb_cli, str(duckdb_path), '-csv', '-c', sql],
        capture_output=True,
        text=True,
    )
    elapsed_ms = int((time.monotonic() - started) * 1000)

    if result.returncode != 0:
        print('analytics sync failed', file=sys.stderr)
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        if result.stdout.strip():
            print(result.stdout.strip(), file=sys.stderr)
        return result.returncode

    print(f'synced {sqlite_path}')
    print(f'  -> {duckdb_path}')
    print(f'  in {elapsed_ms}ms')
    print()
    print('table,rows')
    print(result.stdout.strip())
    return 0


if __name__ == '__main__':
    sys.exit(main())
