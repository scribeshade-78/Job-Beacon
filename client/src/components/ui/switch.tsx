import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../../lib/utils";

/**
 * Shadcn-style wrapper over @radix-ui/react-switch, same conventions as the
 * rest of client/src/components/ui/.
 *
 * States use only tokens that already exist: ios-blue-button when on (the
 * same darkened fill the primary Button uses, so white-on-fill contrast is
 * the already-verified ~5.44:1 rather than the raw #007aff, which fails
 * 4.5:1 behind white text), ios-separator when off. The thumb is white with
 * shadow-control.
 *
 * As with RadioGroupItem, the focus ring itself is inherited from the global
 * :focus-visible rule in styles.css — only the radius is restated, because
 * that rule's border-radius: 4px would otherwise square off the pill on
 * keyboard focus.
 */
export const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
      "transition-colors duration-150",
      "focus-visible:rounded-full",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "bg-ios-separator data-[state=checked]:bg-ios-blue-button",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block h-5 w-5 rounded-full bg-ios-card shadow-control",
        "transition-transform duration-150",
        "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
