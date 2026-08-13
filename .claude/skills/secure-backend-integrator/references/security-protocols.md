# Security protocols: standards, hardening, and scale

These requirements sit on top of everything else in this skill. They apply
to EVERY work unit, in every environment mode. Security controls must
themselves be scalable: a limiter, queue, or check that fails under massive
traffic is a vulnerability, not a feature gap.

## Cybersecurity posture

- Zero trust (NIST SP 800-207): no implicit trust from network location,
  origin, or a previous request. Authenticate and authorize EVERY request
  at the server boundary, continuously — not once per session at the edge.
- Assume breach: design each layer as if the layer in front of it has
  already failed. Defense in depth over any single control.
- Default-deny: access is refused unless an explicit rule grants it; new
  routes, tables, buckets, and functions start closed.
- Least privilege: every credential, role, token, service account, and
  database grant carries the minimum scope that lets the unit work.
- Attacker-first review: before implementing, write the abuse cases —
  enumeration, IDOR, replay, flooding, mass assignment, injection, SSRF,
  privilege escalation — and make each one fail by design.

## Standards to enforce

- **OWASP API Security Top 10 (2023)** — gate every endpoint against all
  ten: API1 broken object-level authorization; API2 broken authentication;
  API3 broken object property-level authorization (excessive data exposure
  and mass assignment); API4 unrestricted resource consumption; API5 broken
  function-level authorization; API6 unrestricted access to sensitive
  business flows; API7 SSRF; API8 security misconfiguration; API9 improper
  inventory management; API10 unsafe consumption of third-party APIs.
- **OWASP ASVS 5.0** — use as the verification checklist for auth, session
  management, access control, validation, cryptography, and logging.
- **OWASP Cheat Sheet Series** — follow the topic sheet (REST security,
  authorization, input validation, logging, zero trust) when implementing.
- **Transport**: TLS 1.2+ (prefer 1.3) everywhere; HSTS for browser-facing
  hosts; secure/httpOnly/SameSite cookies; security headers (CSP,
  X-Content-Type-Options, frame-ancestors) where HTML is served.

The unit's `security-model.md` entry must state which Top-10 risks apply
and how each is mitigated. Unmitigated applicable risk = blocked unit.

## Rate limiting and abuse prevention (required, not optional)

Every exposed operation gets an explicit limit decision, recorded in the
manifest. "No limit needed" must be justified, never assumed.

- Layered limits: per-identity (user/API key) AND per-tenant AND per-IP,
  with a global ceiling. Identity-based limits are primary; IP limits are
  the anonymous fallback.
- Algorithm choice: token bucket at the entry point for burst-tolerant
  fairness; sliding-window counters for strict quotas; leaky-bucket or
  queue-based smoothing in front of expensive downstream work.
- Cost-aware limits: expensive operations (search, export, AI calls, bulk
  writes) consume more budget than cheap reads. Sensitive business flows
  (login, signup, checkout, password reset, OTP) get their own strict
  limits plus lockout/backoff — this is OWASP API6, not just capacity.
- Distributed enforcement: at more than one instance, counters live in a
  shared store (e.g. Redis) or at the gateway/edge — never only in
  per-process memory.
- Adaptive shedding: tighten limits on load signals (sustained CPU, error
  rate, queue depth, latency percentiles). Prefer degrading low-priority
  traffic before critical flows.
- Contract: reject with 429 plus Retry-After; document limits; never leak
  limiter internals. Clients get exponential backoff with jitter guidance.
- Request-size and complexity caps: max body size, max page size, max
  filter/sort combinations, max upload size and count, bounded query depth.

## Concurrency, backpressure, and massive-request resilience

- Bounded concurrency everywhere: connection pools, worker pools, and
  per-endpoint concurrent-request caps. Nothing unbounded — an unbounded
  queue or fan-out is a self-inflicted denial of service.
- Backpressure over buffering: when demand exceeds capacity, slow intake
  (429/503 + Retry-After) or shed low-priority load deliberately; do not
  buffer without bounds until memory dies.
- Queue-based load leveling for spiky or heavy work: durable queues with
  bounded depth, dead-letter queues, and consumers that process at a
  sustainable rate.
- Timeouts on EVERY network call, query, and lock acquisition; retries only
  with exponential backoff + jitter and only for idempotent operations.
- Circuit breakers around every external dependency: trip on error-rate or
  latency thresholds, fail fast while open, half-open probes to recover.
  Failure mode must be safe (deny) not open (allow).
- Idempotency keys for every retryable mutation and webhook/payment/job
  handler, with a dedupe window at least as long as the retry horizon.
  Replay of a captured request must not duplicate effects.
- Optimistic concurrency (versions/etags) where lost updates are possible;
  transactions and constraints in the database, not only in app code —
  data integrity must survive concurrent and hostile clients.
- Caching to absorb read load (CDN, Redis, HTTP caching) — but cache keys
  must include identity/tenant scope where responses differ by caller, and
  authorization is checked before serving anything private from cache.
  Never cache secrets or per-user data in shared caches unscoped.
- Graceful degradation and shutdown: drain in-flight work, reject new work
  early, recover cleanly after crashes. Health checks that reflect real
  readiness, not just process liveness.

## Verification additions

Beyond functional tests, each unit's verification must exercise:

- Rate-limit behavior: limit reached → 429 + Retry-After; limit resets;
  limits enforced per identity AND per tenant, not just per IP.
- Flood behavior: burst traffic is shed or queued — the service stays up
  and critical flows stay responsive.
- Replay: the same request or webhook delivered twice has one effect.
- Slow dependency: timeout fires, circuit opens, failure is denied-safe.
- Resource exhaustion attempts: oversized bodies, deep pagination, huge
  page sizes, and expensive filter combinations are rejected with 4xx.

Record the evidence (commands, tests, results) in the manifest before
marking the unit verified.
