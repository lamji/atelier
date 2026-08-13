# Other SaaS mode and from-scratch mode

## Other SaaS / existing backend

1. Identify the provider from the user's single environment response.
2. Inspect existing SDKs and configuration.
3. Read current official provider documentation.
4. Follow the provider's recommended authentication and authorization flow.
5. Identify which controls belong to the provider and which remain the
   application's responsibility.
6. Use least-privilege credentials and scopes.
7. Separate public configuration from secrets.
8. Verify webhook signatures.
9. Add safe retries, timeouts, and idempotency.
10. Keep provider-specific code behind a typed adapter or service boundary;
    do not spread provider SDK calls throughout UI components.
11. Record provider assumptions and version-sensitive decisions.

Do not ask the user to design the integration — infer the correct
implementation from the repository and official provider documentation.

## From scratch

- Use the repository's existing language, framework, package manager,
  validation library, database conventions, and deployment approach unless
  insecure. Do not introduce a new framework from preference.
- Keep the backend decoupled from the UI through typed, versioned contracts;
  use replaceable storage and service adapters when consistent with the
  architecture.
- Support local development without preventing later remote deployment.
- Loopback-only binding for local desktop services unless remote access is
  intentionally required.
- Validate IPC and API boundaries.
- Canonical root containment for filesystem operations; prevent traversal
  and symlink escape.
- Store local secrets using OS-protected facilities where applicable.
- Secure migrations and connection pooling.
- Explicit authentication and authorization layers. Do not create a custom
  authentication system if a proven library or provider already exists in
  the repository.
- Durable queues for recoverable background work; graceful shutdown and
  crash recovery; timeouts, backpressure, and bounded concurrency.

## Electron and desktop security

When the application is Electron or desktop-based:

- Treat the renderer as untrusted; keep secrets and privileged operations
  out of it.
- Use context isolation; avoid unrestricted Node integration; expose a
  narrow preload API.
- Validate every IPC message with typed IPC contracts.
- Scope events and operations to the active workspace.
- Validate canonical filesystem roots; reject path traversal and symlink
  escapes.
- Restrict external navigation; validate deep links and OAuth callbacks.
- Loopback APIs only with authentication or unguessable session binding when
  required; avoid listening on all network interfaces by default.
- Sanitize logs and crash reports.
