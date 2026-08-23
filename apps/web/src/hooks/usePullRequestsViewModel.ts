import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitForge,
  GitForgeAuthSource,
  GitForgeStatus,
  GitPullRequest,
  MethodResult,
} from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { errorText } from "@/lib/error-text";
import { alert } from "@/state/alerts.store";
import { useConnectionStore } from "@/state/connection.store";
import { useGitStore } from "@/state/git.store";

/** How often the open request list is re-read from the forge CLI. */
const POLL_MS = 90_000;

export interface PullRequestsViewModel {
  requests: GitPullRequest[];
  forge: GitForge | null;
  /** False whenever `status` is anything but "ok". */
  available: boolean;
  reason?: string;
  /** Why the list looks the way it does — what the pane branches on. */
  status: GitForgeStatus;
  /** Which credential answered, for the status strip's dot. */
  source?: GitForgeAuthSource;
  /** "owner/name" on the forge. */
  repo?: string;
  /** Forge host, so a self-hosted GitLab names itself. */
  host?: string;
  /** Account the answering credential belongs to, when it named one. */
  login?: string;
  loading: boolean;
  /** True while the Connect button's re-probe is in flight. */
  connecting: boolean;
  /** Epoch ms of the last completed check, or null before the first one. */
  checkedAt: number | null;
  /** Numbers the user has not seen in the pane yet — the badge's dot. */
  unseen: Set<number>;
  refresh: () => void;
  /**
   * Drops every cached forge token and probes the credentials again —
   * what the pane's Connect button runs after the user signs in.
   */
  connect: () => void;
  /** Called when the pane is on screen: clears the unseen marks. */
  markSeen: () => void;
}

/**
 * The Requests pane's data: open pull requests (GitHub) or merge requests
 * (GitLab) for `origin`.
 *
 * It polls rather than waiting to be asked, because the question it answers
 * — "did someone open something while I was working?" — is only useful
 * unprompted. A request whose number was not in the previous answer is
 * remembered as unseen, so the tab can carry a dot and the user gets one
 * alert about it even while looking at another panel. The first load never
 * alerts: on a repo with nine open PRs, every one of them is "new" to a
 * freshly opened window and none of them is news.
 */
export function usePullRequestsViewModel(): PullRequestsViewModel {
  const connected = useConnectionStore((s) => s.state === "connected");
  // Re-checked when git state changes too: pushing a branch is the moment
  // a PR is most likely to appear, and it moves this version.
  const stateVersion = useGitStore((s) => s.stateVersion);

  const [requests, setRequests] = useState<GitPullRequest[]>([]);
  // Everything the answer says about itself moves together — forge, status
  // and credential are one fact, and splitting them across setStates is
  // how a pane ends up showing last round's reason beside this round's list.
  const [meta, setMeta] = useState<ListMeta>({
    forge: null,
    available: true,
    status: "ok",
  });
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [unseen, setUnseen] = useState<Set<number>>(() => new Set());
  const [nonce, setNonce] = useState(0);

  // Numbers from the previous successful check. A ref, not state: it feeds
  // the next comparison and must not itself trigger one.
  const known = useRef<Set<number> | null>(null);

  /**
   * One place where an answer becomes state, because two callers produce
   * one: the poll and the Connect button, which returns the same shape
   * precisely so the pane does not need a second way to read it.
   */
  const applyList = useCallback((res: MethodResult<"git.pullRequests">) => {
    setRequests(res.requests);
    setMeta({
      forge: res.forge,
      available: res.available,
      status: res.status,
      reason: res.reason,
      source: res.source,
      repo: res.repo,
      host: res.host,
      login: res.login,
    });
    setCheckedAt(Date.now());

    const numbers = new Set(res.requests.map((r) => r.number));
    const previous = known.current;
    known.current = numbers;
    // First successful check only establishes the baseline.
    if (!previous) return;
    const fresh = res.requests.filter((r) => !previous.has(r.number));
    if (fresh.length === 0) return;
    setUnseen((old) => {
      const next = new Set(old);
      for (const r of fresh) next.add(r.number);
      return next;
    });
    const word = res.forge === "gitlab" ? "merge request" : "pull request";
    const first = fresh[0];
    if (fresh.length === 1 && first) {
      alert.info(
        `New ${word} #${first.number}`,
        `${first.title.slice(0, 80)}${first.author ? ` · @${first.author}` : ""}`
      );
    } else {
      alert.info(`${fresh.length} new ${word}s`, "Open the Requests tab to review them.");
    }
  }, []);

  /** A transport failure is the pane's problem to show, not the agent's. */
  const applyFailure = useCallback((err: unknown) => {
    setMeta((old) => ({
      ...old,
      available: false,
      status: "error",
      reason: errorText(err).replace(/^Error:\s*/, "").slice(0, 160),
    }));
    setCheckedAt(Date.now());
  }, []);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let timer: number | undefined;

    const check = () => {
      setLoading(true);
      void bridge
        .rpc("git.pullRequests", {})
        .then((res) => {
          if (!cancelled) applyList(res);
        })
        .catch((err: unknown) => {
          // A poll that fails is reported in the pane, never as an alert:
          // it would otherwise fire on a loop for as long as it is broken.
          if (!cancelled) applyFailure(err);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    check();
    timer = window.setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [connected, stateVersion, nonce, applyList, applyFailure]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const connect = useCallback(() => {
    setConnecting(true);
    void bridge
      .rpc("git.forgeConnect", {})
      .then(applyList)
      .catch(applyFailure)
      .finally(() => setConnecting(false));
  }, [applyList, applyFailure]);

  const markSeen = useCallback(() => {
    setUnseen((old) => (old.size === 0 ? old : new Set()));
  }, []);

  return {
    requests,
    ...meta,
    loading,
    connecting,
    checkedAt,
    unseen,
    refresh,
    connect,
    markSeen,
  };
}

/** The self-description that travels with every answer. */
interface ListMeta {
  forge: GitForge | null;
  available: boolean;
  status: GitForgeStatus;
  reason?: string;
  source?: GitForgeAuthSource;
  repo?: string;
  host?: string;
  login?: string;
}
