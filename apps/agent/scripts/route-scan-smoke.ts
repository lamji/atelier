/**
 * Route discovery smoke: pages + endpoints across frameworks, no bogus
 * matches from backend folders.
 *
 *   pnpm --filter @atelier/agent smoke:route-scan
 */
import { discoverRoutes } from "../src/knowledge/features/route-scanner.js";

const files = [
  { path: "apps/web/src/routes.tsx", content: '<Route path="/dashboard" element={<Dashboard/>} />\n<Route path="/login" element={<LoginPage/>} />' },
  { path: "apps/web/pages/dashboard.tsx", content: "export default function D(){}" },
  { path: "apps/web/app/settings/page.tsx", content: "export default function S(){}" },
  { path: "apps/web/pages/api/site-maps/index.ts", content: "export default handler" },
  { path: "apps/backend/routes/user.ts", content: "router.get('/api/users/:id', getUser)\nrouter.post('/api/users', createUser)" },
  { path: "apps/backend/main.go", content: 'mux.HandleFunc("/health", healthHandler)' },
  { path: "apps/api/users.controller.ts", content: "@Controller('users')\nclass C { @Get(':id') find(){} @Post() create(){} }" },
  { path: "apps/web/src/Button.spec.tsx", content: '<Route path="/should-be-skipped" />' },
];

const routes = discoverRoutes(files);
const has = (kind: string, method: string, path: string) =>
  routes.some(
    (r) => r.kind === kind && (r.method ?? "") === method && r.path === path
  );

let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

check("React Router page /dashboard", has("page", "", "/dashboard"));
check("React Router page /login", has("page", "", "/login"));
check("Next app-router page /settings", has("page", "", "/settings"));
check("Next api endpoint /api/site-maps", has("endpoint", "", "/api/site-maps"));
check("Express GET /api/users/:id", has("endpoint", "GET", "/api/users/:id"));
check("Express POST /api/users", has("endpoint", "POST", "/api/users"));
check("Go endpoint /health", has("endpoint", "", "/health"));
check("Nest GET /users/:id", has("endpoint", "GET", "/users/:id"));
check("Nest POST /users", has("endpoint", "POST", "/users"));
check(
  "no bogus page from backend routes/ folder",
  !has("page", "", "/user"),
  routes.filter((r) => r.path === "/user").map((r) => r.file).join(",")
);
check(
  "spec files are skipped",
  !routes.some((r) => r.path === "/should-be-skipped")
);

console.log(fail === 0 ? "\nall route-scan cases pass" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
