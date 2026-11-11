/**
 * What a gateway without devices shows instead of an empty list: what to do next, in this page, with an AI agent or
 * by hand. All of them end in the same config (docs/first-building.md); the Settings tab says when this page may not
 * edit, and why.
 */
import Link from "next/link"

const Command = ({ children }: { readonly children: string }) => (
  <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">{children}</pre>
)

const action =
  "inline-flex h-8 items-center rounded-md border bg-background px-3 text-sm font-medium text-foreground shadow-xs hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"

export const NoDevicesYet = () => (
  <div className="flex max-w-2xl flex-col gap-3 text-sm text-muted-foreground">
    <div className="flex flex-col gap-1">
      <h2 className="font-semibold text-foreground">No devices yet</h2>
      <p>The gateway runs, but its config has no devices to read.</p>
    </div>
    <div className="flex flex-col gap-2">
      <h3 className="font-medium text-foreground">In this page</h3>
      <p>Add a device and test it, or upload a points list or an EDE file.</p>
      <div className="flex flex-wrap gap-2">
        <Link className={action} href="/settings/?add=modbus-tcp">
          Add Modbus device
        </Link>
        <Link className={action} href="/settings/?add=bacnet-ip">
          Add BACnet device
        </Link>
        <Link className={action} href="/settings/?upload=1">
          Upload a points list
        </Link>
      </div>
    </div>
    <div className="flex flex-col gap-1">
      <h3 className="font-medium text-foreground">With an AI agent</h3>
      <p>
        Ask a coding agent to set up OT Gateway with <code className="font-mono text-foreground">npx ot-gateway</code>.
        It finds BACnet devices or reads your EDE file or datasheets, writes the points list and imports it.
      </p>
    </div>
    <div className="flex flex-col gap-1">
      <h3 className="font-medium text-foreground">By hand</h3>
      <p>Write a list to fill in, one row per value:</p>
      <Command>ot-gateway points template &gt; points.csv</Command>
      <p>Then add it to the config and restart the gateway:</p>
      <Command>ot-gateway import points.csv</Command>
    </div>
  </div>
)
