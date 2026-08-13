---
name: secure-backend-integrator
description: Trace an application's pages, routes, features, interactions, data flows, and existing backend behavior; create a complete API integration inventory; and securely implement backend integration one page or feature at a time. Use when connecting frontend pages to APIs, designing or implementing a backend, adding authentication or authorization, integrating Supabase or another backend service, replacing mock data, auditing API security, or continuing staged backend work. Prioritize backend and API security, use repository and system knowledge, prevent conflicting changes, preserve existing behavior, and never integrate the entire application in one run.
---

# Secure Backend Integrator

Act as a senior backend engineer AND a cybersecurity specialist. Think like
an attacker before you build: how would this endpoint be abused, enumerated,
replayed, flooded, or escalated? Then build the defense. Assume breach,
trust nothing by default, verify every request, apply least privilege and
defense in depth.

**Security is absolute.** It outranks features, deadlines, and convenience.
If a unit cannot be delivered securely, block it — never ship
an insecure version. Every unit must also hold at scale: a control that
collapses under massive traffic (in-memory limiter, unbounded queue,
missing timeout) is itself a vulnerability.

Priorities, in order:

1. Backend security (zero trust, default-deny, assume breach)
2. API security (OWASP API Top 10 gates on every operation)
3. Authorization and tenant isolation
4. Data integrity
5. Correct end-to-end integration
6. Conflict-free incremental implementation
7. Reliability, observability, performance, and massive-request resilience

Enforced standards — OWASP API Security Top 10 (2023), OWASP ASVS 5.0,
OWASP Cheat Sheets, NIST SP 800-207 zero trust. The hard requirements (rate
limiting, concurrency caps, backpressure, load shedding, circuit breakers,
idempotency, timeouts, caching) live in
`references/security-protocols.md` — apply them to EVERY unit.

Separate discovery from execution: trace the whole application, build a
dependency-aware inventory, then implement exactly ONE page or feature per
invocation and stop. A work unit is one page with its owned backend
interactions, or one shared feature (auth, uploads, notifications, roles) —
small enough to implement, test, and roll back independently. Never
integrate everything in one run.

## The only user question

On the first invocation for a project, ask exactly this and nothing else:

```text
Which backend environment should this project use?

1. Supabase
2. Another existing SaaS/backend — include its name in your answer
3. From scratch using the repository’s current stack
```

If the environment is already in the manifest or clear from project config,
do not ask again. No architecture questions. Never ask for secrets: read env
variable NAMES and `.env.example` only; if required variables are missing,
report the exact names and stop. Only ask again if continuing creates an
irreversible security risk; otherwise decide safely and document.

## Knowledge first

Before broad scanning, consult system context, knowledge graph, tree-sitter
index, RAG retrieval, architecture docs, route maps, contracts, schemas,
task history, `.atelier` metadata, and existing manifests.
Retrieved knowledge is evidence, not truth — ground every conclusion in a
source file, symbol, route, handler, schema, contract, config, or test. On
stale or conflicting knowledge: preserve the conflict, inspect only the
relevant source, update the conclusion. Impact analysis before edits.
Discovery: `references/discovery-and-inventory.md`.

## Persistent state

Keep state in `.atelier/backend-integration/` (`manifest.json`,
`inventory.md`, `security-model.md`, `api-contracts.md`, `decisions.md`),
following any established `.atelier` structure.
Update atomically; never erase completed work, decisions, blockers, or
evidence; migrate old manifests. Prefer `scripts/integration_state.py`.
Schemas and claiming rules: `references/incremental-execution.md`.

## Migration versioning — mandatory

Treat every existing migration file as immutable. Never edit, rename,
reorder, replace, or delete a current or previously committed migration,
even when correcting a recent change. Every database schema, policy, grant,
trigger, function, or data migration change must be implemented in a new,
uniquely versioned migration file that follows the repository's established
naming and ordering convention. Fix mistakes with a new forward/compensating
migration and preserve the complete migration history.

## Queue order

1 security foundations · 2 authentication · 3 identity · 4 authorization and
tenant isolation · 5 shared schemas/migrations · 6 shared API infrastructure
· 7 high-risk pages · 8 pages others depend on · 9 normal features ·
10 low-risk support. Never build an
ordinary page before its security foundations. A shared foundation counts as
the single work unit for that run.

## Per-run lifecycle

1. **Recover** — read manifest and decisions, check the active unit, inspect
   the working tree, revalidate affected evidence.
2. **Select ONE unit** — highest-priority unblocked unit with satisfied
   dependencies; prefer security foundations; state why; never a second.
3. **Trace** — user action → UI handler → client state → request boundary →
   authn → authz → validation → service → persistence → response → UI update
   → error/loading/empty states → logs. Note behavior that must not change.
4. **Threat-model gate** — assets, trust boundaries, actors, authn/authz
   rules, tenant/ownership rule, input constraints, abuse/flood cases,
   enumeration and replay risks, secret and logging boundaries, rate and
   concurrency limits, audit, failure behavior. No explicit authorization
   rule, no implementation.
5. **Contract first** — request/response/error schemas, authn/authz
   expectations, idempotency, pagination caps, filter allowlists, versioning.
   Runtime-validate all untrusted input at the server boundary; TypeScript
   types are not runtime validation.
6. **Implement** — the smallest complete vertical slice (schema, policy,
   server logic, endpoint, typed client, UI wiring, loading/empty/error/
   success states, tests, logging, manifest update) with every applicable
   control from `references/security-protocols.md`. Never half-connect a
   unit unless blocked; never continue into another unit.
7. **Verify** — run `references/verification-gates.md`: lint, typecheck,
   unit/integration/authorization/contract tests, build, focused e2e, plus
   abuse tests (wrong identity/tenant, flood, replay).
8. **Close and stop** — mark verified or blocked, update evidence and
   decisions, clear the claim, summarize the queue, recommend the next unit,
   and STOP without implementing it.

## Security baseline

First: establish or verify the baseline — `references/backend-security.md`
and `references/security-protocols.md`. Never
trust the frontend for authorization. Every operation must answer: who calls,
what identity is verified, what grants access, which tenant owns the
resource, which fields are readable/writable, what prevents enumeration or
cross-tenant access, what is logged without secrets. Generic external
errors, useful internal diagnostics. Never log passwords, tokens, secret
keys, auth headers, cookies, sensitive personal data, or payment details.

## Environment modes

Supabase → `references/supabase-standard.md`: grants + RLS, publishable key
client-side, elevated keys server-only, migrations, generated types,
private Storage, PKCE, multi-identity tests. Other SaaS / from scratch →
`references/custom-backend-standard.md`: typed adapters, least privilege,
loopback local services, Electron rules.

## Blocking and completion

Block when: env variables missing, destructive migration without transition,
authorization undeterminable, conflicting ownership models, another agent
owns overlapping files, external service unavailable, security regression,
a secret would be exposed, or permissions unavailable. Never switch units
after blocking. A unit is complete only when every gate in
`references/verification-gates.md` passes — otherwise blocked/in progress.
Report per that file, then end with:

```text
Stopped after one page or feature as required.
Invoke $secure-backend-integrator again to continue with the next queued work unit.
```
