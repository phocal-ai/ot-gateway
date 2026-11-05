/**
 * A picture of the gateway's status page, as HTML: what someone sees on the gateway when one device is
 * unreachable. The rows and reasons are the page's own (ok, failing with the driver's reason).
 */
import { CircleCheck, CircleX } from "lucide-react"

const rows = [
  { device: "main-meter", protocol: "Modbus TCP", ok: true, value: "active power 32.7 kW", seen: "2 s ago" },
  { device: "ahu-1", protocol: "BACnet/IP", ok: true, value: "supply air 21.4 °C", seen: "12 s ago" },
  { device: "ahu-2", protocol: "BACnet/IP", ok: false, value: "timeout: no answer", seen: "4 min ago" }
] as const

export const StatusMock = () => (
  <div className="viz bg-fd-card overflow-hidden rounded-xl border text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
      <span className="font-medium">vienna-hq / main</span>
      <span className="text-fd-muted-foreground flex items-center gap-1.5 text-xs">
        <CircleCheck className="size-4 text-[var(--status-good)]" /> broker connected · 0 waiting in the buffer
      </span>
    </div>
    <ul>
      {rows.map((row) => (
        <li
          className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b px-4 py-3 last:border-b-0"
          key={row.device}
        >
          {row.ok ? (
            <CircleCheck aria-hidden="true" className="size-4 text-[var(--status-good)]" />
          ) : (
            <CircleX aria-hidden="true" className="size-4 text-[var(--status-critical)]" />
          )}
          <span>
            <span className="font-medium">{row.device}</span>{" "}
            <span className="text-fd-muted-foreground">
              {row.ok ? "ok" : "failing"} · {row.protocol} · {row.value}
            </span>
          </span>
          <span className="text-fd-muted-foreground text-xs">read {row.seen}</span>
        </li>
      ))}
    </ul>
  </div>
)
