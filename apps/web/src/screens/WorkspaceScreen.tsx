// Monaco is bundled with THIS chunk, not the app entry: the workspace is
// lazy-loaded, so login and the picker never pay for the editor.
import "@/lib/monaco-setup";
import { AppShell } from "@/views/shell/AppShell";

/**
 * The IDE itself. Mounted as soon as a workspace is selected — deliberately
 * BEFORE its agent has finished forking, so the app opens onto the workbench
 * instead of a "Starting the agent…" spinner.
 *
 * That means the view-model hooks do see a half-connected state: reads queue
 * inside BridgeClient until the port lands, and anything that acts on the
 * agent is gated on `vm.connected`, so controls arrive disabled and light up
 * when the port does. The status bar carries the connection state.
 */
export default function WorkspaceScreen() {
  return <AppShell />;
}
