import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-11 w-full rounded-control border bg-ios-card px-3.5 text-[15px] text-black",
        "placeholder:text-ios-text-secondary",
        "transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        invalid
          ? "border-status-blocked-fg focus-visible:border-status-blocked-fg"
          : "border-ios-separator focus-visible:border-ios-blue",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
