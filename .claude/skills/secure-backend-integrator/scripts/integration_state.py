#!/usr/bin/env python3
"""Safe manager for the backend-integration manifest.

Initializes, validates, reads, claims, updates, and summarizes
`.atelier/backend-integration/manifest.json` without overwriting unrelated
data. Every write is atomic (temp file + replace) and merges into the
existing manifest — completed work, decisions, blockers, and evidence are
never erased.

Usage:
  integration_state.py init      [--root DIR]
  integration_state.py validate  [--root DIR]
  integration_state.py summary   [--root DIR]
  integration_state.py add-unit  [--root DIR]   (unit JSON on stdin)
  integration_state.py claim ID  [--root DIR]
  integration_state.py release ID --status STATUS [--note TEXT] [--root DIR]
  integration_state.py set-env TYPE [--provider NAME] [--root DIR]
"""

from __future__ import annotations

import argparse
import copy
import datetime
import json
import os
import sys
import tempfile

MANIFEST_DIR = os.path.join(".atelier", "backend-integration")
MANIFEST_NAME = "manifest.json"

ENV_TYPES = ("supabase", "existing-saas", "custom")
DISCOVERY_STATUSES = ("not_started", "in_progress", "complete", "stale")
BASELINE_STATUSES = ("pending", "passed", "blocked")
UNIT_STATUSES = (
    "queued", "claimed", "in_progress", "blocked", "verified", "complete",
)
UNIT_TYPES = ("page", "feature", "shared-foundation")
RISKS = ("critical", "high", "medium", "low")

UNIT_LIST_FIELDS = (
    "dependencies", "dependents", "ownedFiles", "sharedFiles",
    "dataEntities", "apiOperations", "authRequirements",
    "acceptanceCriteria", "evidence", "verification", "notes",
)

APPEND_ONLY_FIELDS = (
    "completedWorkUnits", "blockedWorkUnits", "decisions", "unknowns",
)


def empty_manifest() -> dict:
    return {
        "version": 1,
        "environment": {
            "type": None,
            "provider": None,
            "detectedStack": [],
            "configuredAt": None,
        },
        "discovery": {
            "status": "not_started",
            "lastScannedAt": None,
            "evidence": [],
        },
        "securityBaseline": {"status": "pending", "findings": []},
        "workUnits": [],
        "activeWorkUnit": None,
        "completedWorkUnits": [],
        "blockedWorkUnits": [],
        "decisions": [],
        "unknowns": [],
    }


def manifest_path(root: str) -> str:
    return os.path.join(root, MANIFEST_DIR, MANIFEST_NAME)


def now() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
    )


def load(root: str) -> dict:
    path = manifest_path(root)
    if not os.path.exists(path):
        fail(f"manifest not found at {path} — run `init` first")
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as err:
        fail(f"could not read manifest: {err}")
    if not isinstance(data, dict):
        fail("manifest root must be a JSON object")
    return data


def save(root: str, before: dict, after: dict) -> None:
    """Atomic write, refusing any update that drops append-only history."""
    for field in APPEND_ONLY_FIELDS:
        old = before.get(field) or []
        new = after.get(field) or []
        if isinstance(old, list) and len(new) < len(old):
            fail(f"refusing to shrink append-only field '{field}'")
    path = manifest_path(root)
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".manifest-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(after, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, path)
    except OSError as err:
        if os.path.exists(tmp):
            os.remove(tmp)
        fail(f"could not write manifest: {err}")


def migrate(data: dict) -> dict:
    """Fill missing keys from the schema without touching existing values."""
    merged = empty_manifest()
    for key, value in merged.items():
        current = data.get(key)
        if isinstance(value, dict) and isinstance(current, dict):
            merged[key] = {**value, **current}
        elif current is not None or key in data:
            merged[key] = current
    return merged


def validate(data: dict) -> list[str]:
    errors: list[str] = []

    def expect(cond: bool, message: str) -> None:
        if not cond:
            errors.append(message)

    env = data.get("environment") or {}
    env_type = env.get("type")
    expect(
        env_type is None or env_type in ENV_TYPES,
        f"environment.type must be null or one of {ENV_TYPES}",
    )
    disc = data.get("discovery") or {}
    expect(
        disc.get("status") in DISCOVERY_STATUSES,
        f"discovery.status must be one of {DISCOVERY_STATUSES}",
    )
    base = data.get("securityBaseline") or {}
    expect(
        base.get("status") in BASELINE_STATUSES,
        f"securityBaseline.status must be one of {BASELINE_STATUSES}",
    )
    for field in APPEND_ONLY_FIELDS + ("workUnits",):
        expect(isinstance(data.get(field), list), f"{field} must be a list")

    units = data.get("workUnits") or []
    seen: set[str] = set()
    for index, unit in enumerate(units):
        where = f"workUnits[{index}]"
        if not isinstance(unit, dict):
            errors.append(f"{where} must be an object")
            continue
        uid = unit.get("id")
        expect(bool(uid) and isinstance(uid, str), f"{where}.id required")
        if uid in seen:
            errors.append(f"duplicate work unit id '{uid}'")
        if isinstance(uid, str):
            seen.add(uid)
        expect(
            unit.get("status") in UNIT_STATUSES,
            f"{where}.status must be one of {UNIT_STATUSES}",
        )
        expect(
            unit.get("type") in UNIT_TYPES,
            f"{where}.type must be one of {UNIT_TYPES}",
        )
        risk = unit.get("securityRisk")
        expect(
            risk is None or risk in RISKS,
            f"{where}.securityRisk must be one of {RISKS}",
        )
        for field in UNIT_LIST_FIELDS:
            value = unit.get(field, [])
            expect(isinstance(value, list), f"{where}.{field} must be a list")
    for unit in units:
        for dep in unit.get("dependencies") or []:
            expect(dep in seen, f"unknown dependency '{dep}'")

    active = data.get("activeWorkUnit")
    expect(
        active is None or active in seen,
        f"activeWorkUnit '{active}' is not a known work unit",
    )
    return errors


def find_unit(data: dict, unit_id: str) -> dict:
    for unit in data.get("workUnits") or []:
        if unit.get("id") == unit_id:
            return unit
    fail(f"unknown work unit '{unit_id}'")
    raise AssertionError  # unreachable


def deps_satisfied(data: dict, unit: dict) -> list[str]:
    done = {"verified", "complete"}
    by_id = {u.get("id"): u for u in data.get("workUnits") or []}
    return [
        dep
        for dep in unit.get("dependencies") or []
        if (by_id.get(dep) or {}).get("status") not in done
    ]


def cmd_init(root: str) -> None:
    path = manifest_path(root)
    if os.path.exists(path):
        data = migrate(load(root))
        errors = validate(data)
        if errors:
            for message in errors:
                print(f"  - {message}")
            fail("existing manifest is invalid; fix it before continuing")
        save(root, data, data)
        print(f"manifest already present and valid: {path}")
        return
    fresh = empty_manifest()
    save(root, fresh, fresh)
    print(f"initialized {path}")


def cmd_validate(root: str) -> None:
    errors = validate(load(root))
    if errors:
        for message in errors:
            print(f"  - {message}")
        fail(f"{len(errors)} validation error(s)")
    print("manifest is valid")


def cmd_summary(root: str) -> None:
    data = load(root)
    units = data.get("workUnits") or []
    counts: dict[str, int] = {}
    for unit in units:
        status = str(unit.get("status"))
        counts[status] = counts.get(status, 0) + 1
    env = data.get("environment") or {}
    print(f"environment: {env.get('type') or 'not chosen'}")
    print(f"discovery:   {(data.get('discovery') or {}).get('status')}")
    print(f"baseline:    {(data.get('securityBaseline') or {}).get('status')}")
    print(f"active unit: {data.get('activeWorkUnit') or 'none'}")
    print(f"work units:  {len(units)} " + json.dumps(counts))
    ready = [
        unit
        for unit in units
        if unit.get("status") == "queued" and not deps_satisfied(data, unit)
    ]
    ready.sort(key=lambda unit: unit.get("priority") or 0)
    if ready:
        head = ready[0]
        print(f"next up:     {head.get('id')} — {head.get('title')}")


def cmd_add_unit(root: str) -> None:
    try:
        unit = json.load(sys.stdin)
    except json.JSONDecodeError as err:
        fail(f"stdin must be one work-unit JSON object: {err}")
    if not isinstance(unit, dict) or not unit.get("id"):
        fail("work unit must be an object with an 'id'")
    data = load(root)
    before = copy.deepcopy(data)
    if any(u.get("id") == unit["id"] for u in data.get("workUnits") or []):
        fail(f"work unit '{unit['id']}' already exists")
    unit.setdefault("status", "queued")
    unit.setdefault("type", "feature")
    for field in UNIT_LIST_FIELDS:
        unit.setdefault(field, [])
    data.setdefault("workUnits", []).append(unit)
    errors = validate(data)
    if errors:
        fail("unit rejected: " + "; ".join(errors))
    save(root, before, data)
    print(f"added work unit '{unit['id']}'")


def cmd_claim(root: str, unit_id: str) -> None:
    data = load(root)
    before = copy.deepcopy(data)
    active = data.get("activeWorkUnit")
    if active and active != unit_id:
        fail(f"another unit is already active: '{active}'")
    unit = find_unit(data, unit_id)
    if unit.get("status") not in ("queued", "claimed", "in_progress"):
        fail(f"unit '{unit_id}' is {unit.get('status')}, not claimable")
    missing = deps_satisfied(data, unit)
    if missing:
        fail(f"unit '{unit_id}' has unmet dependencies: {missing}")
    unit["status"] = "claimed"
    data["activeWorkUnit"] = unit_id
    save(root, before, data)
    print(f"claimed '{unit_id}'")


def cmd_release(root: str, unit_id: str, status: str, note: str | None) -> None:
    if status not in UNIT_STATUSES:
        fail(f"status must be one of {UNIT_STATUSES}")
    data = load(root)
    before = copy.deepcopy(data)
    unit = find_unit(data, unit_id)
    unit["status"] = status
    if note:
        unit.setdefault("notes", []).append({"at": now(), "note": note})
    if data.get("activeWorkUnit") == unit_id:
        data["activeWorkUnit"] = None
    if status in ("verified", "complete"):
        done = data.setdefault("completedWorkUnits", [])
        if unit_id not in done:
            done.append(unit_id)
    if status == "blocked":
        blocked = data.setdefault("blockedWorkUnits", [])
        if unit_id not in blocked:
            blocked.append(unit_id)
    save(root, before, data)
    print(f"released '{unit_id}' as {status}")


def cmd_set_env(root: str, env_type: str, provider: str | None) -> None:
    if env_type not in ENV_TYPES:
        fail(f"type must be one of {ENV_TYPES}")
    data = load(root)
    before = copy.deepcopy(data)
    env = data.setdefault("environment", {})
    already = env.get("type")
    if already and already != env_type:
        fail(
            f"environment already set to '{already}'; refusing to overwrite "
            "— record a decision and edit deliberately if this must change"
        )
    env["type"] = env_type
    env["provider"] = provider
    env.setdefault("detectedStack", [])
    env["configuredAt"] = env.get("configuredAt") or now()
    save(root, before, data)
    print(f"environment set to {env_type}" + (f" ({provider})" if provider else ""))


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="project root directory")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init")
    sub.add_parser("validate")
    sub.add_parser("summary")
    sub.add_parser("add-unit")
    claim = sub.add_parser("claim")
    claim.add_argument("id")
    release = sub.add_parser("release")
    release.add_argument("id")
    release.add_argument("--status", required=True)
    release.add_argument("--note")
    set_env = sub.add_parser("set-env")
    set_env.add_argument("type")
    set_env.add_argument("--provider")
    args = parser.parse_args()

    root = args.root
    if args.command == "init":
        cmd_init(root)
    elif args.command == "validate":
        cmd_validate(root)
    elif args.command == "summary":
        cmd_summary(root)
    elif args.command == "add-unit":
        cmd_add_unit(root)
    elif args.command == "claim":
        cmd_claim(root, args.id)
    elif args.command == "release":
        cmd_release(root, args.id, args.status, args.note)
    elif args.command == "set-env":
        cmd_set_env(root, args.type, args.provider)


if __name__ == "__main__":
    main()
