"use client"
/**
 * The running config (`/api/config`) for the device panel's addresses. Like the catalog, it changes only when the
 * gateway restarts, so it is asked for once per run of the gateway (its start time) and kept across tab switches.
 */
import type { ConfigView } from "@ot-gateway/api"
import { useEffect, useState } from "react"
import { fetchConfig, settle } from "@/lib/status"

/** Try again after this long when the config did not come. */
const RETRY_MS = 5000

let cachedConfig: { readonly since: number; readonly config: ConfigView } | undefined

/** The config of the gateway that started at `since`; undefined until it came, or before the status says. */
export const useRunningConfig = (since: number | undefined) => {
  const [config, setConfig] = useState<ConfigView | undefined>(() =>
    since !== undefined && cachedConfig?.since === since ? cachedConfig.config : undefined
  )
  useEffect(() => {
    if (since === undefined) return
    if (cachedConfig?.since === since) return setConfig(cachedConfig.config)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = () =>
      settle(fetchConfig).then((result) => {
        if (cancelled) return
        if (result._tag === "Success") {
          cachedConfig = { since, config: result.success }
          return setConfig(result.success)
        }
        timer = setTimeout(() => void ask(), RETRY_MS)
      })
    void ask()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [since])
  return config
}
