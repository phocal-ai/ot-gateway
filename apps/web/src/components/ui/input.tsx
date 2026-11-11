import type * as React from "react"
import { cn } from "@/lib/utils"

/** shadcn/ui Input (new-york). */
export const Input = ({ className, type, ...props }: React.ComponentProps<"input">) => (
  <input
    type={type}
    data-slot="input"
    className={cn(
      "h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm",
      className
    )}
    {...props}
  />
)

/** A native select styled as the Input: one for a few fixed choices, and it works on every phone. */
export const NativeSelect = ({ className, ...props }: React.ComponentProps<"select">) => (
  <select
    data-slot="native-select"
    className={cn(
      "h-9 w-full min-w-0 rounded-md border bg-transparent px-2 py-1 text-base shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm",
      className
    )}
    {...props}
  />
)
