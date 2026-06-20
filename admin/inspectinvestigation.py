#!/usr/bin/env python3
"""Print investigation summary and log timeline from the SQLite record store."""

from __future__ import annotations

import argparse
import json
import sys
import textwrap
from pathlib import Path
from typing import Any

ADMIN_DIR = Path(__file__).resolve().parent
if str(ADMIN_DIR) not in sys.path:
    sys.path.insert(0, str(ADMIN_DIR))

from record_store import connect_readonly, resolve_db_path

SUMMARY_FIELDS = (
    ('status', 'Status'),
    ('verdict', 'Verdict'),
    ('title', 'Title'),
    ('effort', 'Effort'),
    ('message_length', 'Message length'),
    ('repo_url', 'Repo'),
    ('agent_id', 'Agent ID'),
    ('run_id', 'Run ID'),
    ('cursor_request_id', 'Cursor request ID'),
    ('github_issue_url', 'GitHub issue'),
    ('created_at', 'Created'),
    ('started_at', 'Started'),
    ('finished_at', 'Finished'),
    ('error', 'Error'),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Inspect a bugfixagent investigation timeline from SQLite.',
    )
    parser.add_argument('investigation_request_id', help='investigationRequestId UUID')
    parser.add_argument(
        '--db',
        help='SQLite path (default: RECORD_STORE_SQLITE_PATH or data/bugfixagent.db)',
    )
    parser.add_argument(
        '-v',
        '--verbose',
        action='store_true',
        help='print full event contents JSON',
    )
    parser.add_argument(
        '--show-prompts',
        action='store_true',
        help='print full agent.prompt_prepared prompt text',
    )
    return parser.parse_args()


def format_scalar(value: Any) -> str:
    if value is None:
        return '(null)'
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    text = str(value)
    return text if text else '(empty)'


def format_contents_lines(
    event: str,
    contents_json: str | None,
    *,
    verbose: bool,
    show_prompts: bool,
) -> list[str]:
    if not contents_json:
        return []

    try:
        data = json.loads(contents_json)
    except json.JSONDecodeError:
        return [f'  contents: {contents_json}']

    if not isinstance(data, dict) or verbose:
        rendered = json.dumps(data, indent=2, ensure_ascii=False)
        return textwrap.indent(rendered, '  ').splitlines()

    lines: list[str] = []
    for key, value in data.items():
        if key == 'prompt' and event == 'agent.prompt_prepared':
            prompt = str(value)
            if show_prompts:
                lines.append(f'  prompt ({len(prompt)} chars):')
                lines.extend(textwrap.indent(prompt, '    ').splitlines())
            else:
                preview = prompt.replace('\n', ' ')[:120]
                suffix = '…' if len(prompt) > 120 else ''
                lines.append(
                    f'  prompt: {preview}{suffix} ({len(prompt)} chars, use --show-prompts)',
                )
            continue

        rendered = format_scalar(value)
        if isinstance(value, str) and len(value) > 160:
            rendered = value[:160] + '…'
        lines.append(f'  {key}: {rendered}')

    return lines


def print_summary(row: Any) -> None:
    print(f'Investigation: {row["id"]}')
    print('-' * 72)
    for field, label in SUMMARY_FIELDS:
        value = row[field]
        if value is None or value == '':
            continue
        if field == 'error':
            print(f'{label}:')
            print(textwrap.indent(str(value), '  '))
            continue
        print(f'{label}: {value}')
    print()


def print_timeline(rows: list[Any], *, verbose: bool, show_prompts: bool) -> None:
    print('Timeline')
    print('-' * 72)
    if not rows:
        print('(no log events)')
        return

    for row in rows:
        ts = row['timestamp']
        level = row['level'].upper().ljust(5)
        event = row['event']
        message = row['message']
        print(f'{ts}  {level}  {event}')
        print(f'  message: {message}')
        for line in format_contents_lines(
            event,
            row['contents'],
            verbose=verbose,
            show_prompts=show_prompts,
        ):
            print(line)
        print()


def main() -> int:
    args = parse_args()
    investigation_id = args.investigation_request_id.strip()
    db_path = resolve_db_path(args.db)

    try:
        conn = connect_readonly(db_path)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    with conn:
        investigation = conn.execute(
            'SELECT * FROM investigations WHERE id = ?',
            (investigation_id,),
        ).fetchone()

        if investigation is None:
            print(
                f'investigation not found: {investigation_id} (db: {db_path})',
                file=sys.stderr,
            )
            return 1

        events = conn.execute(
            '''
            SELECT timestamp, level, event, message, contents
            FROM log_events
            WHERE investigation_id = ?
            ORDER BY timestamp ASC, id ASC
            ''',
            (investigation_id,),
        ).fetchall()

    print_summary(investigation)
    print_timeline(events, verbose=args.verbose, show_prompts=args.show_prompts)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
