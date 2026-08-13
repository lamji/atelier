# Supabase mode

Follow current official Supabase documentation and the repository's
framework-specific integration patterns. Use Supabase end to end instead of
combining unrelated ad hoc authentication, database, storage, and API
patterns without justification.

## Source of truth (inspect before implementation)

1. Installed Supabase packages and versions
2. `supabase/config.toml`
3. Migrations
4. Generated database types
5. Authentication setup
6. Existing browser, server, desktop, and admin clients
7. RLS policies and grants
8. Storage policies
9. Edge Functions
10. Current official Supabase documentation for version-sensitive behavior

Prefer repository migrations and source-controlled configuration over manual
dashboard-only changes.

## Keys and secrets

- Use a publishable key in public browser, mobile, or desktop clients.
- Authorization depends on JWT identity, grants, and RLS — not secrecy of the
  publishable key.
- Use secret or legacy `service_role` credentials only inside trusted backend
  components. They bypass RLS.
- Never expose elevated keys in browser bundles, desktop renderers, mobile
  bundles, URLs, logs, or client-readable environment variables.
- Do not use an elevated client for normal user operations; create separate
  server-only clients where elevated access is genuinely required, and
  perform explicit authorization before every elevated operation.
- Store secrets using the deployment platform's secret manager or
  OS-protected storage. Never commit real environment values. Maintain
  `.env.example` with names only.

## Authorization (grants + RLS)

For every exposed table, view, function, Storage bucket, and Realtime path:

- Determine whether exposure is necessary.
- Apply least-privilege Postgres grants AND enable RLS with explicit
  policies; prefer default-deny.
- Test policies using multiple identities; verify ownership and workspace
  membership; prevent cross-user and cross-workspace access.
- Never treat a UI role check as authorization.
- Keep internal tables and helper functions in non-exposed schemas when
  practical; consider a dedicated API schema to keep the exposed surface
  auditable.
- Review every `SECURITY DEFINER` function: safe `search_path`, minimal
  privileges, revoke unnecessary execution grants. Do not assume RLS applies
  to database functions.

## Authentication

Use the framework-appropriate official Supabase client.

SSR applications: current supported SSR package, PKCE flow, official cookie
adapter, correct auth callback, validate the user or claims on protected
server boundaries, do not trust only client state, avoid duplicate or
competing Supabase clients.

Desktop applications: keep elevated keys out of the renderer and application
package; secure PKCE/OAuth redirect handling; validated IPC or loopback API
contracts; store refresh/session secrets in OS-protected credential storage
when required; validate callback origins and state; prevent arbitrary
navigation or callback interception.

## Migrations and types

- Every schema, policy, grant, trigger, and function change goes through
  version-controlled migrations. Never rewrite deployed migrations — create
  a new one.
- Keep migrations deterministic and reviewable; include rollback guidance
  when destructive operations are unavoidable.
- Regenerate database types after schema changes and use them in clients and
  server code.
- Test migrations against a clean local database when supported. Seed only
  non-sensitive development data.

## Storage

- Object operations through the Storage API; private buckets by default with
  explicit Storage RLS policies.
- Validate bucket, owner, path prefix, MIME type, extension, and size.
- Signed URLs only after authorization, short-lived and appropriate to the
  operation.
- Prevent path manipulation and cross-tenant object access. Do not manipulate
  Storage metadata tables directly.

## Edge Functions and server operations

- Validate authentication, authorization, and request bodies inside the
  function.
- Restrict CORS to required origins; rate-limit abuse-sensitive functions.
- Verify webhook signatures using the raw request body.
- Keep secrets in Supabase or deployment secret storage.
- Timeouts and safe retries for external services; idempotency for payment,
  webhook, and job operations.
- Do not return stack traces or provider secrets.

## Verification matrix (test as applicable)

Anonymous user · authenticated owner · authenticated non-owner · member of
the correct workspace · member of another workspace · privileged role ·
disabled or removed member · expired session · missing JWT · malformed
request · duplicate request · rate-limit exceeded · missing record ·
forbidden record · Storage path manipulation.

Run the Supabase Security Advisor or equivalent automated checks when access
is available, but never treat automated checks as a replacement for manual
policy testing.
