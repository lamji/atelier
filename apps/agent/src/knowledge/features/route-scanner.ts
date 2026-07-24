export interface DiscoveredRoute {
  kind: "page" | "endpoint";
  /** HTTP method for endpoints (GET/POST/…); undefined for pages. */
  method?: string;
  /** URL path, e.g. "/dashboard" or "/api/site-maps/index". */
  path: string;
  /** File the route is declared in (or the page file itself). */
  file: string;
  line: number;
  /** Component/handler name referenced, when the pattern exposes one. */
  entry?: string;
}

interface SourceFile {
  path: string;
  content: string;
}

/** file globs we never treat as route sources. */
const SKIP = /(\.d\.ts$|\.spec\.|\.test\.|\.stories\.|node_modules)/;

/**
 * Framework-agnostic route & endpoint discovery by source patterns. It
 * covers the common shapes across a monorepo — React Router, Next/Nuxt
 * file-based pages, Angular route configs, Express/Nest/Fastify handlers,
 * and Go/gin/echo — so the feature scanner can anchor product features to
 * the URLs users actually hit. Heuristic, not a parser: it finds the
 * declarations, the LLM pass reads what's behind them.
 */
export function discoverRoutes(files: SourceFile[]): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  for (const file of files) {
    if (SKIP.test(file.path)) continue;
    out.push(...fileBasedPage(file.path));
    out.push(...scanContent(file));
  }
  return dedupe(out);
}

/**
 * Next.js / Nuxt file-based routing from the path itself. Only `pages/`
 * and `app/` — a backend `routes/` folder is NOT file-based pages, and
 * its endpoints are caught by the content patterns instead.
 */
function fileBasedPage(path: string): DiscoveredRoute[] {
  const m = path.match(
    /(?:^|\/)(?:pages|app)\/(.+?)\.(?:tsx?|jsx?|vue|svelte)$/
  );
  if (!m) return [];
  let rel = m[1]!;
  // Next app-router: only page.tsx / route.ts define a route.
  const isAppFile = /\/(page|route|index|layout)$/.test("/" + rel);
  rel = rel.replace(/\/(page|route|index|layout)$/, "");
  const isApi = /(^|\/)api(\/|$)/.test(rel);
  const url =
    "/" +
    rel
      .replace(/\[\.\.\..+?\]/g, "*")
      .replace(/\[(.+?)\]/g, ":$1")
      .replace(/\(.+?\)/g, "") // route groups
      .replace(/\/+/g, "/")
      .replace(/^\/|\/$/g, "");
  const clean = url === "/" ? "/" : url.replace(/\/$/, "");
  if (rel === "" && !isAppFile) return [];
  return [
    {
      kind: isApi ? "endpoint" : "page",
      path: clean || "/",
      file: path,
      line: 1,
    },
  ];
}

const PATTERNS: Array<{
  re: RegExp;
  build: (m: RegExpExecArray) => Omit<DiscoveredRoute, "file" | "line">;
}> = [
  // React Router: <Route path="/x" element={<Dashboard/>} />
  {
    re: /<Route\s+[^>]*path=["'`]([^"'`]+)["'`][^>]*?(?:element=\{<\s*(\w+)|component=\{?\s*(\w+))?/g,
    build: (m) => ({ kind: "page", path: m[1]!, entry: m[2] ?? m[3] }),
  },
  // Route config object: { path: "/x", component: Dashboard } (Angular/RR)
  {
    re: /\bpath:\s*["'`]([^"'`]*)["'`][^}]*?\bcomponent:\s*(\w+)/g,
    build: (m) => ({ kind: "page", path: normSlash(m[1]!), entry: m[2] }),
  },
  // Angular loadComponent/loadChildren lazy routes.
  {
    re: /\bpath:\s*["'`]([^"'`]*)["'`][^}]*?\bload(?:Component|Children):/g,
    build: (m) => ({ kind: "page", path: normSlash(m[1]!) }),
  },
  // Express/Fastify/Koa/gin/echo: app.get("/x"), router.post('/x')
  {
    re: /\b(?:app|router|r|e|api|server|route)\.(get|post|put|patch|delete|all|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    build: (m) => ({
      kind: "endpoint",
      method: m[1]!.toUpperCase(),
      path: m[2]!,
    }),
  },
  // Go net/http: mux.HandleFunc("/x", handler)
  {
    re: /\.Handle(?:Func)?\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\w+)?/g,
    build: (m) => ({ kind: "endpoint", path: m[1]!, entry: m[2] }),
  },
];

/** NestJS: @Controller('users') scoping @Get(':id') on methods. */
function scanNest(file: SourceFile): DiscoveredRoute[] {
  const ctrl = /@Controller\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/.exec(file.content);
  if (!ctrl) return [];
  const base = normSlash(ctrl[1] ?? "");
  const out: DiscoveredRoute[] = [];
  const re = /@(Get|Post|Put|Patch|Delete)\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file.content))) {
    const sub = m[2] ? normSlash(m[2]) : "";
    out.push({
      kind: "endpoint",
      method: m[1]!.toUpperCase(),
      path: join(base, sub),
      file: file.path,
      line: lineAt(file.content, m.index),
    });
  }
  return out;
}

function scanContent(file: SourceFile): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  for (const { re, build } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(file.content))) {
      const partial = build(m);
      if (!partial.path && partial.path !== "/") continue;
      out.push({
        ...partial,
        file: file.path,
        line: lineAt(file.content, m.index),
      });
    }
  }
  out.push(...scanNest(file));
  return out;
}

function normSlash(p: string): string {
  if (!p) return "/";
  return p.startsWith("/") ? p : "/" + p;
}

function join(base: string, sub: string): string {
  const b = base.replace(/\/$/, "");
  const s = sub.replace(/^\//, "");
  return s ? `${b}/${s}` : b || "/";
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function dedupe(routes: DiscoveredRoute[]): DiscoveredRoute[] {
  const seen = new Map<string, DiscoveredRoute>();
  for (const r of routes) {
    const key = `${r.kind}:${r.method ?? ""}:${r.path}`;
    // Prefer the entry-bearing declaration over a bare one.
    if (!seen.has(key) || (r.entry && !seen.get(key)!.entry)) {
      seen.set(key, r);
    }
  }
  return [...seen.values()];
}
