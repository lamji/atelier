import type { GitForge, GitForgeCredential } from "@atelier/protocol";

/**
 * How a forge account reads in a picker.
 *
 * Shared because two panes now choose between the same credentials — the
 * Requests list and the pull-request describe step — and an account that
 * is labelled one way in one place and another way in the other reads as
 * two different accounts.
 */

/** Sentinel for "let Atelier pick", which is not a credential id. */
export const AUTOMATIC_CREDENTIAL = "__automatic__";

export function credentialLabel(
  credential: GitForgeCredential,
  forge: GitForge | null
): string {
  const account = credential.login ? ` · @${credential.login}` : "";
  if (credential.source === "credential-helper") {
    return `Git credential${account}`;
  }
  if (credential.source === "env") return `Environment token${account}`;
  if (credential.source === "stored") return `Saved here${account}`;
  return `${forge === "gitlab" ? "glab" : "gh"} account${account}`;
}

export function credentialHint(credential: GitForgeCredential): string {
  if (credential.source === "credential-helper") {
    return "Returned by git credential for this repository";
  }
  if (credential.source === "env") {
    return "Token from this agent process environment";
  }
  if (credential.source === "stored") {
    return "Token you added in this pane — kept by Atelier";
  }
  return "Account already stored by the forge CLI";
}
