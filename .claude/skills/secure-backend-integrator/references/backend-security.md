# Backend and API security baseline

The skill's first responsibility is to establish or verify this baseline.
Read `security-protocols.md` together with this file: it carries the
enforced standards (OWASP API Security Top 10 2023, OWASP ASVS 5.0, NIST
SP 800-207 zero trust) and the hard rate-limiting, concurrency,
backpressure, and resilience requirements that apply to every unit.

## Review checklist

- Authentication boundaries
- Authorization on every operation (object-level and function-level)
- Tenant and workspace isolation; default-deny behavior
- Input validation and output filtering
- Mass-assignment protection
- SQL, command, and template injection
- Path traversal and symlink escape
- Server-side request forgery
- Cross-site scripting boundaries; CSRF where applicable
- CORS allowlists
- Secure cookie configuration; session rotation and expiration
- Token verification
- Secret storage; secret leakage into bundles and logs
- Rate limiting and abuse prevention
- Idempotency and replay protection
- Webhook signature verification
- File type and size validation; storage authorization
- Encryption in transit; sensitive-field encryption where required
- Error information leakage
- Audit logging
- Dependency vulnerabilities
- Secure defaults
- Data retention and deletion
- Backup and migration safety

## Authorization questions every backend operation must answer

```text
Who is calling?
What identity is verified?
What role or ownership grants access?
Which tenant or workspace owns the resource?
Which fields may this actor read?
Which fields may this actor modify?
What prevents enumeration or cross-tenant access?
What is logged without exposing secrets?
```

Never rely on the frontend to enforce authorization.

## Logging and errors

Use generic external errors and useful internal diagnostics. Use structured,
sanitized logging with request or correlation IDs. Never log:

- Passwords
- Session, refresh, or access tokens
- Secret keys
- Authorization headers
- Full cookies
- Sensitive personal data
- Raw payment details

## API design rules

Follow the repository's existing protocol and style unless unsafe. Require:

- Versioned contracts when the project already uses versioning
- Consistent resource naming
- Runtime input validation (do not trust TypeScript types at runtime)
- Stable error codes and appropriate HTTP status codes
- Pagination for unbounded collections, with maximum page sizes
- Allowlisted filtering and sorting
- Request-size limits, timeouts, and cancellation where supported
- Idempotency for retryable mutations
- Optimistic concurrency when lost updates are possible
- Safe retry behavior
- Request correlation and sanitized observability
- No sensitive implementation details in responses

Avoid exposing database tables directly unless the chosen backend's security
model intentionally supports it and authorization is fully enforced.
