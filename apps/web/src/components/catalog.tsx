"use client"
/**
 * The point catalog (`/api/points`), shared by the Status and Points tabs. It changes only when the gateway
 * restarts, so it is asked for once per run of the gateway and kept across tab switches.
 */
import type { PointCatalog } from "@ot-gateway/api"
import { useEffect, useState } from "react"
import { fetchPoints, settle } from "@/lib/status"

/** Try again after this long when the catalog did not come. */
const RETRY_MS = 5000

export type CatalogLoad =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ok"; readonly catalog: PointCatalog }
  | { readonly _tag: "failed"; readonly message: string }

/**
 * The catalog once it came, and from which run of the gateway (its start time): it changes only when the gateway
 * restarts, so coming back to a page shows it at once, and a restart (perhaps with a new config) asks again.
 */
let cachedCatalog: { readonly since: number; readonly catalog: PointCatalog } | undefined

/** The catalog of the gateway that started at `since`, asked for until it comes once; nothing before the status says. */
export const useCatalog = (since: number | undefined) => {
  const cached = since !== undefined && cachedCatalog?.since === since ? cachedCatalog.catalog : undefined
  const [load, setLoad] = useState<CatalogLoad>(() =>
    cached === undefined ? { _tag: "loading" } : { _tag: "ok", catalog: cached }
  )
  useEffect(() => {
    if (since === undefined) return
    if (cachedCatalog?.since === since) return setLoad({ _tag: "ok", catalog: cachedCatalog.catalog })
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = () =>
      settle(fetchPoints).then((result) => {
        if (cancelled) return
        if (result._tag === "Success") {
          cachedCatalog = { since, catalog: result.success }
          return setLoad({ _tag: "ok", catalog: result.success })
        }
        setLoad({ _tag: "failed", message: result.failure.message })
        timer = setTimeout(() => void ask(), RETRY_MS)
      })
    void ask()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [since])
  return load
}
