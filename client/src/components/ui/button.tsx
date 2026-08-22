import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost";
export type ButtonSize = "default" | "sm" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Decision B: solid button fills use darkened, button-only tokens
  // (measured ≥4.5:1 with white text — see styles.css) instead of the
  // literal brand colors, which stay on links/icons/focus rings.
  primary:
    "bg-ios-blue-button text-white hover:bg-[#0055b0] active:bg-[#004796] disabled:bg-ios-blue-button/40",
  secondary:
    "bg-ios-bg text-black border border-ios-separator hover:bg-[#e8e8ed] active:bg-[#dedee3] disabled:opacity-50",
  destructive:
    "bg-status-blocked-fg text-white hover:bg-[#b72219] active:bg-[#991b13] disabled:bg-status-blocked-fg/40",
  ghost:
    "bg-transparent text-ios-blue hover:bg-ios-blue/10 active:bg-ios-blue/15 disabled:opacity-40",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  default: "h-11 min-w-11 px-5 text-[15px]",
  sm: "h-9 min-w-9 px-3.5 text-sm",
  icon: "h-11 w-11",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "default", type = "button", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-control font-semibold",
          "transition-colors duration-150 disabled:cursor-not-allowed",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
