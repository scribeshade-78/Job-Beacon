import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "../../lib/utils";

/**
 * A right-hand slide-over, built on the same Radix Dialog primitive ui/dialog.tsx
 * uses so focus trapping, Escape-to-close, scroll locking and the aria-modal
 * wiring all come from one place rather than being re-implemented.
 *
 * DELIBERATELY UNANIMATED. ui/dialog.tsx sets no enter/exit transition either,
 * and styles.css defines no keyframes to hang one on, so adding a slide
 * animation here would mean introducing an animation system for this one
 * surface. The panel appears at the edge it belongs to; that is the whole
 * difference from DialogContent.
 */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export const SheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-y-0 right-0 z-50 flex w-[calc(100%-2rem)] max-w-md flex-col",
        "border-l border-ios-separator bg-ios-card shadow-card focus:outline-none",
        className,
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";

export const SheetTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-base font-semibold text-black", className)} {...props} />
));
SheetTitle.displayName = "SheetTitle";

export const SheetDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-ios-text-secondary", className)}
    {...props}
  />
));
SheetDescription.displayName = "SheetDescription";

/** Visually hidden, for a Description that exists only to satisfy aria-describedby. */
export function VisuallyHidden({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("sr-only", className)} {...props} />;
}
