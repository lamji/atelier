import type { ImpactRadius } from "@atelier/protocol";

/**
 * Renders the pre-edit blast radius into the execute prompt: the callers,
 * flows, and tests that must stay consistent with the change. This is what
 * turns "fixed the file" into "fixed the file and re-aligned everything
 * that rides on it" — the class of miss PR review keeps catching.
 */
export function buildImpactContext(radius: ImpactRadius): string {
  if (
    radius.affected.length === 0 &&
    radius.flows.length === 0 &&
    radius.testsAtRisk.length === 0
  ) {
    return "";
  }

  const lines: string[] = [
    "",
    `IMPACT RADIUS (${radius.level.toUpperCase()} regression risk) — before ` +
      "you edit the targets, know what rides on them and keep it aligned:",
  ];

  if (radius.affected.length > 0) {
    lines.push(
      "Callers / importers that will see this change (nearest first — " +
        "update the ones your edit breaks):"
    );
    for (const node of radius.affected.slice(0, 12)) {
      const where = node.symbol ? ` ${node.symbol}` : "";
      lines.push(`- [d${node.depth} ${node.via}]${where} @ ${node.path}`);
    }
  }
  if (radius.flows.length > 0) {
    lines.push(
      "Downstream flows on these files — verify each still works end to end:",
      ...radius.flows
        .slice(0, 8)
        .map((f) => `- ${f.kind}: ${f.name}${f.path ? ` @ ${f.path}` : ""}`)
    );
  }
  if (radius.testsAtRisk.length > 0) {
    lines.push(
      "Tests that exercise this reach — keep them green (update them only " +
        "if the contract truly changed):",
      ...radius.testsAtRisk.slice(0, 8).map((t) => `- ${t}`)
    );
  }
  if (radius.risks.length > 0) {
    lines.push(
      "Past lessons anchored here — do not repeat these:",
      ...radius.risks.slice(0, 3).map((r) => `- ${r.title}: ${r.body}`)
    );
  }
  return lines.join("\n");
}
