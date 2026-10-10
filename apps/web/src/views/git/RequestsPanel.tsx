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
  UserPlus,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Select } from "@/components/ui/select";
import {
  AUTOMATIC_CREDENTIAL,
  credentialHint,
  credentialLabel,
} from "@/lib/forge-credentials";
import { Tooltip } from "@/components/ui/tooltip";
import type { GitPullRequest } from "@atelier/protocol";
import type { PullRequestsViewModel } from "@/hooks/usePullRequestsViewModel";

export interface RequestsPanelProps {
  vm: PullRequestsViewModel;
  /** Branch of the current checkout — its own request is pinned on top. */
  branch?: string;
  /** Opens the PR flow on its description step. */
  onNewRequest?: () => void;
  /** True while the checkout sits on the branch a PR would merge INTO. */
  onBaseBranch?: boolean;
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
export function RequestsPanel({
  vm,
  branch,
  onNewRequest,
  onBaseBranch,
}: RequestsPanelProps) {
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

  // GitHub never offers to open a second request for a branch that already
  // has one — it shows the one that exists. Nor does it offer one from the
  // base branch, where there is nothing to propose.
  const mine = branch
    ? vm.requests.find((request) => request.head === branch)
    : undefined;
  const canOpen = Boolean(
    onNewRequest && vm.status === "ok" && !mine && !onBaseBranch
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StatusStrip vm={vm} noun={noun} />

      {canOpen && rows.length > 0 && (
        // Header placement, the way GitHub does it once a list exists: the
        // list is the subject and the action sits above it, out of the way.
        <div className="flex shrink-0 justify-end px-1 pb-1.5">
          <NewRequestButton noun={noun} onClick={onNewRequest} />
        </div>
      )}

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
              {!query.trim() && !canOpen && (
                <p className="text-[10px] text-muted-foreground/60">
                  Re-checked automatically — nothing to do here.
                </p>
              )}
              {!query.trim() && canOpen && (
                <>
                  <p className="text-[10px] text-muted-foreground/60">
                    {branch ? (
                      <>
                        Open one from{" "}
                        <span className="font-mono">{branch}</span>.
                      </>
                    ) : (
                      "Open one from this branch."
                    )}
                  </p>
                  {/* Centred, because with no list there is nothing for the
                      action to sit above — it IS the content of the pane. */}
                  <div className="pt-1.5">
                    <NewRequestButton noun={noun} onClick={onNewRequest} />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          <p className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Open {noun}s · {rows.length}
          </p>
          <div className="space-y-1.5">
            {rows.map((r) => (
              <RequestRow
                key={r.number}
                request={r}
                fresh={vm.unseen.has(r.number)}
                mine={r.head === branch}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "New pull request" — one button, two placements.
 *
 * GitHub's own shape, and for its reasons: with a list on screen the action
 * belongs above it, out of the way of the thing you came to read; with no
 * list it IS the content of the pane, so it goes in the middle where the
 * eye already is. Same button either way, so it never reads as two
 * different features.
 */
function NewRequestButton(props: { noun: string; onClick?: () => void }) {
  return (
    <button
      onClick={props.onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5",
        "text-[11px] font-medium transition-colors",
        "bg-primary/15 text-primary hover:bg-primary/25"
      )}
    >
      <GitPullRequestArrow className="h-3.5 w-3.5" />
      New {props.noun}
    </button>
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
    <div
      className={cn(
        "mx-1 mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-border/60",
        "bg-card/60 px-2 py-1.5 text-[11px] text-muted-foreground"
      )}
    >
      <Glyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
      {/* Before the first answer, the repo and the credential are unknown —
          and naming the PREVIOUS checkout's is exactly the bug this strip
          had. "no remote" would be just as wrong: it is a verdict about a
          question nobody has asked yet. */}
      <Tooltip content={vm.host ? `origin → ${vm.host}` : "No origin remote"}>
        <span className="min-w-0 shrink truncate font-mono text-[10px] text-foreground/80">
          {vm.checkedAt === null
            ? "checking…"
            : (vm.repo ?? vm.host ?? "no remote")}
        </span>
      </Tooltip>
      {vm.checkedAt !== null && (
        <Tooltip content={cred.tip}>
          <span className="flex shrink-0 items-center gap-1">
            <span className={cn("h-1.5 w-1.5 rounded-full", cred.tone)} />
            {cred.label}
          </span>
        </Tooltip>
      )}
      {vm.status === "ok" && vm.credentials.length > 0 && (
        <CredentialPicker vm={vm} compact />
      )}

      <span className="flex-1" />

      {/* The pane is live: polled, re-checked on focus, and re-checked in a
          burst when this app opens a request. Say so, with the age. */}
      <span className="flex shrink-0 items-center gap-1.5 tabular-nums text-muted-foreground/70">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            vm.loading ? "animate-pulse bg-cyan" : "bg-success/80"
          )}
        />
        {vm.loading
          ? "checking…"
          : vm.checkedAt
            ? `live · ${relativeAge(vm.checkedAt)} ago`
            : "checking…"}
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
        case "stored":
          return {
            label: who ? `@${vm.login}` : "saved token",
            tone: "bg-success",
            tip: `Read with the token you added here${who}`,
          };
        default:
          return { label: "connected", tone: "bg-success", tip: "Connected" };
      }
    case "signed-out":
      return { label: "signed out", tone: "bg-destructive", tip: "No credential found" };
    case "denied":
      return {
        label: vm.login ? `@${vm.login} denied` : "API denied",
        tone: "bg-destructive",
        tip: vm.reason ?? "The forge API rejected this credential",
      };
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


/** Machine credentials exposed as opaque ids; tokens never reach the UI. */
function CredentialPicker({
  vm,
  compact = false,
}: {
  vm: PullRequestsViewModel;
  compact?: boolean;
}) {
  const options = [
    {
      value: AUTOMATIC_CREDENTIAL,
      label: "Automatic",
      hint: "Try the forge CLI, environment, then git credential",
    },
    ...vm.credentials.map((credential) => ({
      value: credential.id,
      label: credentialLabel(credential, vm.forge),
      hint: credentialHint(credential),
    })),
  ];

  return (
    <Select
      value={vm.credentialId ?? AUTOMATIC_CREDENTIAL}
      onChange={(value) =>
        vm.selectCredential(
          value === AUTOMATIC_CREDENTIAL ? undefined : value
        )
      }
      options={options}
      disabled={vm.loading || vm.connecting}
      className={cn(
        compact
          ? "h-5 max-w-32 bg-white/5 px-1 text-[10px]"
          : "h-7 w-full justify-between bg-black/20 px-2 text-[11px]"
      )}
      menuClassName="min-w-56"
    />
  );
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
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <div className="flex max-w-[340px] flex-col items-center justify-center gap-3 rounded-2xl border border-border/60 bg-card p-6 text-center shadow-sm">
        {signedOut ? (
          <LogIn className="h-6 w-6 text-muted-foreground/40" />
        ) : (
          <GitPullRequestArrow className="h-6 w-6 text-muted-foreground/40" />
        )}
        {/* Pre-line: an explanation of a split credential needs paragraphs
            and an indented command line, and a command run together with
            the prose around it is a command the user pastes wrong. */}
        <p className="whitespace-pre-line text-left text-[11px] leading-relaxed text-muted-foreground">
          {vm.reason ?? `No ${noun}s to show for this remote.`}
        </p>

        {vm.credentials.length > 0 && (
          <div className="w-full space-y-1.5 text-left">
            <p className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60">
              Credentials on this machine
            </p>
            <CredentialPicker vm={vm} />
          </div>
        )}

        {(signedOut || retryable) && (
          <button
            onClick={signedOut || vm.status === "denied" ? vm.connect : vm.refresh}
            disabled={vm.connecting || vm.loading}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5",
              "text-[11px] font-medium transition-colors disabled:opacity-60",
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
              : vm.status === "denied"
                ? "Re-check credentials"
                : "Try again"}
          </button>
        )}

        {(signedOut || vm.status === "denied") && <AddAccount vm={vm} />}

        {signedOut && (
          <p className="text-[10px] leading-relaxed text-muted-foreground/60">
            Connect re-reads your login from{" "}
            <span className="font-mono">{cli}</span>, the environment and git's
            own credential helper. If it still finds none, run{" "}
            <span className="font-mono">{cli} auth login</span> once and press it
            again.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Adds a second forge account without leaving the app.
 *
 * A machine with two GitHub accounts is an ordinary setup, and the panel
 * used to answer it with a paragraph of instructions ending in a terminal
 * command — which is a context switch, and which one user pasted wrong
 * twice because the account name read like part of the command.
 *
 * A token rather than a browser flow, deliberately: it is the only path
 * that is fully non-interactive, works headless, and needs no OAuth client
 * of Atelier's own. The agent verifies it with the forge before storing
 * it, so the panel can name the account it belongs to instead of leaving
 * the user to find out later that they added the wrong one again.
 */
function AddAccount(props: { vm: PullRequestsViewModel }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [result, setResult] = useState<{
    ok: boolean;
    login?: string;
    persisted?: boolean;
    reason?: string;
  } | null>(null);
  const host = props.vm.host ?? "github.com";
  const tokenUrl = /^(www\.)?github\.com$/i.test(host)
    ? "https://github.com/settings/tokens/new?scopes=repo&description=Atelier"
    : `https://${host}/-/user_settings/personal_access_tokens`;

  const submit = () => {
    if (!token.trim()) return;
    setResult(null);
    void props.vm.addAccount(token).then((next) => {
      setResult(next);
      if (next.ok) setToken("");
    });
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5",
          "text-[11px] font-medium transition-colors",
          "bg-primary/15 text-primary hover:bg-primary/25"
        )}
      >
        <UserPlus className="h-3 w-3" />
        Add another account
      </button>
    );
  }

  return (
    <div className="w-full space-y-1.5 text-left">
      <p className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60">
        Add another account
      </p>
      <p className="text-[10px] leading-relaxed text-muted-foreground/70">
        Paste a personal access token for the account that can see this
        repository.{" "}
        <a
          href={tokenUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          Create one
        </a>{" "}
        with the <span className="font-mono">repo</span> scope. Atelier checks
        which account it belongs to before storing it.
      </p>
      <input
        type="password"
        autoFocus
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="ghp_… or github_pat_…"
        className={cn(
          "w-full rounded-md border border-border bg-background px-2 py-1",
          "font-mono text-[11px] outline-none focus:border-primary/60"
        )}
      />
      <div className="flex gap-1.5">
        <button
          onClick={submit}
          disabled={props.vm.connecting || token.trim() === ""}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5",
            "text-[11px] font-medium transition-colors disabled:opacity-60",
            "bg-primary/15 text-primary hover:bg-primary/25"
          )}
        >
          {props.vm.connecting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <UserPlus className="h-3 w-3" />
          )}
          Add account
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-white/5"
        >
          Cancel
        </button>
      </div>
      {result && (
        <p
          className={cn(
            "text-[10px] leading-relaxed",
            result.ok ? "text-success" : "text-danger"
          )}
        >
          {result.ok
            ? `Added @${result.login}.` +
              (result.persisted
                ? " Requests are reloading."
                : ` ${result.reason ?? ""}`)
            : result.reason}
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

  // A card per request, GitHub's own shape at a glance: state glyph, number
  // and title on the first line, who / from where / review / CI on the
  // second. The old row was a single 10px line hugging a hairline — a list
  // of one request read as an empty pane.
  return (
    <div
      className={cn(
        "group relative flex items-stretch gap-2 overflow-hidden rounded-lg border",
        "border-border/60 bg-card/60 pr-1.5 transition-colors hover:border-border",
        "hover:bg-accent/50",
        props.fresh && "border-cyan/40 bg-cyan/5",
        props.mine && !props.fresh && "border-primary/30"
      )}
    >
      {/* State bar: open = green, draft = grey. */}
      <span
        aria-hidden
        className={cn(
          "w-1 shrink-0",
          r.draft ? "bg-muted-foreground/40" : "bg-success"
        )}
      />
      <span
        aria-hidden
        className={cn(
          "mt-2.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          r.draft ? "bg-white/5 text-muted-foreground" : "bg-success/15 text-success"
        )}
      >
        <GitPullRequestArrow className="h-3 w-3" />
      </span>

      <button
        onClick={open}
        className="flex min-w-0 flex-1 flex-col gap-1 py-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[11px] font-semibold tabular-nums text-muted-foreground/70">
            #{r.number}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-foreground">
            {r.title}
          </span>
          {props.fresh && (
            <span className="shrink-0 rounded-full bg-cyan/20 px-1.5 text-[9px] font-medium leading-[16px] text-cyan">
              new
            </span>
          )}
          {r.draft && (
            <span className="shrink-0 rounded-full bg-white/5 px-1.5 text-[9px] font-medium leading-[16px] text-muted-foreground">
              draft
            </span>
          )}
          {props.mine && (
            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[9px] font-medium leading-[16px] text-primary">
              yours
            </span>
          )}
        </span>

        <span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          {r.author && (
            <span className="flex max-w-[40%] shrink-0 items-center gap-1 truncate">
              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary/20 text-[8px] font-semibold uppercase text-primary">
                {r.author.charAt(0)}
              </span>
              {r.author}
            </span>
          )}
          <Tooltip content={`${r.head} → ${r.base}`}>
            <span className="flex min-w-0 flex-1 items-center gap-1 truncate font-mono text-[10px]">
              <span className="truncate rounded bg-white/5 px-1">{r.head}</span>
              <span className="shrink-0 text-muted-foreground/50">→</span>
              <span className="shrink-0 rounded bg-white/5 px-1">{r.base}</span>
            </span>
          </Tooltip>
          <ReviewChip decision={r.reviewDecision} />
          <ChecksChip checks={r.checks} />
          <span className="shrink-0 tabular-nums text-muted-foreground/60">
            {r.updatedAt ? relativeAge(Date.parse(r.updatedAt)) : ""}
          </span>
        </span>
      </button>

      <span className="flex shrink-0 items-start pt-2">
        <Tooltip content="Open in the browser">
          <button
            onClick={open}
            aria-label={`Open #${r.number} in the browser`}
            className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-white/5 hover:text-foreground group-hover:text-muted-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
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
