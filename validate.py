#!/usr/bin/env python3
"""
Validate the hand-edited config files (prompts.json, pings.json) before they
ship. Catches the easy mistakes — missing commas, stray quotes, trailing
commas — with the exact line/column, so a typo never silently breaks the app.

    python3 validate.py        # check, exit 1 on any error

Wired as a git pre-commit hook (see install-hook.sh) so a bad file can't be
committed in the first place.
"""

import json
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# (filename, required top-level type, per-item required keys)
CHECKS = [
    ("prompts.json", list, ["date", "id", "body"]),
    ("pings.json",   dict, None),
]


def validate(filename, top_type, item_keys):
    path = os.path.join(HERE, filename)
    if not os.path.exists(path):
        print(f"  ⚠ {filename}: not found (skipped)")
        return True

    with open(path) as f:
        raw = f.read()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        # e.lineno / e.colno point right at the problem
        line = raw.splitlines()[e.lineno - 1] if e.lineno <= len(raw.splitlines()) else ""
        print(f"  ✗ {filename}: JSON error at line {e.lineno}, column {e.colno}: {e.msg}")
        if line:
            print(f"      {line.strip()}")
        return False

    if not isinstance(data, top_type):
        print(f"  ✗ {filename}: expected a JSON {top_type.__name__} at the top level")
        return False

    # light shape check for prompts: each item needs the required keys
    if item_keys and isinstance(data, list):
        seen_dates, seen_ids = set(), set()
        for i, item in enumerate(data):
            if not isinstance(item, dict):
                print(f"  ✗ {filename}: item #{i + 1} is not an object")
                return False
            missing = [k for k in item_keys if k not in item]
            if missing:
                print(f"  ✗ {filename}: item #{i + 1} (date {item.get('date', '?')}) "
                      f"missing key(s): {', '.join(missing)}")
                return False
            if item.get("date") in seen_dates:
                print(f"  ✗ {filename}: duplicate date {item['date']}")
                return False
            if item.get("id") in seen_ids:
                print(f"  ✗ {filename}: duplicate id {item['id']}")
                return False
            seen_dates.add(item.get("date"))
            seen_ids.add(item.get("id"))

    print(f"  ✓ {filename} ({len(data)} {'items' if isinstance(data, list) else 'keys'})")
    return True


def main():
    print("Validating config files…")
    ok = all(validate(*c) for c in CHECKS)
    if ok:
        print("All good. ✅")
        return 0
    print("\nFix the error(s) above before committing/deploying. ❌")
    return 1


if __name__ == "__main__":
    sys.exit(main())
