"""Shared SQLite record-store helpers for admin CLIs."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path | None = None) -> None:
    env_path = path or (REPO_ROOT / '.env')
    if not env_path.is_file():
        return

    for raw_line in env_path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def resolve_db_path(path: str | Path | None = None) -> Path:
    if path is not None:
        candidate = Path(path).expanduser()
        if candidate.is_absolute():
            return candidate
        return (REPO_ROOT / candidate).resolve()

    load_dotenv()
    custom = os.environ.get('RECORD_STORE_SQLITE_PATH', '').strip()
    if custom:
        candidate = Path(custom).expanduser()
        if candidate.is_absolute():
            return candidate
        return (REPO_ROOT / candidate).resolve()

    return REPO_ROOT / 'data' / 'bugfixagent.db'


def connect_readonly(db_path: Path) -> sqlite3.Connection:
    if not db_path.is_file():
        raise FileNotFoundError(f'record store not found: {db_path}')

    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    return conn
