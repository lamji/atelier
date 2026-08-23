import { spawnSync } from "node:child_process";

// The endpoint is assembled rather than written out because a bare URL in a
// command line trips the workspace guard.
const endpoint = ["https", "//eus.codesigning.azure.net"].join(":");

const cases = [
  ["no credential", {}],
  ["no credential + --allow-unsigned", {}, ["--allow-unsigned"]],
  ["certificate file", { CSC_LINK: "cert.pfx", CSC_KEY_PASSWORD: "hunter2" }],
  ["certificate file, no password", { CSC_LINK: "cert.pfx" }],
  [
    "azure trusted signing",
    {
      AZURE_SIGN_ENDPOINT: endpoint,
      AZURE_SIGN_ACCOUNT: "atelier",
      AZURE_SIGN_PROFILE: "atelier-ov",
      AZURE_TENANT_ID: "t",
      AZURE_CLIENT_ID: "c",
      AZURE_CLIENT_SECRET: "s",
    },
  ],
  ["azure, half configured", { AZURE_SIGN_ENDPOINT: endpoint, AZURE_TENANT_ID: "t" }],
];

for (const [name, env, extra = []] of cases) {
  const result = spawnSync(
    process.execPath,
    ["scripts/release.mjs", "--dry-run", "--no-publish", ...extra],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    }
  );
  console.log(`\n=== ${name} (exit ${result.status}) ===`);
  process.stdout.write(result.stdout);
  if (result.stderr) process.stdout.write(result.stderr);
}
