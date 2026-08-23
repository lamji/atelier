import path from "node:path";
import { createRequire } from "node:module";

// electron-builder's own config reader + schema validator, so the yml is
// judged by the tool that will consume it rather than by eye.
const lib = path.resolve(
  "node_modules/.pnpm/app-builder-lib@25.1.8_dmg-_1bb375569cbd8d6bc505988dd6df2f0f/node_modules/app-builder-lib/package.json"
);
const req = createRequire(lib);
const { getConfig, validateConfiguration } = req("./out/util/config/config.js");

const debugLogger = { isEnabled: false, add: () => {} };
const projectDir = path.resolve("apps/desktop");

const config = await getConfig(projectDir, "electron-builder.yml", null);
console.log("win.signtoolOptions:", JSON.stringify(config.win?.signtoolOptions));
await validateConfiguration(config, debugLogger);
console.log("config: valid");

// What `-c.win.azureSignOptions.*` merges into, i.e. the config a signed
// release actually builds with.
const azure = {
  ...config,
  win: {
    ...config.win,
    azureSignOptions: {
      endpoint: ["https", "//eus.codesigning.azure.net"].join(":"),
      codeSigningAccountName: "atelier",
      certificateProfileName: "atelier-ov",
    },
  },
};
await validateConfiguration(azure, debugLogger);
console.log("config + azureSignOptions: valid");

// Prove the validator is actually strict, otherwise "valid" means nothing.
try {
  await validateConfiguration(
    { ...config, win: { ...config.win, signtoolOptionz: { nope: true } } },
    debugLogger
  );
  console.log("strictness: NOT STRICT — a typo passed");
} catch (error) {
  console.log("strictness: rejects a typo —", String(error.message).split("\n")[0]);
}
