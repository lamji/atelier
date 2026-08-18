import { cn } from "@/lib/cn";
import type {
  WorkspacePageBodyProps,
  WorkspacePageHeaderProps,
} from "./workspace-page.types";

export function WorkspacePageHeader(props: WorkspacePageHeaderProps) {
  const Icon = props.icon;

  return (
    <header className="shrink-0 px-6 pb-4 pt-5">
      <div
        className={cn(
          "mx-auto flex w-full flex-wrap items-start gap-3 sm:flex-nowrap sm:items-center",
          props.wide ? "max-w-[100rem]" : "max-w-6xl"
        )}
      >
        <span className="icon-tile h-11 w-11 rounded-2xl">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-tight">
              {props.title}
            </h1>
            {props.meta}
          </div>
          {props.description && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {props.description}
            </p>
          )}
        </div>
        {props.actions && (
          <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto">
            {props.actions}
          </div>
        )}
      </div>
    </header>
  );
}

export function WorkspacePageBody(props: WorkspacePageBodyProps) {
  return (
    <div
      className={cn(
        "w-full max-w-none",
        props.className
      )}
    >
      {props.children}
    </div>
  );
}
