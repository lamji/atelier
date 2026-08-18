"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface AccordionItemProps {
  question: string;
  answer: string;
  defaultOpen?: boolean;
}

export function AccordionItem({
  question,
  answer,
  defaultOpen,
}: AccordionItemProps) {
  return (
    <details
      className="group border-b border-border py-5 last:border-b-0"
      open={defaultOpen}
    >
      <summary className="flex list-none items-center justify-between gap-4 text-left text-base font-semibold text-foreground">
        <span>{question}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{answer}</p>
    </details>
  );
}

export function Accordion({
  className,
  children,
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("divide-y-0", className)}>{children}</div>;
}
