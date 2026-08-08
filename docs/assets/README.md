# Screenshots

Real captures of the running desktop app. They are used by the root
`README.md` and by the GitHub Pages landing page (`docs/index.html`).

**Do not hand-edit or replace these with mockups** — regenerate them:

```sh
node scripts/capture-ui.mjs
```

That script launches a second Electron instance against an isolated profile
(`.atelier-data/capture`, gitignored) so it never disturbs a dev stack you
already have open, drives it over Chromium's DevTools Protocol, and writes
every PNG below at 2× (3072×1632).

| File | Shot |
|------|------|
| `console-dark.png` | The console, dark theme — agents rail, chat, editor tabs, status bar |
| `console-light.png` | The same console, light theme |
| `explorer.png` | Explorer sidebar with the workspace tree |
| `editor.png` | Explorer beside the Monaco editor |
| `knowledge.png` | Knowledge panel — counts, graph, detected features |
| `git-flow.png` | Source control — changes, staging, the commit wizard's entry point |
| `hooks.png` | Hooks panel — the guards and what they match |
| `settings.png` | Settings → Providers |
| `icon.svg` | Brand mark, copied from `apps/web/public/icon.svg` (favicon for the landing page) |

The capture opens Atelier on **this repository**, so the shots show real file
names, real symbol counts and a real changed-file list. Check a fresh capture
for anything private before committing it.
