import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "../../lib/utils";

/**
 * Shadcn-style wrapper over @radix-ui/react-popover, same conventions as
 * ui/dialog.tsx and ui/dropdown-menu.tsx (forwardRef + ElementRef, className
 * merged last via cn, portal-rendered content).
 *
 * Popover rather than the already-installed DropdownMenu because these
 * filters are multi-select: the menu wrapper in this folder exposes only
 * Root/Trigger/Content/Item/Separator, with no CheckboxItem or RadioItem, so
 * it cannot express "this option is currently on" without inventing that
 * behaviour here. Popover keeps the selection state in the trigger's own
 * component, where the filter state already lives.
 *
 * The surface intentionally matches DialogContent (rounded-card,
 * border-ios-separator, bg-ios-card, shadow-card) so a popover and a dialog
 * read as the same material. No enter/exit animation for the same reason
 * dialog.tsx has none — the design language is not animated.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-56 rounded-card border border-ios-separator bg-ios-card p-2 shadow-card focus:outline-none",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";
