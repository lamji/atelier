# Discovery and inventory

The first project run must inventory the entire application before
implementing ordinary page integrations. Discovery may create planning and
manifest files, but it must not implement multiple application features. If
security foundation work is immediately necessary, discovery may select it as
the single active work unit — the one-unit limit still applies.

## Knowledge sources first

Before broad source scanning, inspect every available knowledge source:

- System Agent context
- Project knowledge graph
- Tree-sitter index
- RAG or hybrid retrieval results
- Linked project knowledge
- Architecture documentation
- Route maps and dependency graphs
- Existing API contracts and database schemas
- Impact-analysis results and task history
- `.atelier` project metadata
- Existing backend integration manifest

Treat retrieved knowledge as evidence, not unquestionable truth. Ground every
important conclusion in one or more of: source file, symbol, route definition,
existing handler, schema or migration, API contract, configuration file, test,
or verified system-knowledge record.

If system knowledge is stale, contradictory, or incomplete:

1. Preserve the conflict explicitly (record it in `decisions.md`).
2. Inspect only the relevant missing or stale source areas.
3. Update the conclusion using current source evidence.
4. Do not rescan the entire repository unnecessarily.

## What to trace

- Application entry points, layouts, and shells
- Routes and nested routes
- Public, protected, admin, and settings pages
- Modals and drawers with independent workflows
- Tabs with separate data flows
- Background processes
- Authentication flows and onboarding
- Search, pagination, filtering, and sorting
- File uploads and downloads
- Realtime features and notifications
- Billing, webhooks, and scheduled jobs
- Import and export
- Desktop IPC boundaries and local services
- External integrations

## Interactive elements to inspect per page or feature

Buttons, forms, inputs, selectors, tables, cards with actions, context menus,
search boxes, filters, pagination controls, drag-and-drop actions, upload and
download controls, bulk actions, destructive actions, navigation actions,
background refresh, optimistic updates, and realtime subscriptions.

## Map every relevant interaction to

- UI component and route
- Current event handler and state management
- Existing API call, mock data, local persistence, or IPC operation
- Expected input and output
- Authentication and authorization requirement
- Data entity
- Validation requirement
- Error, loading, and empty behavior
- Audit requirement
- Security risk
- Integration status

## Splitting rules

Do not assume a visible page equals one integration unit — split large pages
by coherent features when necessary. Do not invent backend requirements that
are unsupported by the product flow.

## Discovery output

1. Selected backend environment
2. Detected architecture and stack
3. Security baseline summary
4. Complete page and feature inventory (written to `inventory.md`)
5. API integration matrix
6. Dependency-aware work queue (written to `manifest.json`)
7. Highest-risk findings
8. Selected first work unit
9. What will be implemented in the next execution
10. Manifest location
