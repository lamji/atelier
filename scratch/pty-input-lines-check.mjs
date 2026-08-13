// Throwaway check of the pty line reconstruction used to name CLI sessions.
// Run: node scratch/pty-input-lines-check.mjs
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const src = readFileSync("apps/web/src/lib/pty-input-lines.ts", "utf8")
  .replace(/: string\[\]|: string|: number|: boolean/g, "")
  .replace(/private /g, "")
  .replace(/\]!/g, "]")
  .replace(/export class/, "class");
const tmp = "scratch/.pty-input-lines.mjs";
writeFileSync(tmp, `${src}\nexport { PtyInputLines };\n`);
const { PtyInputLines } = await import(`./${".pty-input-lines.mjs"}`);
unlinkSync(tmp);

const cases = [
  { name: "typed prompt", input: ["f", "i", "x", " ", "t", "h", "e", "\r"], want: ["fix the"] },
  { name: "backspace", input: ["a", "b", "\x7f", "c", "\r"], want: ["ac"] },
  { name: "arrow keys ignored", input: ["h", "\x1b[A", "\x1b[D", "i", "\r"], want: ["hi"] },
  { name: "ctrl+c clears", input: ["o", "l", "d", "\x03", "n", "e", "w", "\r"], want: ["new"] },
  { name: "split escape", input: ["a", "\x1b[", "A", "b", "\r"], want: ["ab"] },
  {
    name: "bracketed paste keeps newlines as spaces",
    input: ["\x1b[200~one\r\ntwo\x1b[201~", "\r"],
    want: ["one two"],
  },
  { name: "empty enter yields nothing", input: ["\r", "\r"], want: [] },
  { name: "two prompts", input: ["one\r", "two\r"], want: ["one", "two"] },
];

let failed = 0;
for (const c of cases) {
  const reader = new PtyInputLines();
  const got = c.input.flatMap((chunk) => reader.push(chunk));
  const ok = JSON.stringify(got) === JSON.stringify(c.want);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name} -> ${JSON.stringify(got)}`);
}
process.exit(failed ? 1 : 0);
