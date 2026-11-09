import type * as React from "react"
import { cn } from "@/lib/utils"

/** shadcn/ui Table (new-york). */
/**
 * `containerClassName` replaces the container's horizontal scrolling, for a table whose header sticks to the
 * window: a scrolling container would hold it instead.
 */
export const Table = ({
  className,
  containerClassName = "overflow-x-auto",
  ...props
}: React.ComponentProps<"table"> & { readonly containerClassName?: string }) => (
  <div data-slot="table-container" className={cn("relative w-full", containerClassName)}>
    <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
  </div>
)

export const TableHeader = ({ className, ...props }: React.ComponentProps<"thead">) => (
  <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />
)

export const TableBody = ({ className, ...props }: React.ComponentProps<"tbody">) => (
  <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />
)

export const TableRow = ({ className, ...props }: React.ComponentProps<"tr">) => (
  <tr data-slot="table-row" className={cn("border-b transition-colors hover:bg-muted/50", className)} {...props} />
)

export const TableHead = ({ className, ...props }: React.ComponentProps<"th">) => (
  <th
    data-slot="table-head"
    className={cn("h-9 px-2 text-left align-middle font-medium whitespace-nowrap text-muted-foreground", className)}
    {...props}
  />
)

export const TableCell = ({ className, ...props }: React.ComponentProps<"td">) => (
  <td data-slot="table-cell" className={cn("p-2 align-middle whitespace-nowrap", className)} {...props} />
)
