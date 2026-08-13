/**
 * Runs the real Codex CLI in a pty and pushes its bytes through the light
 * theme surface filter, the way the CLI console does.
 */
import pty from "@lydell/node-pty";
import {
  TuiSurfaceFilter,
  retintDarkSurfaces,
} from "../../web/src/lib/tui-surface.js";

const ESC = String.fromCharCode(27);

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

const term = pty.spawn(process.env.COMSPEC || "cmd.exe", ["/c", "codex"], {
  name: "xterm-256color",
  cols: 120,
  rows: 30,
  cwd: process.cwd(),
  env: process.env,
});

const chunks: string[] = [];
term.onData((data) => chunks.push(data));

setTimeout(() => {
  term.kill();
  const raw = chunks.join("");

  const dark = new TuiSurfaceFilter();
  const light = new TuiSurfaceFilter();
  const asDark = chunks.map((c) => dark.push(c, false)).join("");
  const asLight = chunks.map((c) => light.push(c, true)).join("");

  check("codex painted a dark surface at all", raw.includes("48;2;41;41;41"));
  check("dark theme is byte-for-byte the program's own output", asDark === raw);
  check("the dark surface is gone in light theme", !asLight.includes("48;2;41;41;41"));
  check("it became a light one", asLight.includes("48;2;232;232;232"));

  // Colour carries meaning; only neutral surfaces are Atelier's to change.
  for (const accent of ["38;2;181;101;109", "38;2;165;188;145"]) {
    const before = raw.split(accent).length;
    check(`accent ${accent} is untouched`, asLight.split(accent).length === before);
  }

  // Chunk boundaries are the pty's business, not the filter's: splitting the
  // same bytes differently must not change a single one of them.
  const perByte = new TuiSurfaceFilter();
  const split = [...raw].map((ch) => perByte.push(ch, true)).join("");
  check("one byte at a time gives the same result", split === asLight);
  check("and so does the stateless pass", retintDarkSurfaces(raw) === asLight);

  // A half-arrived sequence is held, not mangled.
  const partial = new TuiSurfaceFilter();
  const head = partial.push(`x${ESC}[48;2;41`, true);
  check("an incomplete sequence is held back", head === "x");
  check(
    "and rewritten once it lands",
    partial.push(";41;41m", true) === `${ESC}[48;2;232;232;232m`
  );

  console.log(failures ? `\n${failures} failed` : "\nall good");
  process.exit(failures ? 1 : 0);
}, 13000);
