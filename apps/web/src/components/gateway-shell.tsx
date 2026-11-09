"use client"
/**
 * What every page shares and keeps across tab switches: the status poll and the header. It lives in the root
 * layout, which stays mounted while the pages change under it, so switching tabs neither restarts the poll (and
 * shows "Loading…" again) nor redraws the header without its subtitle and Live badge.
 */
import { usePathname } from "next/navigation"
import { createContext, type ReactNode, useContext, useEffect, useState } from "react"
import { type Load, useStatus } from "@/components/live"
import { type ListCount, PageHeader, pageOf } from "@/components/page-header"

const GatewayLoad = createContext<Load>({ _tag: "loading" })

/** The latest status poll, shared by every page. */
export const useGateway = () => useContext(GatewayLoad)

const CountSetter = createContext<(count: ListCount | undefined) => void>(() => undefined)

/**
 * The size of a page's list, for the header to show at the right of the tabs: "10,000 points", or "250 of 10,000
 * points" while `matching` (`undefined` when nothing is filtered). `total` is `undefined` until the list has come.
 * Arguments rather than one object, so the effect runs only when a number changes. Cleared when the page goes.
 */
export const useListCount = (total: number | undefined, matching: number | undefined, noun: ListCount["noun"]) => {
  const setCount = useContext(CountSetter)
  useEffect(() => {
    setCount(total === undefined ? undefined : { total, matching, noun })
    return () => setCount(undefined)
  }, [total, matching, noun, setCount])
}

export const GatewayShell = ({ children }: { readonly children: ReactNode }) => {
  const load = useStatus()
  const pathname = usePathname()
  const [count, setCount] = useState<ListCount | undefined>(undefined)
  return (
    <GatewayLoad.Provider value={load}>
      <CountSetter.Provider value={setCount}>
        <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-8">
          <PageHeader count={count} current={pageOf(pathname)} load={load} />
          {children}
        </main>
      </CountSetter.Provider>
    </GatewayLoad.Provider>
  )
}
