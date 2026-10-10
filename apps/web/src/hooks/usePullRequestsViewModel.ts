import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitForge,
  GitForgeAuthSource,
  GitForgeCredential,
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
  /** API credentials found in gh/glab, env and git's credential helper. */
  credentials: GitForgeCredential[];
  /** Explicit picker choice; undefined means try credentials automatically. */
  credentialId?: string;
  /** "owner/name" on the forge. */
  repo?: string;
  /** Forge host, so a self-hosted GitLab names itself. */
  host?: string;
  /** Account the answering credential belongs to, when it named one. */
  login?: string;
  loading: boolean;
  /** True while the Connect button's re-probe is in flight. */
  connecting: boolean;
  /**
   * Adds a forge account from a pasted token. Resolves with what the agent
   * made of it — including which account the forge said it belongs to, so
   * the panel can confirm rather than assume.
   */
  addAccount: (token: string) => Promise<{
    ok: boolean;
    login?: string;
    persisted: boolean;
    reason?: string;
  }>;
  /** Epoch ms of the last completed check, or null before the first one. */
  checkedAt: number | null;
  /** Numbers the user has not seen in the pane yet — the badge's dot. */
  unseen: Set<number>;
  refresh: () => void;
  /** Select one machine credential, or undefined to restore automatic choice. */
  selectCredential: (credentialId?: string) => void;
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
  // Local file edits do not change remote PRs. Refresh on branch/repo
  // changes, explicit PR nudges, focus, and the existing polling interval.
  const branch = useGitStore((s) => s.live?.branch ?? s.status?.branch);
  // The checkout this list belongs to. Its own signal, because a repo
  // switch must clear the pane, while a mere stateVersion bump (a file
  // changed) must not.
  const activeRepo = useGitStore((s) => s.activeRepo);

  const [requests, setRequests] = useState<GitPullRequest[]>([]);
  // Everything the answer says about itself moves together — forge, status
  // and credential are one fact, and splitting them across setStates is
  // how a pane ends up showing last round's reason beside this round's list.
  const [meta, setMeta] = useState<ListMeta>({
    forge: null,
    available: true,
    status: "ok",
    credentials: [],
  });
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [unseen, setUnseen] = useState<Set<number>>(() => new Set());
  const [nonce, setNonce] = useState(0);
  const [credentialId, setCredentialId] = useState<string>();

  // Numbers from the previous successful check. A ref, not state: it feeds
  // the next comparison and must not itself trigger one.
  const known = useRef<Set<number> | null>(null);
  const pendingPoll = useRef<Promise<MethodResult<"git.pullRequests">> | null>(null);

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
      credentials: res.credentials,
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

  /**
   * Drop the previous checkout's answer the moment the panel moves.
   *
   * This list is remote and slow: switching repository left the strip
   * naming `dftech-dev/ai-doc-forge` and its credential while the panel
   * header already said `finops-crystal-lens`, for as long as the GitHub
   * round trip took. Showing one repository's pull requests under another
   * repository's name is worse than showing nothing, so nothing is what it
   * shows until the new answer lands.
   *
   * The baseline goes with it. `known` feeds the "new pull request" alert,
   * and carrying it across repositories would announce every request in the
   * repo just opened as newly arrived.
   */
  useEffect(() => {
    setRequests([]);
    setMeta({
      forge: null,
      available: true,
      status: "ok",
      credentials: [],
    });
    setUnseen(new Set());
    setCheckedAt(null);
    known.current = null;
    // An explicit credential belongs to the repository it was chosen for.
    setCredentialId(undefined);
  }, [activeRepo]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let timer: number | undefined;
    let checking = false;

    const check = async () => {
      if (cancelled || checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        // An old effect may still have an RPC running after a repo switch.
        // Wait for it before starting the current request, then recheck scope.
        await pendingPoll.current?.catch(() => undefined);
        if (cancelled || document.visibilityState !== "visible") return;
        setLoading(true);
        const request = bridge.rpc("git.pullRequests", credentialId ? { credentialId } : {});
        pendingPoll.current = request;
        const res = await request;
        if (!cancelled) applyList(res);
      } catch (err) {
        if (!cancelled) applyFailure(err);
      } finally {
        checking = false;
        if (!cancelled) setLoading(false);
      }
    };

    check();
    timer = window.setInterval(check, POLL_MS);
    // Coming back to the window is the moment a stale list is most visible
    // and most likely to be wrong — someone opened a request while you were
    // in the browser reviewing it. Cheaper than polling harder, and it is
    // what makes the pane feel live rather than on a ninety-second tick.
    const onFocus = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [
    connected,
    branch,
    activeRepo,
    nonce,
    credentialId,
    applyList,
    applyFailure,
  ]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // A request this app just opened is the one case where a single re-check
  // is not enough: the forge acknowledges the create call a beat before its
  // list includes the new request. Check now, then twice more as it lands,
  // so the pane shows the request without a click on refresh.
  const requestsNudge = useGitStore((s) => s.requestsNudge);
  useEffect(() => {
    if (requestsNudge === 0) return;
    const timers = [0, 4_000, 15_000].map((ms) =>
      window.setTimeout(() => setNonce((n) => n + 1), ms)
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [requestsNudge]);

  const connect = useCallback(() => {
    setConnecting(true);
    void bridge
      .rpc(
        "git.forgeConnect",
        credentialId ? { credentialId } : {}
      )
      .then(applyList)
      .catch(applyFailure)
      .finally(() => setConnecting(false));
  }, [credentialId, applyList, applyFailure]);

  const selectCredential = useCallback((next?: string) => {
    setCredentialId(next);
  }, []);

  /**
   * Adds a second forge account from a pasted token.
   *
   * The panel could previously only tell the user to leave the app and run
   * `gh auth login` — a context switch, an interactive prompt sequence, and
   * a sentence that reads like a command someone will paste wrong. Two
   * accounts on one machine is a normal setup; adding the second one
   * belongs here.
   *
   * On success the list is re-read immediately, so the account that can
   * actually see this repository takes over without another click.
   */
  const addAccount = useCallback(
    async (token: string) => {
      setConnecting(true);
      try {
        const result = await bridge.rpc("git.addForgeAccount", { token });
        if (result.ok) {
          // Automatic again: the new credential is the one the SSH
          // identity matches, and a stale explicit pick would hide it.
          setCredentialId(undefined);
          setNonce((n) => n + 1);
        }
        return result;
      } catch (error) {
        return {
          ok: false,
          persisted: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        setConnecting(false);
      }
    },
    []
  );

  // A process restart or repository switch can invalidate an opaque id.
  // Fall back to Automatic as soon as a fresh scan no longer contains it.
  useEffect(() => {
    if (
      credentialId &&
      checkedAt !== null &&
      !meta.credentials.some((credential) => credential.id === credentialId)
    ) {
      setCredentialId(undefined);
    }
  }, [credentialId, checkedAt, meta.credentials]);

  const markSeen = useCallback(() => {
    setUnseen((old) => (old.size === 0 ? old : new Set()));
  }, []);

  return {
    requests,
    ...meta,
    loading,
    connecting,
    addAccount,
    checkedAt,
    unseen,
    credentialId,
    refresh,
    selectCredential,
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
  credentials: GitForgeCredential[];
  repo?: string;
  host?: string;
  login?: string;
}
