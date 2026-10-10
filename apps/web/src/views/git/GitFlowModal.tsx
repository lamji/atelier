import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CircleAlert,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Loader2,
  ShieldAlert,
  ChevronRight,
  Square,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";
import { STAGE_LABELS } from "@/lib/stage-labels";
import { useElapsed } from "@/hooks/useElapsed";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { GitModelSelect } from "./GitModelSelect";
import {
  AUTOMATIC_CREDENTIAL,
  credentialHint,
  credentialLabel,
} from "@/lib/forge-credentials";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import type { GitFlowRequest } from "@atelier/protocol";
import type { GitFlowViewModel } from "@/hooks/useGitFlowViewModel";
import type { FlowStage } from "@/state/git-flow.store";
import type { SessionVm } from "@/state/sessions.store";

const STAGE_TITLES: Record<FlowStage, string> = {
  idle: "",
  confirm: "The agent wants to run git",
  branch: "Create feature branch",
  commit: "Committing…",
  "commit-fix": "Commit failed",
  push: "Push to origin",
  "push-fix": "Push failed",
  "pr-ask": "Create a pull request?",
  "pr-compare": "New pull request",
  "pr-describe": "Pull request details",
  "pr-push-check": "This branch is not fully pushed",
  "pr-conflicts": "Checking mergeability",
  "conflict-fix": "Resolve merge conflicts",
  "pr-create": "Creating pull request…",
  "pr-fix": "PR creation failed",
  done: "Done",
};

/** Commit → Push → PR progress dots. */
function stepIndex(stage: FlowStage): number {
  if (["confirm", "branch", "commit", "commit-fix"].includes(stage)) return 0;
  if (["push", "push-fix"].includes(stage)) return 1;
  if (stage === "done") return 3;
  return 2;
}

const RERUN_LABELS: Partial<Record<FlowStage, string>> = {
  "commit-fix": "Re-commit",
  "push-fix": "Re-push",
  "conflict-fix": "Commit merge & continue",
  "pr-fix": "Retry PR",
};

/**
 * The commit → push → PR wizard. A modal with a terminal-style output
 * pane for streamed git/gh runs and an embedded Sonnet 5 fix chat for
 * failed steps.
 */
export function GitFlowModal({ vm }: { vm: GitFlowViewModel }) {
  const { flow, fixSession } = vm;

  return (
    <AnimatePresence>
      {flow.open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="modal-surface island flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden"
          >
            <Header vm={vm} />
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
              {flow.error && flow.stage !== "done" && (
                <p className="flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                  <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                  {flow.error}
                </p>
              )}
              <StageBody vm={vm} fixSession={fixSession} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Header({ vm }: { vm: GitFlowViewModel }) {
  const { flow } = vm;
  const step = stepIndex(flow.stage);
  return (
    <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
      <span className="shrink-0 text-sm font-medium">
        {STAGE_TITLES[flow.stage]}
      </span>
      {flow.info?.branch && (
        <Tooltip content="Current branch">
          <span className="flex min-w-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            <GitBranch className="h-3 w-3 shrink-0 text-primary/70" />
            <span className="truncate">{flow.info.branch}</span>
          </span>
        </Tooltip>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {["Commit", "Push", "PR"].map((label, i) => (
          <span key={label} className="flex items-center gap-1">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                i < step
                  ? "bg-primary"
                  : i === step
                    ? "bg-primary animate-pulse"
                    : "bg-muted-foreground/30"
              )}
            />
            <span
              className={cn(
                "text-[10px]",
                i <= step ? "text-foreground" : "text-muted-foreground/50"
              )}
            >
              {label}
            </span>
          </span>
        ))}
      </span>
      <Tooltip content="Close">
        <button
          onClick={vm.close}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  );
}

function StageBody({
  vm,
  fixSession,
}: {
  vm: GitFlowViewModel;
  fixSession: SessionVm | null;
}) {
  const { flow } = vm;
  switch (flow.stage) {
    case "confirm":
      return <ConfirmStage vm={vm} />;
    case "branch":
      return <BranchStage vm={vm} />;
    case "commit":
    case "pr-create":
      return (
        <>
          <RunningLine text={STAGE_TITLES[flow.stage]} running={flow.running} />
          <OutputPane output={flow.output} />
        </>
      );
    case "push":
      return <PushStage vm={vm} />;
    case "commit-fix":
    case "push-fix":
    case "conflict-fix":
    case "pr-fix":
      return (
        <>
          <OutputPane output={flow.output} compact />
          {flow.prCompareUrl && <CompareFallback url={flow.prCompareUrl} />}
          <FixChat vm={vm} session={fixSession} />
        </>
      );
    case "pr-ask":
      return <PrAskStage vm={vm} />;
    case "pr-compare":
      return <PrCompareStage vm={vm} />;
    case "pr-push-check":
      return <PrPushCheckStage vm={vm} />;
    case "pr-describe":
      return <PrDescribeStage vm={vm} />;
    case "pr-conflicts":
      return <PrConflictsStage vm={vm} />;
    case "done":
      return <DoneStage vm={vm} />;
    default:
      return null;
  }
}

/**
 * The way out of a `gh` failure the AI cannot fix. When gh cannot resolve
 * the repository — wrong account, token without `repo` scope, org SSO not
 * authorized — nothing in the workspace is broken and no edit will help,
 * but the branch is already pushed, so the PR is one click away in the
 * browser session that does work.
 */
function CompareFallback({ url }: { url: string }) {
  return (
    <div className="rounded-lg bg-secondary/40 px-2.5 py-2">
      <p className="text-[11px] text-muted-foreground">
        The branch is pushed — if this is a `gh` sign-in or permission
        problem, open the pull request on github.com instead. The title and
        description you drafted are carried over.
      </p>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
      >
        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        Open PR on github.com
      </a>
    </div>
  );
}

const OPERATION_LABELS: Record<GitFlowRequest["operation"], string> = {
  commit: "commit your changes",
  push: "push this branch",
  pr: "open a pull request",
};

/**
 * Gate stage: the git-flow hook refused the agent's own commit/push/PR.
 * Nothing has run yet — the user reviews the attempt, edits the message,
 * and either takes over the flow or dismisses it.
 */
function ConfirmStage({ vm }: { vm: GitFlowViewModel }) {
  const { flow } = vm;
  const request = flow.request;
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0 text-primary/70" />
        <span>
          The agent tried to{" "}
          {request ? OPERATION_LABELS[request.operation] : "run git"} on its
          own. Atelier blocked it — the git flow only runs when you say so.
        </span>
      </p>
      {request && (
        <pre className="overflow-x-auto rounded-lg bg-black/40 p-2.5 font-mono text-[11px] text-muted-foreground">
          $ {request.command}
        </pre>
      )}
      <div className="space-y-1.5">
        <label className="text-[11px] text-muted-foreground">
          Commit message
        </label>
        <Textarea
          value={flow.commitMessage}
          onChange={(e) => vm.setCommitMessage(e.target.value)}
          placeholder="feat: describe the change"
          rows={2}
          className="min-h-0 resize-none text-xs"
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!flow.commitMessage.trim()}
          onClick={() => void vm.confirmRequest()}
        >
          <GitCommitHorizontal className="mr-1.5 h-3.5 w-3.5" />
          Continue git flow
        </Button>
        <Button size="sm" variant="secondary" onClick={vm.close}>
          Not now
        </Button>
      </div>
    </div>
  );
}

function BranchStage({ vm }: { vm: GitFlowViewModel }) {
  const { flow } = vm;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        You are on <span className="font-mono">{flow.info?.defaultBranch}</span>.
        The flow commits to a feature branch so the PR can target{" "}
        <span className="font-mono">{flow.info?.defaultBranch}</span> later.
      </p>
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 shrink-0 text-primary/70" />
        <Input
          value={flow.branchName}
          onChange={(e) => vm.setBranchName(e.target.value)}
          placeholder={flow.suggestingBranch ? "Suggesting…" : "feat/my-change"}
          className="h-8 font-mono text-xs"
        />
        {flow.suggestingBranch && (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>
      <Button
        size="sm"
        className="w-full"
        disabled={flow.running || flow.suggestingBranch || !flow.branchName.trim()}
        onClick={() => void vm.confirmBranch()}
      >
        <GitBranch className="mr-1.5 h-3.5 w-3.5" />
        Create branch & commit
      </Button>
    </div>
  );
}

function PushStage({ vm }: { vm: GitFlowViewModel }) {
  const { flow } = vm;
  return (
    <>
      {flow.running ? (
        <RunningLine text="Pushing…" running />
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void vm.runPush()}>
            Push
          </Button>
          <Tooltip content="Extra flags passed to git push">
            <Input
              value={flow.flagsText}
              onChange={(e) => vm.setFlagsText(e.target.value)}
              placeholder="--no-verify --tags …"
              className="h-8 flex-1 font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") void vm.runPush();
              }}
            />
          </Tooltip>
        </div>
      )}
      <OutputPane output={flow.output} />
    </>
  );
}

function PrAskStage({ vm }: { vm: GitFlowViewModel }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Pushed successfully. Create a pull request for this branch?
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void vm.beginPr()}>
          <GitPullRequest className="mr-1.5 h-3.5 w-3.5" />
          Create PR
        </Button>
        <Button size="sm" variant="secondary" onClick={vm.skipPr}>
          Finish without PR
        </Button>
      </div>
    </div>
  );
}

/**
 * The push check, as its own screen.
 *
 * It replaces the compare form rather than sitting under it because the
 * two answers lead to different pull requests: push, and the request
 * contains the work; proceed, and it contains whatever the remote already
 * had. Offered as a choice — GitHub compares what it HAS, and plenty of
 * requests are opened from a branch whose author is still working — but
 * offered where it cannot be walked past without being read.
 */
function PrPushCheckStage({ vm }: { vm: GitFlowViewModel }) {
  const { flow } = vm;
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs text-warning">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          {flow.prWarnings.map((warning) => (
            <span key={warning} className="block">
              {warning}
            </span>
          ))}
        </span>
      </p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        GitHub compares{" "}
        <span className="font-mono">{flow.prHead}</span> as it exists on the
        remote against <span className="font-mono">{flow.prBase}</span>. Push
        first and the request contains this work; proceed and it contains
        whatever origin already has.
      </p>
      {flow.output && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-black/25 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-neutral-300">
          {flow.output}
        </pre>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={flow.running}
          onClick={vm.backToCompare}
        >
          Back
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={flow.running}
          onClick={vm.skipPushAndDraft}
        >
          Proceed anyway
        </Button>
        {/* Only when pushing would actually change the answer. With just
            uncommitted work there is nothing to send, and a button that
            does nothing is worse than no button. */}
        {flow.prWarnings.some((w) => /pushed/.test(w)) && (
          <Button
            size="sm"
            disabled={flow.running}
            onClick={() => void vm.pushThenDraft()}
          >
            {flow.running ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="mr-1.5 h-3.5 w-3.5" />
            )}
            Push now
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Step 1 — which two branches.
 *
 * Only the two pickers and one button. Everything that follows depends on
 * this answer: the push check is about the head, and the description is
 * about the range between them. Showing the title and body fields here as
 * well — as this screen first did — turns a sequence into a form and
 * invites the description to be written before the question it answers.
 */
function PrCompareStage({ vm }: { vm: GitFlowViewModel }) {
  const { flow } = vm;
  const head = flow.prHead || (flow.info?.branch ?? "");
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Choose what to merge, and where into.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Select
          value={head}
          onChange={vm.setPrHead}
          className="h-7 font-mono"
          searchable
          searchPlaceholder="Filter branches…"
          options={headChoices(flow).map((b) => ({
            value: b,
            label: b === flow.info?.branch ? `${b}  (current)` : b,
          }))}
        />
        <span className="text-muted-foreground">→</span>
        <Select
          value={flow.prBase}
          onChange={vm.setPrBase}
          className="h-7 font-mono"
          searchable
          searchPlaceholder="Filter branches…"
          options={flow.remoteBranches
            .filter((b) => b !== head)
            .map((b) => ({ value: b, label: b }))}
        />
      </div>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!flow.prBase || !head || flow.prBase === head}
          onClick={vm.generatePr}
        >
          Continue
          <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Step 3 — the description, for a comparison that is already settled.
 *
 * No pickers here. Changing the branches means going back a step, which is
 * what "Change branches" does; leaving them editable beside a finished
 * draft is how a description ends up describing a different pair.
 */
function PrDescribeStage({ vm }: { vm: GitFlowViewModel }) {
  const { flow } = vm;
  const drafted = flow.prDraftedFor !== "";
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {flow.prHead || flow.info?.branch} → {flow.prBase}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[10px]"
          disabled={flow.prDrafting}
          onClick={vm.backToCompare}
        >
          Change branches
        </Button>
        {/* The provider/model the description is drafted on — shared with
            the commit-message draft. Beside Generate so a regenerate on a
            different model is one pick and one click. */}
        <GitModelSelect
          disabled={flow.prDrafting}
          className="ml-auto h-7 w-44 rounded-md border border-border/70 bg-background/70 px-2"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={flow.prDrafting}
          onClick={vm.generatePr}
        >
          {flow.prDrafting ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Wand2 className="mr-1.5 h-3.5 w-3.5" />
          )}
          {flow.prDrafting ? "Drafting…" : drafted ? "Regenerate" : "Generate"}
        </Button>
      </div>
      {flow.prDrafting && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading the commits between these two branches…
        </p>
      )}
      <Input
        value={flow.prTitle}
        onChange={(e) => vm.setPrTitle(e.target.value)}
        placeholder={flow.prDrafting ? "Drafting title…" : "PR title"}
        className="h-8 text-xs"
        disabled={flow.prDrafting}
      />
      <Textarea
        value={flow.prBody}
        onChange={(e) => vm.setPrBody(e.target.value)}
        placeholder={
          flow.prDrafting ? "Drafting description…" : "PR description (markdown)"
        }
        rows={8}
        className="resize-none text-xs"
        disabled={flow.prDrafting}
      />
      <PrAccountPicker vm={vm} />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={flow.prDrafting || !flow.prTitle.trim()}
          onClick={() => void vm.validatePr()}
        >
          Validate &amp; create
        </Button>
      </div>
    </div>
  );
}

/**
 * Which account opens the pull request.
 *
 * On a machine with two GitHub logins the answer is not obvious and the
 * cost of getting it wrong is opaque: the branch pushes as one account
 * while `gh` asks GitHub as another, and GitHub replies "Could not resolve
 * to a Repository" — which reads as a missing repo, not a wrong identity.
 * Atelier pre-selects the account this checkout actually pushes as; the
 * picker is here so that choice is visible and overridable rather than
 * silent.
 */
function PrAccountPicker({ vm }: { vm: GitFlowViewModel }) {
  const { flow } = vm;
  if (flow.prCredentials.length === 0) return null;

  const selected = flow.prCredentialId
    ? flow.prCredentials.find(
        (credential) => credential.id === flow.prCredentialId
      )
    : undefined;
  const matchesCheckout =
    Boolean(flow.prIdentity) &&
    Boolean(selected?.login) &&
    selected?.login?.toLowerCase() === flow.prIdentity.toLowerCase();

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-muted-foreground">Open as</label>
        {flow.prIdentity && (
          <span className="text-[10px] text-muted-foreground/70">
            this branch pushes as @{flow.prIdentity}
          </span>
        )}
      </div>
      <Select
        value={flow.prCredentialId ?? AUTOMATIC_CREDENTIAL}
        onChange={(value) =>
          vm.selectPrCredential(
            value === AUTOMATIC_CREDENTIAL ? undefined : value
          )
        }
        options={[
          {
            value: AUTOMATIC_CREDENTIAL,
            label: "Automatic",
            hint: "Match the account this checkout pushes as",
          },
          ...flow.prCredentials.map((credential) => ({
            value: credential.id,
            label: credentialLabel(credential, "github"),
            hint: credentialHint(credential),
          })),
        ]}
        disabled={flow.prDrafting}
        className="h-7 w-full justify-between px-2 text-[11px]"
        menuClassName="min-w-56"
      />
      {selected && flow.prIdentity && !matchesCheckout && (
        <p className="text-[10px] text-amber-500/90">
          This account is not the one that pushed the branch. If it cannot
          see the repository, GitHub answers &ldquo;could not resolve&rdquo;.
        </p>
      )}
    </div>
  );
}

/**
 * Head branches worth offering: everything on the remote, plus the branch
 * you are standing on even when it has never been pushed.
 *
 * The unpushed one is included on purpose. Leaving it out would answer
 * "why can't I pick my own branch?" with silence; including it and warning
 * that GitHub cannot see it yet answers the question.
 */
function headChoices(flow: {
  remoteBranches: string[];
  info?: { branch: string } | null;
}): string[] {
  const current = flow.info?.branch;
  const all = current
    ? [current, ...flow.remoteBranches.filter((b) => b !== current)]
    : flow.remoteBranches;
  return [...new Set(all.filter(Boolean))];
}


function PrConflictsStage({ vm }: { vm: GitFlowViewModel }) {
  const { flow } = vm;
  if (flow.running && flow.conflicts.length === 0) {
    return <RunningLine text={`Checking conflicts against ${flow.prBase}…`} running />;
  }
  if (flow.running) {
    return (
      <>
        <RunningLine text="Merging base branch…" running />
        <OutputPane output={flow.output} />
      </>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-destructive">
        {flow.conflicts.length} file(s) conflict with{" "}
        <span className="font-mono">{flow.prBase}</span>:
      </p>
      <ul className="max-h-32 space-y-0.5 overflow-y-auto">
        {/* break-all for the same reason as the plan card: a repo-relative
            path has no space to wrap at, so it runs past the modal. */}
        {flow.conflicts.map((f) => (
          <li
            key={f}
            className="break-all font-mono text-[11px] text-muted-foreground"
          >
            {f}
          </li>
        ))}
      </ul>
      <Button size="sm" onClick={() => void vm.resolveConflicts()}>
        <GitMerge className="mr-1.5 h-3.5 w-3.5" />
        Merge & resolve with AI
      </Button>
    </div>
  );
}

function DoneStage({ vm }: { vm: GitFlowViewModel }) {
  const { flow } = vm;
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      {flow.error ? (
        <CircleAlert className="h-8 w-8 text-destructive/70" />
      ) : (
        <Check className="h-8 w-8 text-success" />
      )}
      <p className="text-sm">
        {flow.error
          ? flow.error
          : flow.prUrl
            ? "Pull request created."
            : "All done — changes committed and pushed."}
      </p>
      {flow.prUrl && (
        <a
          href={flow.prUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-xs text-primary hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {flow.prUrl}
        </a>
      )}
      <Button size="sm" variant="secondary" onClick={vm.close}>
        Close
      </Button>
    </div>
  );
}

/**
 * Live trace of the repair task: the model stays silent while it reads
 * and edits, so without this the fix chat looks frozen. Shows the current
 * pipeline stage, the last few tool calls, and the elapsed time.
 */
function FixProgress({ session }: { session: SessionVm }) {
  const elapsed = useElapsed(session.taskStartedAt);
  const recent = session.actions.slice(-4);
  const running = recent.find((a) => a.status === "running");
  const headline =
    running?.label ??
    (session.stage ? STAGE_LABELS[session.stage] : "starting…");

  return (
    <div className="rounded-lg bg-secondary/30 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
          {headline}
        </span>
        {session.taskStartedAt !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        )}
      </div>
      {recent.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {recent.map((action) => (
            <p
              key={action.id}
              className="flex items-center gap-1.5 truncate font-mono text-[10px] text-muted-foreground"
            >
              {action.status === "running" ? (
                <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-primary/70" />
              ) : action.status === "done" ? (
                <Check className="h-2.5 w-2.5 shrink-0 text-success" />
              ) : (
                <CircleAlert className="h-2.5 w-2.5 shrink-0 text-destructive" />
              )}
              <span className="truncate">{action.label}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function RunningLine({ text, running }: { text: string; running: boolean }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {text}
    </p>
  );
}

/** Read-only terminal-style pane; follows the stream unless you scroll up. */
function OutputPane({ output, compact }: { output: string; compact?: boolean }) {
  const { ref, onScroll } = useStickToBottom<HTMLPreElement>([output]);
  return (
    <pre
      ref={ref}
      onScroll={onScroll}
      className={cn(
        "overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-black/40",
        "p-3 font-mono text-[11px] leading-relaxed text-neutral-300",
        compact ? "max-h-36" : "max-h-72 min-h-36"
      )}
    >
      {output || "…"}
    </pre>
  );
}

/**
 * Embedded fix chat: streams the Sonnet 5 repair task's messages from
 * the sessions store; the user can add extra instructions per attempt.
 * The contextual re-run button appears once the fix task is idle.
 */
function FixChat({
  vm,
  session,
}: {
  vm: GitFlowViewModel;
  session: SessionVm | null;
}) {
  const [prompt, setPrompt] = useState("");
  const working = session?.status === "working";
  const cancelling = session?.cancelling ?? false;
  const hasRun = (session?.items.length ?? 0) > 0;
  const reRunLabel = RERUN_LABELS[vm.flow.stage] ?? "Re-run";
  const { ref: listRef, onScroll } = useStickToBottom<HTMLDivElement>([
    session?.items,
  ]);

  const doFix = () => {
    void vm.startFix(prompt);
    setPrompt("");
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {session && session.items.length > 0 && (
        <div
          ref={listRef}
          onScroll={onScroll}
          className="max-h-56 space-y-2 overflow-y-auto rounded-lg bg-secondary/30 p-2.5"
        >
          {session.items.map((item) => {
            if (item.role === "log" || item.role === "diff") {
              const label =
                item.role === "diff" ? `Edited ${item.text}` : item.text;
              return (
                <p
                  key={item.id}
                  className="truncate font-mono text-[10px] text-muted-foreground"
                >
                  {label}
                </p>
              );
            }
            return (
              <div
                key={item.id}
                className={cn(
                  "text-xs",
                  item.role === "user" ? "text-muted-foreground" : "chat-md"
                )}
              >
                {item.role === "user" ? (
                  <p className="italic">» {item.text}</p>
                ) : (
                  <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
                )}
                {item.streaming && (
                  <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-primary/60" />
                )}
              </div>
            );
          })}
          {working && session.thinking && (
            <p className="text-[10px] italic text-muted-foreground/60">
              {session.thinking.slice(-200)}
            </p>
          )}
        </div>
      )}

      {working && session && <FixProgress session={session} />}

      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Optional: tell the AI anything it should know for the fix"
        rows={2}
        className="min-h-0 resize-none text-xs"
        disabled={working}
      />
      <div className="flex gap-2">
        {working ? (
          // A running fix is stoppable, not just observable: the button
          // that showed a dead spinner now IS the stop control, so a fix
          // heading the wrong way can be killed without closing the wizard.
          // Same idiom as the composer — destructive square, then a
          // "Stopping…" spinner until the task really ends.
          <Tooltip
            content={
              cancelling
                ? "Stopping — finishing the current step"
                : "Stop the fix"
            }
          >
            <Button
              size="sm"
              variant="destructive"
              disabled={cancelling}
              onClick={() => vm.cancelFix()}
            >
              {cancelling ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Stopping…
                </>
              ) : (
                <>
                  <Square className="mr-1.5 h-3 w-3 fill-current" />
                  Stop
                </>
              )}
            </Button>
          </Tooltip>
        ) : (
          <Button size="sm" onClick={doFix}>
            <Wand2 className="mr-1.5 h-3.5 w-3.5" />
            {hasRun ? "Fix again" : "Fix with AI"}
          </Button>
        )}
        {hasRun && !working && (
          <Button size="sm" variant="secondary" onClick={() => void vm.reRunAfterFix()}>
            {reRunLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
