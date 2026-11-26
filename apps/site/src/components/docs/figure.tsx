/** What every diagram of the docs shares. */
import type * as React from "react"

/** The frame a diagram sits in; `not-prose` keeps the page's text styles out. */
export const Figure = ({ label, children }: { readonly label: string; readonly children: React.ReactNode }) => (
  <figure aria-label={label} className="viz not-prose my-6">
    {children}
  </figure>
)

/** A card's small heading. */
export const Eyebrow = ({ children }: { readonly children: React.ReactNode }) => (
  <p className="text-fd-muted-foreground text-xs font-medium tracking-wide uppercase">{children}</p>
)
