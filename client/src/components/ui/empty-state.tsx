import type { ComponentType } from "react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  className?: string;
}

/**
 * Honest "not built yet" / "nothing here yet" placeholder — never a
 * fabricated 0 or count. Used for Overview's unwired stats/recent list
 * and for pages with no backing feature yet (Target Roles, Opportunities).
 */
export function EmptyState({ icon: Icon, title, description, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-2 py-10 text-center", className)}>
      <Icon className="h-8 w-8 text-ios-text-secondary" />
      <p className="text-[15px] font-medium text-black">{title}</p>
      {description && <p className="max-w-sm text-sm text-ios-text-secondary">{description}</p>}
    </div>
  );
}
