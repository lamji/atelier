import Image from "next/image";
import {
  ArrowDownToLine,
  Bot,
  Braces,
  Check,
  ChevronRight,
  CircleDot,
  Code2,
  Command,
  DatabaseZap,
  Download,
  FileCode2,
  GitBranch,
  Layers3,
  Laptop,
  LockKeyhole,
  MonitorPlay,
  Network,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { Accordion, AccordionItem } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

const navItems = [
  ["Work", "#work"],
  ["System", "#system"],
  ["Pricing", "#pricing"],
  ["Download", "#download"],
] as const;

const metrics = [
  ["12", "bounded Claude execute turns"],
  ["4", "workspace surfaces in one shell"],
  ["0", "hidden Task fan-out by default"],
] as const;

const capabilities: Array<{ icon: LucideIcon; title: string; text: string }> = [
  {
    icon: Bot,
    title: "Agent sessions",
    text: "Run Codex, Claude, Ollama, and other model paths from one visible execution surface.",
  },
  {
    icon: DatabaseZap,
    title: "Project knowledge",
    text: "Index code, decisions, plans, and attachments so follow-up work starts with context.",
  },
  {
    icon: GitBranch,
    title: "Diff-aware delivery",
    text: "Watch files change, review patches, inspect branches, and keep the final report honest.",
  },
  {
    icon: MonitorPlay,
    title: "Preview review",
    text: "Route running pages, screenshots, console output, and layout evidence back into the work loop.",
  },
  {
    icon: Network,
    title: "Tool governance",
    text: "Keep reads, edits, terminals, approvals, and hook blocks on Atelier's observable tool layer.",
  },
  {
    icon: ShieldCheck,
    title: "Local-first control",
    text: "Keep workspace state and credentials close to the machine doing the actual engineering work.",
  },
];

const workItems = [
  {
    label: "Trace",
    title: "Read the owner path first",
    text: "Atelier pushes agent work toward concrete files, live handlers, and visible evidence before changes happen.",
  },
  {
    label: "Plan",
    title: "Keep the checklist alive",
    text: "Execution plans move from real edits and stay recoverable when a task is interrupted or continued later.",
  },
  {
    label: "Ship",
    title: "Finish with proof",
    text: "Validation, diffs, summaries, and remaining gaps stay attached to the task instead of disappearing into chat.",
  },
] as const;

const timeline = [
  ["Open workspace", "Files, git, terminal, knowledge, previews, and chat share one project frame."],
  ["Pick provider", "Use the model that fits the work without losing the same Atelier context."],
  ["Run task", "Tools stream in the rail while edits, terminal checks, and plans update live."],
  ["Review output", "The final state records changed files, validation, and unfinished work when any remains."],
] as const;

const plans = [
  {
    name: "Personal",
    price: "$0",
    note: "For local exploration and solo project work.",
    cta: "Download",
    featured: false,
    items: ["Local workspace shell", "Manual provider setup", "Files, git, terminal", "Basic plan tracking"],
  },
  {
    name: "Builder",
    price: "$12",
    note: "For developers using agents every week.",
    cta: "Start Builder",
    featured: true,
    items: ["Knowledge indexing", "Provider switching", "Review and validation loops", "Usage-aware Claude bounds"],
  },
  {
    name: "Studio",
    price: "$29",
    note: "For teams standardizing AI-assisted delivery.",
    cta: "Contact",
    featured: false,
    items: ["Shared project rules", "Release review workflow", "Session recovery", "Team-ready governance"],
  },
];

const downloads: { slug: string; icon: LucideIcon; label: string; note: string }[] = [
  { slug: "windows", icon: Laptop, label: "Windows", note: "Primary desktop build" },
  { slug: "macos", icon: Code2, label: "macOS", note: "Prepared for signed releases" },
  { slug: "linux", icon: TerminalSquare, label: "Linux", note: "For workstation setups" },
];

const stack = [
  "Next.js",
  "shadcn/ui",
  "Electron",
  "Codex",
  "Claude",
  "Ollama",
  "RAG",
  "Git",
  "Playwright",
  "Terminal",
];

export default function Page() {
  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground">
      <section className="relative isolate overflow-hidden bg-[#e7ebff]">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_78%_16%,rgba(255,138,61,0.22),transparent_26%),linear-gradient(135deg,#eef0ff_0%,#dfe5fb_48%,#f7f7ff_100%)]" />
        <nav className="section-wrap flex h-20 items-center justify-between gap-5">
          <a className="flex items-center gap-3" href="#" aria-label="Atelier home">
            <Image src="/atelier-icon.svg" alt="" width={38} height={38} priority />
            <span className="text-lg font-semibold">Atelier</span>
          </a>
          <div className="hidden items-center gap-7 text-sm font-medium text-foreground/68 md:flex">
            {navItems.map(([label, href]) => (
              <a className="transition hover:text-foreground" href={href} key={href}>
                {label}
              </a>
            ))}
          </div>
          <Button asChild size="sm">
            <a href="/download/windows">
              <Download className="h-4 w-4" />
              Download
            </a>
          </Button>
        </nav>

        <div className="section-wrap grid min-h-[calc(100svh-5rem)] items-center gap-12 pb-16 pt-8 lg:grid-cols-[0.88fr_1.12fr]">
          <div>
            <Badge variant="warm" className="mb-6">
              AI code editor portfolio
            </Badge>
            <h1 className="max-w-[11ch] text-6xl font-semibold leading-[0.92] tracking-normal text-[#141820] sm:text-7xl lg:text-8xl">
              Atelier
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-[#3f4b50]">
              A local-first AI code editor for developers who want agents, files,
              terminals, git, previews, and project memory in one controlled workspace.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <a href="/download/windows">
                  <ArrowDownToLine className="h-5 w-5" />
                  Download for Windows
                </a>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <a href="#work">
                  View workflow
                  <ChevronRight className="h-5 w-5" />
                </a>
              </Button>
            </div>
            <div className="mt-10 grid max-w-xl grid-cols-3 gap-3">
              {metrics.map(([value, label]) => (
                <div className="rounded-2xl border border-white/70 bg-white/52 p-4" key={label}>
                  <div className="text-2xl font-semibold text-[#224248]">{value}</div>
                  <div className="mt-1 text-xs leading-5 text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          </div>

          <EditorPortfolioMock />
        </div>
      </section>

      <section className="border-y border-border bg-white/46 py-5">
        <div className="section-wrap overflow-hidden">
          <div className="marquee-track flex w-max gap-4">
            {[...stack, ...stack].map((item, index) => (
              <span
                className="rounded-full border border-border bg-white/72 px-4 py-2 text-sm font-semibold text-foreground/68"
                key={`${item}-${index}`}
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section id="work" className="section-wrap py-24">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
          <div>
            <Badge>Portfolio of the product</Badge>
            <h2 className="mt-5 max-w-xl text-4xl font-semibold leading-tight tracking-normal sm:text-5xl">
              Built around the way real agent work should feel.
            </h2>
          </div>
          <p className="max-w-2xl text-base leading-8 text-muted-foreground lg:justify-self-end">
            Atelier is positioned as an editor, not a prompt box. The page shows
            the operating system of the product: context, plan, edit, verify, and
            report.
          </p>
        </div>
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {workItems.map((item, index) => (
            <Card className="rounded-3xl" key={item.title}>
              <CardHeader>
                <Badge variant={index === 2 ? "warm" : "outline"} className="w-fit">
                  {item.label}
                </Badge>
                <CardTitle className="text-2xl">{item.title}</CardTitle>
                <CardDescription>{item.text}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <section id="system" className="bg-[#f8f9ff] py-24">
        <div className="section-wrap grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <Card className="overflow-hidden rounded-[2rem] p-2">
            <Image
              src="/images/atelier-hero.png"
              alt="Atelier workspace preview"
              width={1536}
              height={1024}
              className="aspect-[1.35] h-full w-full rounded-[1.55rem] object-cover object-[62%_center]"
            />
          </Card>
          <div>
            <Badge variant="outline">System view</Badge>
            <h2 className="mt-5 text-4xl font-semibold leading-tight tracking-normal sm:text-5xl">
              Every surface has a job.
            </h2>
            <div className="mt-8 grid gap-4">
              {timeline.map(([title, text], index) => (
                <div className="flex gap-4" key={title}>
                  <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#224248] text-white">
                    <span className="text-xs font-semibold">{index + 1}</span>
                  </div>
                  <div>
                    <h3 className="font-semibold">{title}</h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="section-wrap py-24">
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="warm">Capabilities</Badge>
          <h2 className="mt-5 text-4xl font-semibold leading-tight tracking-normal sm:text-5xl">
            The editor shell around the agent.
          </h2>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            The feature set is intentionally practical: make agent output visible,
            recoverable, testable, and grounded in the workspace.
          </p>
        </div>
        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((feature) => (
            <Card key={feature.title} className="group rounded-3xl transition hover:-translate-y-1 hover:bg-white">
              <CardHeader>
                <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[#224248]/10 text-[#224248] transition group-hover:bg-[#ff8a3d]/18 group-hover:text-[#a84d12]">
                  <feature.icon className="h-5 w-5" />
                </div>
                <CardTitle>{feature.title}</CardTitle>
                <CardDescription>{feature.text}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <section className="bg-[#1b2528] py-24 text-white">
        <div className="section-wrap grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <Badge variant="warm" className="bg-white/10 text-white">
              Case study
            </Badge>
            <h2 className="mt-5 text-4xl font-semibold leading-tight tracking-normal sm:text-5xl">
              From request to reviewed change without losing the thread.
            </h2>
            <p className="mt-5 max-w-xl text-base leading-8 text-white/68">
              The product story is simple: reduce wasted model turns by keeping
              the plan, files, terminal proof, and final report in the same
              work surface.
            </p>
          </div>
          <Card className="rounded-3xl border-white/12 bg-white/8 text-white shadow-none">
            <CardContent className="p-6">
              <div className="grid gap-4">
                {[
                  ["user", "Build the landing page end to end."],
                  ["atelier", "Plan: rewrite hero, product mock, pricing, download, build."],
                  ["agent", "Edited 3 files, ran build, fixed layout regression."],
                  ["report", "Production build passed. Download route ready."],
                ].map(([role, line]) => (
                  <div className="rounded-2xl border border-white/10 bg-white/7 p-4" key={role}>
                    <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#ffb37e]">
                      {role}
                    </div>
                    <div className="mt-2 text-sm leading-6 text-white/82">{line}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section id="pricing" className="section-wrap py-24">
        <div className="mx-auto max-w-2xl text-center">
          <Badge variant="warm">Pricing</Badge>
          <h2 className="mt-5 text-4xl font-semibold leading-tight tracking-normal sm:text-5xl">
            A serious workspace, priced plainly.
          </h2>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            Start locally, then add the coordination layers when agents become
            part of your normal engineering cadence.
          </p>
        </div>
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {plans.map((plan) => (
            <Card
              key={plan.name}
              className={
                plan.featured
                  ? "relative rounded-3xl border-[#224248]/40 bg-[#224248] text-white shadow-[0_34px_90px_-45px_rgba(34,66,72,0.9)]"
                  : "rounded-3xl"
              }
            >
              <CardHeader>
                {plan.featured ? (
                  <Badge variant="warm" className="mb-2 w-fit bg-white/12 text-white">
                    Popular
                  </Badge>
                ) : null}
                <CardTitle className={plan.featured ? "text-white" : ""}>
                  {plan.name}
                </CardTitle>
                <div className="flex items-end gap-2">
                  <span className="text-5xl font-semibold">{plan.price}</span>
                  <span className={plan.featured ? "pb-2 text-white/62" : "pb-2 text-muted-foreground"}>
                    /mo
                  </span>
                </div>
                <CardDescription className={plan.featured ? "text-white/72" : ""}>
                  {plan.note}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Separator className={plan.featured ? "bg-white/16" : ""} />
                <ul className="mt-6 space-y-3">
                  {plan.items.map((item) => (
                    <li className="flex items-center gap-3 text-sm" key={item}>
                      <Check className={plan.featured ? "h-4 w-4 text-[#ffb37e]" : "h-4 w-4 text-[#224248]"} />
                      <span className={plan.featured ? "text-white/82" : "text-muted-foreground"}>{item}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  asChild
                  variant={plan.featured ? "secondary" : "outline"}
                  className="mt-8 w-full"
                >
                  <a href={plan.name === "Personal" ? "/download/windows" : "#download"}>
                    {plan.cta}
                  </a>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section id="download" className="bg-[#e7ebfb] py-24">
        <div className="section-wrap grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <Badge>Download</Badge>
            <h2 className="mt-5 max-w-xl text-4xl font-semibold leading-tight tracking-normal sm:text-5xl">
              Install the editor and open a real repo.
            </h2>
            <p className="mt-5 max-w-xl text-base leading-8 text-muted-foreground">
              The download routes are wired for release artifacts. The page is
              ready for packaging links when the signed builds are published.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {downloads.map(({ slug, icon: Icon, label, note }) => (
              <Card key={slug} className="rounded-3xl">
                <CardHeader>
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#224248]/10 text-[#224248]">
                    <Icon className="h-5 w-5" />
                  </div>
                  <CardTitle className="text-lg">{label}</CardTitle>
                  <CardDescription>{note}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button asChild className="w-full">
                    <a href={`/download/${slug}`}>
                      <Download className="h-4 w-4" />
                      Download
                    </a>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="section-wrap py-24">
        <div className="grid gap-10 lg:grid-cols-[0.75fr_1.25fr]">
          <div>
            <Badge variant="outline">FAQ</Badge>
            <h2 className="mt-5 text-4xl font-semibold tracking-normal">
              Practical answers.
            </h2>
          </div>
          <Accordion>
            <AccordionItem
              defaultOpen
              question="Is Atelier a portfolio site or the product?"
              answer="This page is the public portfolio for the Atelier product: it explains the AI code editor, shows the workspace, and routes people to pricing and downloads."
            />
            <AccordionItem
              question="Does it rely on shadcn/ui?"
              answer="Yes. Buttons, badges, cards, separators, and accordion rows are built through local shadcn-style primitives under src/components/ui."
            />
            <AccordionItem
              question="Can the download buttons serve real installers?"
              answer="Yes. The current Next route can be replaced with signed release artifact redirects or streamed files when the release host is final."
            />
          </Accordion>
        </div>
      </section>

      <footer className="border-t border-border bg-white/44 py-10">
        <div className="section-wrap grid gap-8 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <div className="flex items-center gap-3 text-foreground">
              <Image src="/atelier-icon.svg" alt="" width={30} height={30} />
              <span className="font-semibold">Atelier</span>
            </div>
            <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
              Local-first AI code editor for grounded, visible, recoverable agent work.
            </p>
          </div>
          <div className="flex flex-wrap gap-5 text-sm text-muted-foreground">
            {navItems.map(([label, href]) => (
              <a className="transition hover:text-foreground" href={href} key={href}>
                {label}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </main>
  );
}

function EditorPortfolioMock() {
  return (
    <Card className="relative overflow-hidden rounded-[2rem] border-white/80 bg-[#151b20] p-3 text-white shadow-[0_44px_110px_-54px_rgba(20,28,34,0.95)]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff6b57]" />
          <span className="h-3 w-3 rounded-full bg-[#ffbd4a]" />
          <span className="h-3 w-3 rounded-full bg-[#31d16d]" />
        </div>
        <div className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/56">
          atelier://portfolio
        </div>
      </div>

      <div className="grid min-h-[520px] gap-3 p-3 lg:grid-cols-[0.55fr_1fr]">
        <div className="space-y-3">
          <div className="rounded-2xl border border-white/10 bg-white/6 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Command className="h-4 w-4 text-[#ffb37e]" />
                Agents
              </div>
              <Badge variant="warm" className="bg-[#ff8a3d]/18 text-[#ffcfad]">
                live
              </Badge>
            </div>
            {[
              ["Codex", "editing", "bg-[#31d16d]"],
              ["Claude", "reviewing", "bg-[#ffbd4a]"],
              ["Ollama", "idle", "bg-white/28"],
            ].map(([name, state, color]) => (
              <div className="flex items-center justify-between border-t border-white/8 py-3 first:border-t-0" key={name}>
                <span className="text-sm text-white/86">{name}</span>
                <span className="flex items-center gap-2 text-xs text-white/50">
                  <span className={`h-2 w-2 rounded-full ${color}`} />
                  {state}
                </span>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/6 p-4">
            <div className="text-sm font-semibold">Execution plan</div>
            <div className="mt-4 space-y-3">
              {[
                ["done", "Read owner files"],
                ["done", "Patch sections"],
                ["run", "Build locally"],
                ["next", "Report evidence"],
              ].map(([state, item]) => (
                <div className="flex items-center gap-3 text-sm" key={item}>
                  <CircleDot className={state === "run" ? "h-4 w-4 text-[#ffb37e]" : "h-4 w-4 text-white/34"} />
                  <span className={state === "next" ? "text-white/46" : "text-white/82"}>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-3">
          <div className="rounded-2xl border border-white/10 bg-[#0f1418] p-4">
            <div className="mb-3 flex items-center justify-between text-xs text-white/48">
              <span>src/app/page.tsx</span>
              <span>portfolio</span>
            </div>
            <div className="font-mono text-xs leading-6 text-white/72">
              <div><span className="text-[#ffb37e]">const</span> editor = "Atelier";</div>
              <div><span className="text-[#7bdcff]">render</span>({"<Hero />"});</div>
              <div><span className="text-[#7bdcff]">render</span>({"<Capabilities />"});</div>
              <div><span className="text-[#7bdcff]">render</span>({"<Pricing />"});</div>
              <div><span className="text-[#31d16d]">return</span> verifiedBuild;</div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/6 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <FileCode2 className="h-4 w-4 text-[#ffb37e]" />
                Diff
              </div>
              <div className="mt-4 space-y-2 font-mono text-xs text-white/64">
                <div className="text-[#31d16d]">+ Product mock</div>
                <div className="text-[#31d16d]">+ Portfolio sections</div>
                <div className="text-[#31d16d]">+ Download cards</div>
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/6 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Braces className="h-4 w-4 text-[#ffb37e]" />
                Context
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-white/62">
                <span className="rounded-full bg-white/8 px-3 py-2">Next.js</span>
                <span className="rounded-full bg-white/8 px-3 py-2">shadcn</span>
                <span className="rounded-full bg-white/8 px-3 py-2">Agents</span>
                <span className="rounded-full bg-white/8 px-3 py-2">Desktop</span>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/6 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Layers3 className="h-4 w-4 text-[#ffb37e]" />
                Terminal
              </div>
              <span className="text-xs text-[#31d16d]">passed</span>
            </div>
            <div className="mt-3 font-mono text-xs leading-6 text-white/58">
              pnpm --filter @atelier/landing build
            </div>
          </div>
        </div>
      </div>
      <Sparkles className="absolute right-6 top-14 h-5 w-5 text-[#ffb37e]" />
    </Card>
  );
}
