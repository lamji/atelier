// Copies the app skills next to the agent bundle. Shared by the dev bundle
// (bundle-electron.mjs) and the packaged one (desktop build-backend.mjs), so
// an installed app ships exactly the skills a dev build has.
//
//   <out>/skills/<name>/SKILL.md                     Atelier's own chat
//   <out>/cli-skills/.claude/skills/<name>/SKILL.md  the provider CLIs
//   <out>/cli-skills/hooks/                          their SessionStart hook
//
// The second tree is the shape Claude Code expects under `--add-dir`. Both
// live inside the app, so uninstalling Atelier removes them: nothing is
// written to ~/.claude or ~/.codex.
import fs from "node:fs";
import path from "node:path";

/** App skills that are also offered inside the Claude and Codex CLIs. */
const CLI_SKILLS = [
  "atelier-init-feature",
  "atelier-impact-check",
  "atelier-re-init-feature",
  "atelier-remember",
];

export function copySkills(agentRoot, outDir) {
  const source = path.join(agentRoot, "skills");
  const copy = (from, to) => {
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, force: true });
  };
  copy(source, path.join(outDir, "skills"));
  const cliRoot = path.join(outDir, "cli-skills");
  fs.rmSync(cliRoot, { recursive: true, force: true });
  for (const name of CLI_SKILLS) {
    copy(
      path.join(source, name),
      path.join(cliRoot, ".claude", "skills", name),
    );
  }
  copy(path.join(agentRoot, "cli-hooks"), path.join(cliRoot, "hooks"));
}
