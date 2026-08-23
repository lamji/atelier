import { useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  ExternalLink,
  Github,
  Gitlab,
  GitPullRequestArrow,
  Loader2,
  LogIn,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { GitPullRequest } from "@atelier/protocol";
import type { PullRequestsViewModel } from "@/hooks/usePullRequestsViewModel";

export interface RequestsPanelProps {
  vm: PullRequestsViewModel;
  /** Branch of the current checkout — its own request is pinned on top. */
  branch?: string;
}

/**
 * Open pull requests (GitHub) / merge requests (GitLab) for this checkout.
 *
 * The pane exists because the answer arrives while you are looking at
 * something else: the list is polled, and anything that appeared since the
 * last check keeps a "new" mark until this pane has actually been on
 * screen. The request for the branch you are standing on sorts first — it
 * is the one you are here about — and a row opens the request in the
 * browser, which is where reviewing actually happens.
 */
export function RequestsPanel({ vm, branch }: RequestsPanelProps) {
  const [query, setQuery] = useState("");

  // Being rendered IS having seen them; the tab's dot clears on arrival.
  useEffect(() => {
    vm.markSeen();
  }, [vm, vm.requests]);

  const noun = vm.forge === "gitlab" ? "merge request" : "pull request";

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? vm.requests.filter(
          (r) =>
            r.title.toLowerCase().includes(q) ||
            r.author.toLowerCase().includes(q) ||
            r.head.toLowerCase().includes(q) ||
            String(r.number).startsWith(q)
        )
      : vm.requests;
    // Mine first, then the most recently touched.
    return [...matched].sort((a, b) => {
      const mine = Number(b.head === branch) - Number(a.head === branch);
      if (mine !== 0) return mine;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [vm.requests, query, branch]);

  // The filter earns its line only once scanning is the slow part.
  const filterable = vm.requests.length > 5 || query.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StatusStrip vm={vm} noun={noun} />

      {filterable && (
        <div className="flex shrink-0 items-center gap-1.5 rounded-lg bg-black/20 px-2 mx-1 mb-1.5">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter ${noun}s…`}
            className={cn(
              "h-6 min-w-0 flex-1 bg-transparent text-[11px]",
              "placeholder:text-muted-foreground/60 focus-visible:outline-none"
            )}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear filter"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {vm.status !== "ok" ? (
        <BlockedState vm={vm} noun={noun} />
      ) : rows.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-3 text-center">
          {/* Before the first answer lands, "none" is a guess, not a fact. */}
          {vm.checkedAt === null ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" />
              <p className="text-[11px] text-muted-foreground">
                Checking for open {noun}s…
              </p>
            </>
          ) : (
            <>
              <GitPullRequestArrow className="h-5 w-5 text-muted-foreground/40" />
              <p className="text-[11px] text-muted-foreground">
                {query.trim()
                  ? `No ${noun} matches “${query.trim()}”.`
                  : `No open ${noun}s.`}
              </p>
              {!query.trim() && (
                <p className="text-[10px] text-muted-foreground/60">
                  Re-checked automatically — nothing to do here.
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((r) => (
            <RequestRow
              key={r.number}
              request={r}
              fresh={vm.unseen.has(r.number)}
              mine={r.head === branch}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The one line that answers "am I logged in, and to what?" — the question
 * the old pane forced the user to ask out loud. Repository, the credential
 * that actually answered, and how stale the list is, left to right.
 */
function StatusStrip({ vm, noun }: { vm: PullRequestsViewModel; noun: string }) {
  const Glyph = vm.forge === "gitlab" ? Gitlab : Github;
  const cred = credentialChip(vm);
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-1.5 pb-1.5 text-[10px] text-muted-foreground">
      <Glyph className="h-3 w-3 shrink-0 text-muted-foreground/70" />
      <Tooltip content={vm.host ? `origin → ${vm.host}` : "No origin remote"}>
        <span className="min-w-0 shrink truncate font-mono text-[10px] text-foreground/80">
          {vm.repo ?? vm.host ?? "no remote"}
        </span>
      </Tooltip>
      <Tooltip content={cred.tip}>
        <span className="flex shrink-0 items-center gap-1">
          <span className={cn("h-1.5 w-1.5 rounded-full", cred.tone)} />
          {cred.label}
        </span>
      </Tooltip>

      <span className="flex-1" />

      <span className="shrink-0 tabular-nums text-muted-foreground/60">
        {vm.checkedAt ? `${relativeAge(vm.checkedAt)} ago` : "checking…"}
      </span>
      <Tooltip
        content={
          vm.checkedAt
            ? `Checked ${relativeAge(vm.checkedAt)} ago — check again now`
            : "Check for new requests now"
        }
      >
        <button
          onClick={vm.refresh}
          disabled={vm.loading}
          aria-label={`Check for new ${noun}s`}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {vm.loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </button>
      </Tooltip>
    </div>
  );
}

/** The credential dot: which login answered, or why none did. */
function credentialChip(vm: PullRequestsViewModel): {
  label: string;
  tone: string;
  tip: string;
} {
  const cli = vm.forge === "gitlab" ? "glab" : "gh";
  const who = vm.login ? ` as @${vm.login}` : "";
  switch (vm.status) {
    case "ok":
      switch (vm.source) {
        case "cli":
          return { label: cli, tone: "bg-success", tip: `Read through ${cli}${who}` };
        case "cli-token":
          return {
            label: `${cli} token`,
            tone: "bg-success",
            tip: `Read over the API with ${cli}'s token${who}`,
          };
        case "env":
          return {
            label: "env token",
            tone: "bg-success",
            tip: "Read with the token in this environment",
          };
        case "credential-helper":
          return {
            label: "git credential",
            tone: "bg-success",
            tip: `Read with the credential git pushes with${who}`,
          };
        default:
          return { label: "connected", tone: "bg-success", tip: "Connected" };
      }
    case "signed-out":
      return { label: "signed out", tone: "bg-destructive", tip: "No credential found" };
    case "denied":
      return { label: "rejected", tone: "bg-destructive", tip: vm.reason ?? "Rejected" };
    case "error":
      return { label: "unreachable", tone: "bg-warning", tip: vm.reason ?? "Failed" };
    default:
      return {
        label: "no forge",
        tone: "bg-muted-foreground/40",
        tip: vm.reason ?? "Nothing to list here",
      };
  }
}

/**
 * The empty pane, with the next action attached to it.
 *
 * The old one printed whatever went wrong under a fixed "sign in with
 * gh auth login" hint, which made every failure look like a logged-out
 * user — including "Unknown method" and a plain network blip. Only
 * `signed-out` offers a sign-in now; everything else offers a retry, and
 * the cases nothing can be done about offer neither.
 */
function BlockedState({ vm, noun }: { vm: PullRequestsViewModel; noun: string }) {
  const cli = vm.forge === "gitlab" ? "glab" : "gh";
  const signedOut = vm.status === "signed-out";
  const retryable = vm.status === "error" || vm.status === "denied";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
      {signedOut ? (
        <LogIn className="h-5 w-5 text-muted-foreground/40" />
      ) : (
        <GitPullRequestArrow className="h-5 w-5 text-muted-foreground/40" />
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        {vm.reason ?? `No ${noun}s to show for this remote.`}
      </p>

      {(signedOut || retryable) && (
        <button
          onClick={signedOut || vm.status === "denied" ? vm.connect : vm.refresh}
          disabled={vm.connecting || vm.loading}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1",
            "text-[11px] font-medium disabled:opacity-60",
            signedOut
              ? "bg-primary/15 text-primary hover:bg-primary/25"
              : "bg-white/5 text-foreground hover:bg-white/10"
          )}
        >
          {vm.connecting || vm.loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : signedOut ? (
            <LogIn className="h-3 w-3" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {signedOut
            ? `Connect ${vm.forge === "gitlab" ? "GitLab" : "GitHub"}`
            : "Try again"}
        </button>
      )}

      {signedOut && (
        <p className="text-[10px] leading-snug text-muted-foreground/60">
          Connect re-reads your login from{" "}
          <span className="font-mono">{cli}</span>, the environment and git's
          own credential helper. If it still finds none, run{" "}
          <span className="font-mono">{cli} auth login</span> once and press it
          again.
        </p>
      )}
    </div>
  );
}

/**
 * One request, in three zones per line: the thing you read (title, then
 * branches) takes the middle and gets all the slack, the identifiers pin
 * left, and the states that decide whether you click pin right. The old
 * row let `#number`, title, `head → base` and the age all pack into the
 * left third and left the pane's right half empty at any real width.
 */
function RequestRow(props: {
  request: GitPullRequest;
  fresh: boolean;
  mine: boolean;
}) {
  const { request: r } = props;
  const open = () => window.open(r.url, "_blank", "noopener,noreferrer");

  return (
    <div
      className={cn(
        "group flex items-stretch gap-1.5 rounded-md pr-1 hover:bg-accent/60",
        props.fresh && "bg-cyan/5"
      )}
    >
      <span aria-hidden className="relative flex w-3 shrink-0 justify-center py-1.5">
        <span className="absolute inset-y-0 w-px bg-white/10" />
        <GitPullRequestArrow
          className={cn(
            "relative h-3 w-3 shrink-0 rounded-full bg-card",
            r.draft ? "text-muted-foreground/60" : "text-success"
          )}
        />
      </span>

      <button
        onClick={open}
        className="flex min-w-0 flex-1 flex-col gap-0.5 py-1 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[10px] font-semibold tabular-nums text-muted-foreground/70">
            #{r.number}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs leading-tight">
            {r.title}
          </span>
          {props.fresh && (
            <span className="shrink-0 rounded-full bg-cyan/20 px-1.5 text-[9px] font-medium leading-[15px] text-cyan">
              new
            </span>
          )}
          {r.draft && (
            <span className="shrink-0 rounded-full bg-white/5 px-1.5 text-[9px] font-medium leading-[15px] text-muted-foreground">
              draft
            </span>
          )}
          {props.mine && (
            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[9px] font-medium leading-[15px] text-primary">
              yours
            </span>
          )}
          <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/60">
            {r.updatedAt ? relativeAge(Date.parse(r.updatedAt)) : ""}
          </span>
        </span>

        <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
          {r.author && (
            <span className="max-w-[40%] shrink-0 truncate">@{r.author}</span>
          )}
          <Tooltip content={`${r.head} → ${r.base}`}>
            <span className="min-w-0 flex-1 truncate font-mono text-[9px]">
              {r.head} → {r.base}
            </span>
          </Tooltip>
          <ReviewChip decision={r.reviewDecision} />
          <ChecksChip checks={r.checks} />
        </span>
      </button>

      <span className="flex shrink-0 items-center py-1">
        <Tooltip content="Open in the browser">
          <button
            onClick={open}
            aria-label={`Open #${r.number} in the browser`}
            className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

/** CI rollup as one icon — the colour is the whole message. */
function ChecksChip({ checks }: { checks: GitPullRequest["checks"] }) {
  if (!checks) return null;
  const map = {
    passing: { Icon: CircleCheck, tone: "text-success", label: "Checks passing" },
    failing: { Icon: CircleAlert, tone: "text-destructive", label: "Checks failing" },
    pending: { Icon: CircleDot, tone: "text-warning", label: "Checks running" },
  } as const;
  const { Icon, tone, label } = map[checks];
  return (
    <Tooltip content={label}>
      <span className={cn("flex shrink-0 items-center", tone)}>
        <Icon className="h-3 w-3" />
      </span>
    </Tooltip>
  );
}

/** GitHub's review state, in the two words that matter. */
function ReviewChip({ decision }: { decision?: string }) {
  if (!decision) return null;
  const label =
    decision === "APPROVED"
      ? "approved"
      : decision === "CHANGES_REQUESTED"
        ? "changes"
        : decision === "REVIEW_REQUIRED"
          ? "review"
          : decision.toLowerCase();
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 text-[9px] font-medium leading-[14px]",
        decision === "APPROVED"
          ? "bg-success/15 text-success"
          : decision === "CHANGES_REQUESTED"
            ? "bg-destructive/15 text-destructive"
            : "bg-white/5 text-muted-foreground"
      )}
    >
      {label}
    </span>
  );
}

/** "4h", "3d", "2w" — the age in the widest unit that still fits. */
function relativeAge(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "";
  const mins = Math.max(0, Math.round((Date.now() - epochMs) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months}mo`;
  return `${Math.round(days / 365)}y`;
}
