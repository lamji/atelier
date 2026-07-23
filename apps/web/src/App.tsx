import { useEffect } from "react";
import { AppShell } from "@/views/shell/AppShell";
import { startEventDispatcher } from "@/services/event-dispatcher";

export function App() {
  useEffect(() => {
    startEventDispatcher();
  }, []);
  return <AppShell />;
}
