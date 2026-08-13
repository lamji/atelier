# Verification gates

## Per-unit verification (Phase 7)

Run the relevant subset for the selected work unit:

- Formatting
- Linting
- Type checking
- Unit tests
- Integration tests
- Authorization tests
- API contract tests
- Database tests
- Build
- Focused end-to-end tests

Test failure paths, not only successful requests: wrong identity, wrong
tenant, missing auth, malformed input, duplicate submission, rate-limit
exceeded, missing and forbidden records.

Also run the abuse and scale checks from `security-protocols.md`:
rate-limit behavior (429 + Retry-After, per-identity and per-tenant),
flood shedding, replay/idempotency, slow-dependency timeouts and
circuit-breaker denial, and resource-exhaustion rejections (oversized
bodies, huge page sizes, expensive filters).

## Completion criteria for one work unit

A work unit is complete ONLY when all of the following hold:

- The full flow is traced
- The API contract is explicit
- Applicable OWASP API Top 10 risks are mitigated and recorded
- Rate limiting, timeouts, and concurrency bounds exist where applicable
- Runtime validation exists
- Authentication is correct
- Authorization is server-enforced
- Tenant or ownership isolation is tested
- Persistence is correct
- Errors are mapped safely
- Loading, empty, success, and failure UI behavior works
- Security tests pass
- Relevant automated tests pass
- The build passes
- No secrets were introduced
- No unrelated behavior changed
- System knowledge is updated when supported
- The manifest contains verification evidence

If any required criterion is missing, mark the unit blocked or in
progress — never complete.

## Required output for implementation runs

1. Selected work unit
2. Evidence and traced flow
3. Security model
4. API contract
5. Files changed
6. Migration or policy changes
7. Tests and verification performed
8. Security findings resolved
9. Remaining risks or blockers
10. Integration queue progress
11. Recommended next work unit

End with:

```text
Stopped after one page or feature as required.
Invoke $secure-backend-integrator again to continue with the next queued work unit.
```
