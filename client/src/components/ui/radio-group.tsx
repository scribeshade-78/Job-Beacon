import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "../../lib/utils";

/**
 * Shadcn-style wrapper over @radix-ui/react-radio-group, built to the same
 * conventions as the rest of client/src/components/ui/ (forwardRef +
 * ElementRef, className merged last via cn, no styling inventiveness).
 *
 * Deliberately does NOT restate a focus ring. styles.css already applies a
 * global `:focus-visible` 2px ios-blue outline to every focusable element
 * (MP-UI1's hard rule), so a local ring would be a second, driftable copy of
 * the same decision. The one thing it does restate is the RADIUS: that global
 * rule also sets border-radius: 4px, which is harmless on the square
 * controls it was written for but visibly deforms a circle on keyboard focus
 * — so the round shapes re-assert rounded-full and inherit everything else.
 *
 * Geometry and colors mirror the checkbox already used by ExclusionsPanel
 * (h-4 w-4, border-ios-separator, ios-blue-button when active) so the two
 * controls sit together as one family.
 */
export const RadioGroup = forwardRef<
  ElementRef<typeof RadioGroupPrimitive.Root>,
  ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn("grid gap-3", className)} {...props} />
));
RadioGroup.displayName = "RadioGroup";

export const RadioGroupItem = forwardRef<
  ElementRef<typeof RadioGroupPrimitive.Item>,
  ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border bg-ios-card",
      "transition-colors duration-150",
      "focus-visible:rounded-full",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "border-ios-separator data-[state=checked]:border-ios-blue-button",
      className,
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
      <span className="h-2 w-2 rounded-full bg-ios-blue-button" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = "RadioGroupItem";
