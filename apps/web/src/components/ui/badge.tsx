import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

/** shadcn/ui Badge (new-york), with success and warning variants for device health. */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-white",
        success: "border-transparent bg-success text-white",
        warning: "border-transparent bg-warning text-black",
        outline: "text-foreground"
      }
    },
    defaultVariants: { variant: "default" }
  }
)

export const Badge = ({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) => (
  <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
)
