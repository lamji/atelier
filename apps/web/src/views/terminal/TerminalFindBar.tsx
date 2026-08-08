import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CaseSensitive, Regex, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  terminalRegistry,
  type TerminalSearchOptions,
} from "@/services/terminal-registry";

export interface TerminalFindBarProps {
  termId: string;
  onClose: () => void;
}

/** Long enough that typing does not re-scan the scrollback per keystroke. */
const FIND_DEBOUNCE_MS = 120;

/**
 * Ctrl+F find bar for the terminal, floating over the top-right of the
 * output the way VS Code's does. Enter walks matches forward, Shift+Enter
 * back, Escape closes and hands focus to the terminal.
 */
export function TerminalFindBar(props: TerminalFindBarProps) {
  const { termId, onClose } = props;
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<TerminalSearchOptions>({});
  const [results, setResults] = useState({ index: -1, count: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [termId]);

  useEffect(
    () => terminalRegistry.subscribeResults(termId, setResults),
    [termId]
  );

  // Incremental search: the first match is found as you type, without
  // walking the whole scrollback on every character.
  useEffect(() => {
    if (!query) {
      terminalRegistry.clearFind(termId);
      setResults({ index: -1, count: 0 });
      return;
    }
    const timer = setTimeout(() => {
      terminalRegistry.find(termId, query, { ...options, incremental: true });
    }, FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, options, termId]);

  const step = (back: boolean) => {
    if (query) terminalRegistry.find(termId, query, options, back);
  };

  const close = () => {
    terminalRegistry.clearFind(termId);
    onClose();
    terminalRegistry.focus(termId);
  };

  const toggle = (key: keyof TerminalSearchOptions) =>
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));

  const label =
    results.count === 0
      ? query
        ? "No results"
        : ""
      : `${results.index + 1} of ${results.count}`;

  return (
    <div
      className={cn(
        "island absolute right-3 top-1 z-20 flex items-center gap-1",
        "px-1.5 py-1 shadow-lg"
      )}
    >
      <input
        ref={inputRef}
        value={query}
        placeholder="Find"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        className={cn(
          "h-6 w-40 rounded-sm border border-border bg-input/60 px-1.5",
          "text-xs outline-none focus:border-primary/60"
        )}
      />
      <span className="w-16 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">
        {label}
      </span>
      <FindToggle
        title="Match Case"
        active={!!options.caseSensitive}
        onClick={() => toggle("caseSensitive")}
      >
        <CaseSensitive className="h-3.5 w-3.5" />
      </FindToggle>
      <FindToggle
        title="Match Whole Word"
        active={!!options.wholeWord}
        onClick={() => toggle("wholeWord")}
      >
        <span className="text-[11px] font-semibold leading-none">ab</span>
      </FindToggle>
      <FindToggle
        title="Use Regular Expression"
        active={!!options.regex}
        onClick={() => toggle("regex")}
      >
        <Regex className="h-3.5 w-3.5" />
      </FindToggle>
      <FindToggle title="Previous Match" onClick={() => step(true)}>
        <ArrowUp className="h-3.5 w-3.5" />
      </FindToggle>
      <FindToggle title="Next Match" onClick={() => step(false)}>
        <ArrowDown className="h-3.5 w-3.5" />
      </FindToggle>
      <FindToggle title="Close (Escape)" onClick={close}>
        <X className="h-3.5 w-3.5" />
      </FindToggle>
    </div>
  );
}

function FindToggle(props: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-sm",
        props.active
          ? "bg-primary/20 text-primary"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      )}
    >
      {props.children}
    </button>
  );
}
