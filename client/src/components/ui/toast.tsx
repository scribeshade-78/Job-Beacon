import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { cn } from "../../lib/utils";

export const ToastProvider = ToastPrimitive.Provider;

export const ToastViewport = forwardRef<
  ElementRef<typeof ToastPrimitive.Viewport>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      "fixed bottom-0 right-0 z-50 flex w-full max-w-sm flex-col gap-2 p-4 sm:bottom-4 sm:right-4",
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = "ToastViewport";

export type ToastTone = "default" | "success" | "error";

const TONE_CLASSES: Record<ToastTone, string> = {
  default: "border-ios-separator",
  success: "border-status-verified",
  error: "border-status-blocked",
};

export interface ToastRootProps extends ComponentPropsWithoutRef<typeof ToastPrimitive.Root> {
  tone?: ToastTone;
}

export const Toast = forwardRef<ElementRef<typeof ToastPrimitive.Root>, ToastRootProps>(
  ({ className, tone = "default", ...props }, ref) => (
    <ToastPrimitive.Root
      ref={ref}
      className={cn(
        "rounded-card border-l-4 bg-ios-card p-4 shadow-card",
        "border-y border-r border-y-ios-separator border-r-ios-separator",
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    />
  ),
);
Toast.displayName = "Toast";

export const ToastTitle = forwardRef<
  ElementRef<typeof ToastPrimitive.Title>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Title ref={ref} className={cn("text-sm font-semibold text-black", className)} {...props} />
));
ToastTitle.displayName = "ToastTitle";

export const ToastDescription = forwardRef<
  ElementRef<typeof ToastPrimitive.Description>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Description
    ref={ref}
    className={cn("mt-1 text-sm text-ios-text-secondary", className)}
    {...props}
  />
));
ToastDescription.displayName = "ToastDescription";

export const ToastClose = forwardRef<
  ElementRef<typeof ToastPrimitive.Close>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    className={cn(
      "absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-ios-text-secondary hover:bg-ios-bg",
      className,
    )}
    aria-label="Dismiss"
    {...props}
  >
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  </ToastPrimitive.Close>
));
ToastClose.displayName = "ToastClose";
