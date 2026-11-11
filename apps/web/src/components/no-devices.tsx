/**
 * What a gateway without devices shows instead of an empty list: what to do next, with an AI agent or by hand.
 * Both end in the standard points list (docs/first-building.md).
 */
const Command = ({ children }: { readonly children: string }) => (
  <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">{children}</pre>
)

export const NoDevicesYet = () => (
  <div className="flex max-w-2xl flex-col gap-3 text-sm text-muted-foreground">
    <div className="flex flex-col gap-1">
      <h2 className="font-semibold text-foreground">No devices yet</h2>
      <p>The gateway runs, but its config has no devices to read. Add them with a points list, one row per value.</p>
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
