import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Badge = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
        className,
      )}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";
