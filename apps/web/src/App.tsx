import { useEffect } from "react";
import { AppShell } from "@/views/shell/AppShell";
import { startEventDispatcher } from "@/services/event-dispatcher";
import { startHub } from "@/services/project-switch";

export function App() {
  useEffect(() => {
    // Wire the bridge dispatcher first (subscriptions only, no connect),
    // then connect the hub which selects a project and drives the bridge.
    startEventDispatcher();
    startHub();
  }, []);
  return <AppShell />;
}
