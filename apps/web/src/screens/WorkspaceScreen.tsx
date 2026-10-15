import { AppShell } from "@/views/shell/AppShell";

/**
 * The IDE itself. Mounted once the workspace's agent is connected; until
 * then App shows ConnectingScreen with the open's progress. The chunk is
 * still warmed early, so it is parsed by the time the agent answers.
 *
 * A later disconnect (the agent dying) keeps it mounted: anything that acts
 * on the agent is gated on `vm.connected`, and the status bar and alerts
 * carry the connection state.
 */
export default function WorkspaceScreen() {
  return <AppShell />;
}
