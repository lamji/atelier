import { useGitFlowViewModel } from "@/hooks/useGitFlowViewModel";
import { GitFlowModal } from "./GitFlowModal";

/**
 * Mounts the commit → push → PR wizard at the shell level so it can be
 * raised from anywhere — the git panel's Commit button, or the git-flow
 * hook when the agent's own commit/push/PR is blocked. Owning the flow
 * subscription here keeps streamed output from re-rendering the shell.
 */
export function GitFlowHost() {
  const vm = useGitFlowViewModel();
  return <GitFlowModal vm={vm} />;
}
