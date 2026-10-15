import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { linkCodexSkills } from "./codex-skill-links.js";

function skillAt(root: string, name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return { name, file: path.join(dir, "SKILL.md") };
}

test("app skills are linked into Codex's skills folder, never copied", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-codex-"));
  try {
    const oldApp = path.join(tmp, "old-app");
    const app = path.join(tmp, "app");
    const home = path.join(tmp, "codex-home");
    // The user's own skill that happens to share a name: not ours to touch.
    fs.mkdirSync(path.join(home, "skills", "atelier-impact-check"), {
      recursive: true,
    });
    linkCodexSkills([skillAt(oldApp, "atelier-init-feature")], home);

    // An app update moves the skills: the link follows them.
    const skills = [
      skillAt(app, "atelier-init-feature"),
      skillAt(app, "atelier-impact-check"),
    ];
    linkCodexSkills(skills, home);

    const link = path.join(home, "skills", "atelier-init-feature");
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(
      fs.realpathSync(link).toLowerCase(),
      fs.realpathSync(path.join(app, "atelier-init-feature")).toLowerCase()
    );
    assert.match(
      fs.readFileSync(path.join(link, "SKILL.md"), "utf8"),
      /name: atelier-init-feature/
    );
    const own = path.join(home, "skills", "atelier-impact-check");
    assert.ok(!fs.lstatSync(own).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(own), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
