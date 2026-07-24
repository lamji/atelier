import fs from "node:fs";
import path from "node:path";
import { install } from "./install.js";
import { run } from "./run.js";
import { runDoctor } from "./doctor.js";
import { installRoot } from "./paths.js";
import { banner, c, info } from "./ui.js";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command, flags };
}

function helpText(): string {
  return `${c.bold("atelier")} — local-first agentic engineering

${c.bold("Usage:")}
  atelier install [--repo <url>] [--ref <branch>] [--no-global] [--skip-doctor]
  atelier run [--port <n>] [--no-open]
  atelier doctor
  atelier version

${c.bold("Commands:")}
  ${c.cyan("install")}   Build Atelier, install prerequisites, register the command
  ${c.cyan("run")}       Launch the agent in the current project and open the UI
  ${c.cyan("doctor")}    Check prerequisites (node, git, gh, claude)
  ${c.cyan("version")}   Show the installed version
`;
}

function showVersion(): void {
  const file = path.join(installRoot(), "version.json");
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as { version: string };
    console.log(`atelier ${v.version}`);
  } catch {
    console.log("atelier (not installed)");
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "install":
      await install({
        repo: typeof flags.repo === "string" ? flags.repo : undefined,
        ref: typeof flags.ref === "string" ? flags.ref : undefined,
        skipDoctor: flags["skip-doctor"] === true,
        noGlobal: flags["no-global"] === true,
      });
      break;
    case "run":
      await run({
        port:
          typeof flags.port === "string" ? Number(flags.port) : undefined,
        noOpen: flags["no-open"] === true,
      });
      break;
    case "doctor":
      banner();
      await runDoctor(false);
      break;
    case "version":
    case "--version":
    case "-v":
      showVersion();
      break;
    default:
      banner();
      console.log(helpText());
      info("Run `atelier install` to get started.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
