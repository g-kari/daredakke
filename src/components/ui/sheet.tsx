"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as StaticSheetPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// The application mounts Sheet only on compact/mobile layouts. Keep the native
// Radix implementation for a whole open session if loading has not finished.
// Never swap a live modal: doing so would lose focus, scroll and nested state.
type SheetParts = { [K in 'Root' | 'Trigger' | 'Close' | 'Portal' | 'Overlay' | 'Content' | 'Title' | 'Description']: React.ComponentType<React.ComponentProps<(typeof StaticSheetPrimitive)[K]>> }
const SheetPrimitiveContext = React.createContext<SheetParts>(StaticSheetPrimitive)
function Sheet({ ...props }: React.ComponentProps<typeof StaticSheetPrimitive.Root>) {
  const [loaded, setLoaded] = React.useState<SheetParts | null>(null)
  const [active, setActive] = React.useState<SheetParts>(StaticSheetPrimitive)
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(props.defaultOpen ?? false)
  const open = props.open ?? uncontrolledOpen
  React.useEffect(() => {
    let current = true
    import("@animate-ui/react/primitives/radix-ui/dialog")
      .then(module => { if (current) setLoaded(module.Dialog) })
      .catch(() => { /* Native Radix remains usable if the optional chunk fails. */ })
    return () => { current = false }
  }, [])
  React.useEffect(() => {
    if (!open && loaded) setActive(loaded)
  }, [open, loaded])
  return <SheetPrimitiveContext.Provider value={active}>
    <active.Root data-slot="sheet" {...props} open={open} onOpenChange={next => {
      setUncontrolledOpen(next)
      props.onOpenChange?.(next)
    }} />
  </SheetPrimitiveContext.Provider>
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof StaticSheetPrimitive.Trigger>) {
  const SheetPrimitive = React.useContext(SheetPrimitiveContext)
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof StaticSheetPrimitive.Close>) {
  const SheetPrimitive = React.useContext(SheetPrimitiveContext)
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof StaticSheetPrimitive.Portal>) {
  const SheetPrimitive = React.useContext(SheetPrimitiveContext)
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof StaticSheetPrimitive.Overlay>) {
  const SheetPrimitive = React.useContext(SheetPrimitiveContext)
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof StaticSheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  const SheetPrimitive = React.useContext(SheetPrimitiveContext)
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        data-animation-source={SheetPrimitive === StaticSheetPrimitive ? "native" : "animate-ui"}
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-background shadow-lg",
          side === "right" &&
            "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
          side === "left" &&
            "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
          side === "top" &&
            "inset-x-0 top-0 h-auto border-b",
          side === "bottom" &&
            "inset-x-0 bottom-0 h-auto border-t",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-secondary">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof StaticSheetPrimitive.Title>) {
  const SheetPrimitive = React.useContext(SheetPrimitiveContext)
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof StaticSheetPrimitive.Description>) {
  const SheetPrimitive = React.useContext(SheetPrimitiveContext)
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
