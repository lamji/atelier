# Incremental execution: state, claiming, conflicts

## Manifest layout

Store project-specific integration state under `.atelier/backend-integration/`:

```text
.atelier/backend-integration/
├── manifest.json
├── inventory.md
├── security-model.md
├── api-contracts.md
└── decisions.md
```

If `.atelier` already has an established structure for generated knowledge,
tasks, or implementation state, follow that structure instead of duplicating
it.

## Manifest schema

```json
{
  "version": 1,
  "environment": {
    "type": "supabase | existing-saas | custom",
    "provider": null,
    "detectedStack": [],
    "configuredAt": null
  },
  "discovery": {
    "status": "not_started | in_progress | complete | stale",
    "lastScannedAt": null,
    "evidence": []
  },
  "securityBaseline": {
    "status": "pending | passed | blocked",
    "findings": []
  },
  "workUnits": [],
  "activeWorkUnit": null,
  "completedWorkUnits": [],
  "blockedWorkUnits": [],
  "decisions": [],
  "unknowns": []
}
```

Each work unit:

```json
{
  "id": "stable-id",
  "title": "Human-readable title",
  "type": "page | feature | shared-foundation",
  "route": null,
  "status": "queued | claimed | in_progress | blocked | verified | complete",
  "priority": 0,
  "securityRisk": "critical | high | medium | low",
  "dependencies": [],
  "dependents": [],
  "ownedFiles": [],
  "sharedFiles": [],
  "dataEntities": [],
  "apiOperations": [],
  "authRequirements": [],
  "acceptanceCriteria": [],
  "evidence": [],
  "verification": [],
  "notes": []
}
```

Rules: update atomically (write a temp file, then replace); never erase
completed work, decisions, blockers, or evidence; migrate an old manifest
safely instead of replacing it. Prefer `scripts/integration_state.py` for all
manifest operations when Python is available.

## One-work-unit execution lock

Before implementation:

1. Check whether another work unit is already marked active.
2. Check for dirty or uncommitted files that overlap the proposed work.
3. Run impact analysis.
4. Resolve the work unit's dependency status.
5. Claim exactly one work unit.
6. Record the claim before editing.

Never edit two unrelated pages in one invocation. Never silently take over a
work unit claimed by another agent or session. Never overwrite user changes.

If another agent owns overlapping files: do not implement, mark the unit
blocked, record the conflict, report the blocker.

## Conflict avoidance

Before editing:

- Inspect the working tree and identify files changed by the user or another
  agent; compare with the selected unit's owned and shared files.
- Preserve unrelated changes; do not revert or overwrite changes you did not
  create.
- Avoid broad formatting or mechanical rewrites.
- Avoid changing shared contracts without tracing dependents.
- Avoid schema changes that silently break completed pages; keep migrations
  additive when practical; use compatibility transitions for breaking API
  changes.
- Do not refactor unrelated modules during integration. If a shared file must
  change, make the smallest compatible change and verify its dependents.
- Update one contract and all consumers inside the selected work unit only
  when required for completeness. Changes across several dependent files are
  allowed only when they belong to the same vertical slice.

## After the unit

Mark the unit verified or blocked, update evidence and decisions, update
system knowledge when supported, clear the active claim, show the remaining
queue summary, recommend the next unit, and stop without implementing it.
