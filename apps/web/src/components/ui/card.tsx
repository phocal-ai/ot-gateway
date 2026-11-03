import type * as React from "react"
import { cn } from "@/lib/utils"

/** shadcn/ui Card (new-york). */
export const Card = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="card"
    className={cn("flex flex-col gap-4 rounded-xl border bg-card py-5 text-card-foreground shadow-sm", className)}
    {...props}
  />
)

export const CardHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="card-header" className={cn("grid auto-rows-min items-start gap-1.5 px-5", className)} {...props} />
)

export const CardTitle = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="card-title" className={cn("leading-none font-semibold", className)} {...props} />
)

export const CardDescription = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="card-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
)

export const CardContent = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="card-content" className={cn("px-5", className)} {...props} />
)
