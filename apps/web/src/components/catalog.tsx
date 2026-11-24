"use client"
/**
 * The point catalog (`/api/points`), shared by the Status and Points tabs. It changes only when the config does
 * (a restart, or a save on the Settings tab), so it is asked for once per config and kept across tab switches.
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
 * The catalog once it came, and for which config (`configSince` in the status): it changes only with the config,
 * so coming back to a page shows it at once, and a new config (a restart, a save) asks again.
 */
let cachedCatalog: { readonly since: number; readonly catalog: PointCatalog } | undefined

/** The catalog of the config that started at `since`, asked for until it comes once; nothing before the status says. */
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
