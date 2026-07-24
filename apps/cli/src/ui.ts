/* Terminal output helpers — tiny, no dependencies. */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string, text: string): string =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

export const c = {
  bold: (t: string) => wrap("1", t),
  dim: (t: string) => wrap("2", t),
  cyan: (t: string) => wrap("36", t),
  green: (t: string) => wrap("32", t),
  yellow: (t: string) => wrap("33", t),
  red: (t: string) => wrap("31", t),
  magenta: (t: string) => wrap("35", t),
};

export function banner(): void {
  console.log(c.magenta(c.bold("\n  ▲ Atelier")) + c.dim("  — agentic engineering\n"));
}

export function step(text: string): void {
  console.log(`${c.cyan("›")} ${text}`);
}

export function ok(text: string): void {
  console.log(`${c.green("✓")} ${text}`);
}

export function warn(text: string): void {
  console.log(`${c.yellow("!")} ${text}`);
}

export function fail(text: string): void {
  console.log(`${c.red("✗")} ${text}`);
}

export function info(text: string): void {
  console.log(`  ${c.dim(text)}`);
}
