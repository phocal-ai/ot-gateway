/**
 * Numbers on the page, in one convention whatever the browser's locale: the page is in English, so `en-US`
 * (1,500.25: comma groups, dot decimals), as `settings.ts` already writes. The browser's own locale would mix
 * `1.500` and `1.50` in one column in a German browser.
 */
const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 })
const fixed = new Map<number, Intl.NumberFormat>()

/**
 * `value` with thousands grouped: up to three decimals by default (1,234.5; 42), or exactly `decimals` of them when
 * given (1.50).
 */
export const formatNumber = (value: number, decimals?: number) => {
  if (decimals === undefined) return grouped.format(value)
  let format = fixed.get(decimals)
  if (format === undefined) {
    format = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    fixed.set(decimals, format)
  }
  return format.format(value)
}
