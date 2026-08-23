import { spawnSync } from "node:child_process";

/**
 * Who signs the Windows installer, and proof that they actually did.
 *
 * SmartScreen does not ask whether the bytes match a published hash — it
 * asks who signed the code. An unsigned installer therefore greets every
 * downloader with "Windows protected your PC", which is why a release that
 * is not signed is a broken release rather than a lesser one.
 *
 * electron-builder signs when the ENVIRONMENT carries a credential and
 * silently does not when it does not, so nothing in the build fails when
 * signing quietly stops happening. This module is the missing half: it
 * decides up front which credential is present (before the twelve-minute
 * build), and afterwards asks Windows itself whether the file that came out
 * really carries a valid Authenticode signature.
 */

/**
 * Azure Trusted Signing authenticates through Entra ID, which reads these
 * three from the environment. They are the same names Azure's own SDKs use;
 * electron-builder does not read them itself, it just shells out to
 * `Invoke-TrustedSigning`, which does.
 */
const AZURE_CREDENTIAL_VARS = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
];

/**
 * @typedef {object} Signing
 * @property {"azure" | "certificate" | "none"} mode
 * @property {string} label            one line for the console
 * @property {string[]} builderArgs    extra electron-builder arguments
 * @property {string[]} problems       fatal gaps in an otherwise-chosen mode
 * @property {string[]} warnings       worth saying, not worth stopping for
 */

/**
 * Which signing credential this machine has, and what the build needs to be
 * told about it.
 *
 * Two shapes are supported, in the order a release should prefer them:
 *
 *  - **Azure Trusted Signing** (or any cloud/HSM signer reachable through
 *    it). Since June 2023 a public CA will not hand out a key file for a
 *    code-signing certificate at all, so this is the only kind of signing a
 *    fresh certificate can do — and the only kind an unattended
 *    `npm run release` can drive.
 *  - **A certificate file** in `CSC_LINK` / `WIN_CSC_LINK` (a .pfx path, or
 *    the base64 of one). electron-builder picks this up on its own; nothing
 *    has to be passed to it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Signing}
 */
export function resolveSigning(env = process.env) {
  const problems = [];
  const warnings = [];

  const endpoint = env.AZURE_SIGN_ENDPOINT?.trim();
  const account = env.AZURE_SIGN_ACCOUNT?.trim();
  const profile = env.AZURE_SIGN_PROFILE?.trim();

  // The endpoint is what makes this a Trusted Signing setup rather than a
  // machine that happens to have Azure credentials lying around for some
  // unrelated service, so it alone selects the mode. Anything else missing
  // is then a misconfiguration, not a different mode.
  if (endpoint) {
    if (!account) problems.push("AZURE_SIGN_ACCOUNT is not set (the Trusted Signing account name)");
    if (!profile) problems.push("AZURE_SIGN_PROFILE is not set (the certificate profile name)");
    for (const name of AZURE_CREDENTIAL_VARS) {
      if (!env[name]) problems.push(`${name} is not set (Entra ID service principal)`);
    }
    return {
      mode: "azure",
      label: `Azure Trusted Signing (${account || "?"}/${profile || "?"})`,
      builderArgs: [
        `-c.win.azureSignOptions.endpoint=${endpoint}`,
        `-c.win.azureSignOptions.codeSigningAccountName=${account ?? ""}`,
        `-c.win.azureSignOptions.certificateProfileName=${profile ?? ""}`,
      ],
      problems,
      warnings,
    };
  }

  const certificate = env.CSC_LINK || env.WIN_CSC_LINK;
  if (certificate) {
    if (!env.CSC_KEY_PASSWORD && !env.WIN_CSC_KEY_PASSWORD) {
      warnings.push(
        "CSC_KEY_PASSWORD is not set — the build will fail if the .pfx has one"
      );
    }
    // The value is a path or a base64 blob; either way it is a secret's
    // address, so only its shape is ever printed.
    const shape = certificate.includes("\n") || certificate.length > 260 ? "base64" : certificate;
    return {
      mode: "certificate",
      label: `certificate file (${shape})`,
      builderArgs: [],
      problems,
      warnings,
    };
  }

  return {
    mode: "none",
    label: "no signing credential in the environment",
    builderArgs: [],
    problems,
    warnings,
  };
}

/**
 * @typedef {object} SignatureCheck
 * @property {boolean} checked   false when this platform cannot be asked
 * @property {boolean} valid     Windows trusts the signature on this file
 * @property {string} status     Get-AuthenticodeSignature's own verdict
 * @property {string} message    its explanation of that verdict
 * @property {string} subject    the certificate subject, when signed
 * @property {boolean} timestamped  countersigned, so it outlives the cert
 */

/**
 * What Windows says about the signature on a file.
 *
 * Asked of Windows rather than inferred from the environment on purpose:
 * "CSC_LINK was set" is not the same claim as "this exe is signed", and the
 * gap between them is exactly the bug that ships a SmartScreen warning to
 * everyone who downloads it.
 *
 * @param {string} file
 * @returns {SignatureCheck}
 */
export function verifySignature(file) {
  const unchecked = {
    checked: false,
    valid: false,
    status: "unchecked",
    message: `signatures can only be verified on Windows (this is ${process.platform})`,
    subject: "",
    timestamped: false,
  };
  if (process.platform !== "win32") return unchecked;

  const literal = file.replace(/'/g, "''");
  const script =
    "$ErrorActionPreference='Stop'; " +
    `$s = Get-AuthenticodeSignature -LiteralPath '${literal}'; ` +
    "[pscustomobject]@{" +
    "status=[string]$s.Status; " +
    "message=[string]$s.StatusMessage; " +
    "subject=[string]$s.SignerCertificate.Subject; " +
    "timestamped=[bool]$s.TimeStamperCertificate" +
    "} | ConvertTo-Json -Compress";

  const probe = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" }
  );
  if (probe.status !== 0 || !probe.stdout?.trim()) {
    return {
      ...unchecked,
      message:
        (probe.stderr || "").trim() ||
        `powershell exited ${probe.status} without a verdict`,
    };
  }

  try {
    const parsed = JSON.parse(probe.stdout);
    return {
      checked: true,
      valid: parsed.status === "Valid",
      status: parsed.status || "unknown",
      message: parsed.message || "",
      subject: parsed.subject || "",
      timestamped: Boolean(parsed.timestamped),
    };
  } catch {
    return { ...unchecked, message: `unreadable verdict: ${probe.stdout.trim()}` };
  }
}
