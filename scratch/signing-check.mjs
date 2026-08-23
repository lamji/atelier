import path from "node:path";
import { resolveSigning, verifySignature } from "../apps/desktop/scripts/signing.mjs";

const azureEnv = {
  AZURE_SIGN_ENDPOINT: ["https", "//eus.codesigning.azure.net"].join(":"),
  AZURE_SIGN_ACCOUNT: "atelier",
  AZURE_SIGN_PROFILE: "atelier-ov",
  AZURE_TENANT_ID: "t",
  AZURE_CLIENT_ID: "c",
  AZURE_CLIENT_SECRET: "s",
};

console.log("none:", JSON.stringify(resolveSigning({})));
console.log("cert:", JSON.stringify(resolveSigning({ CSC_LINK: "cert.pfx" })));
console.log(
  "cert+pw warnings:",
  JSON.stringify(resolveSigning({ WIN_CSC_LINK: "cert.pfx", WIN_CSC_KEY_PASSWORD: "x" }).warnings)
);
console.log("azure:", JSON.stringify(resolveSigning(azureEnv)));
console.log(
  "azure missing bits:",
  JSON.stringify(resolveSigning({ AZURE_SIGN_ENDPOINT: azureEnv.AZURE_SIGN_ENDPOINT }).problems)
);

const signed = path.join(process.env.SystemRoot ?? "C:\\Windows", "system32", "notepad.exe");
console.log("signed exe:", JSON.stringify(verifySignature(signed)));
console.log("unsigned file:", JSON.stringify(verifySignature("README.md")));
