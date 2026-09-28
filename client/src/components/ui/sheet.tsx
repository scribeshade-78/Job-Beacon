import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "../../lib/utils";

/**
 * A right-hand slide-over, built on the same Radix Dialog primitive ui/dialog.tsx
 * uses so focus trapping, Escape-to-close, focus restoration to the trigger, and
 * the aria-modal wiring all come from one place rather than being re-implemented.
 *
 * FULL WIDTH BELOW sm, A FIXED PANEL ABOVE IT. On a phone the drawer is the whole
 * viewport, because a 440px panel on a 360px screen is a panel with a clipped
 * composer; at sm and up it settles to 440px at the right edge.
 *
 * The bottom padding is the safe-area inset so the composer clears a home
 * indicator rather than sitting under it.
 *
 * DELIBERATELY UNANIMATED. ui/dialog.tsx sets no enter/exit transition either,
 * and styles.css defines no keyframes to hang one on, so adding a slide
 * animation here would mean introducing an animation system for this one
 * surface.
 */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export const SheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-900/20 backdrop-blur-sm" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-y-0 right-0 z-50 flex w-full flex-col sm:w-[440px]",
        "border-l border-blue-100 bg-white text-slate-900 shadow-2xl focus:outline-none",
        "pb-[env(safe-area-inset-bottom)]",
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
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-base font-bold text-slate-900", className)}
    {...props}
  />
));
SheetTitle.displayName = "SheetTitle";

export const SheetDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-slate-500", className)}
    {...props}
  />
));
SheetDescription.displayName = "SheetDescription";

/** Visually hidden, for a Description that exists only to satisfy aria-describedby. */
export function VisuallyHidden({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("sr-only", className)} {...props} />;
}
