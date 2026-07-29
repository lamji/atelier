import { runCodexExec } from "../src/providers/codex/client.js";
import { EventBus } from "../src/events/event-bus.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { CodexToolBridge } from "../src/providers/codex/tool-bridge.js";

const cwd = process.argv[2] ?? process.cwd();
const telemetry = process.argv.includes("--telemetry");
const mcp = process.argv.includes("--mcp");
const image = process.argv.includes("--image");

/** A 96x96 solid-red PNG — the model can only name the color if it saw it. */
const RED_SQUARE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAAiklEQVR42u3QMQ0AAAjAsPk3DQ44" +
  "uZpUQZvioECQIEGCBAkSJAhBggQJEiRIkCAECRIkSJAgQYJQIEiQIEGCBAkShCBBggQJEiRIEIIE" +
  "CRIkSJAgQQgSJEiQIEGCBAlCkCBBggQJEiQIQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQg" +
  "QYIeLWwZ3g4lE9hgAAAAAElFTkSuQmCC";
const bus = telemetry ? new EventBus() : undefined;
const topics: string[] = [];
const tools: string[] = [];
bus?.subscribe((event) => {
  topics.push(event.topic);
  if (event.topic === "tool.started") {
    tools.push(String((event.payload as { name?: string }).name ?? ""));
  }
});
const registry = new ToolRegistry(bus ?? new EventBus());
registry.register("search_workspace", async () => ({
  matches: [{ path: "README.md", row: 1, preview: "OK" }],
  strategy: "smoke",
}));
const bridge = mcp ? new CodexToolBridge(registry) : undefined;
const bridgeSession = bridge
  ? await bridge.session("task_codex_smoke", new AbortController().signal)
  : undefined;

const text = await runCodexExec({
  cwd,
  prompt: mcp
    ? "You must call the Atelier MCP tool search_workspace exactly once with query OK before answering. If you cannot call that tool, reply with exactly NO_TOOL. After the tool call succeeds, reply with exactly OK."
    : image
      ? "An image is attached to this message. Reply with exactly the fill color of the attached square in uppercase (RED, BLUE, GREEN, ...). If no image reached you, reply with exactly NO_IMAGE."
      : telemetry
        ? "Run a shell command to print OK, then reply with exactly OK."
        : "Reply with exactly OK.",
  sandbox: "read-only",
  signal: new AbortController().signal,
  ...(image
    ? { images: [{ mediaType: "image/png", data: RED_SQUARE_PNG }] }
    : {}),
  ...(bridgeSession ? { toolBridge: bridgeSession } : {}),
  ...(bus
    ? {
        telemetry: {
          bus,
          taskId: "task_codex_smoke",
          conversationId: "conv_codex_smoke",
          messageId: "msg_codex_smoke",
        },
      }
    : {}),
});
bridgeSession?.dispose();
bridge?.stop();

console.log(text);
if (telemetry) console.log(`events=${topics.join(",")}`);
if (mcp) console.log(`tools=${tools.join(",")}`);
if (mcp && !tools.includes("search_workspace")) {
  throw new Error("Codex MCP smoke failed: search_workspace was not called");
}
if (image && !text.toUpperCase().includes("RED")) {
  throw new Error(`Codex image smoke failed: attachment never reached the model (${text})`);
}
