import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface WorkspacePageHeaderProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
  /** Lets conversation-first pages use the window without widening every view. */
  wide?: boolean;
}

export interface WorkspacePageBodyProps {
  children: ReactNode;
  className?: string;
  wide?: boolean;
}
