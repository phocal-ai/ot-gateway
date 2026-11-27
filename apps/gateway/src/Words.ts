/**
 * How the CLI words counts and lists for a person, the same in every command: `1 device`, `3 devices`, `1,200 points`
 * (never `device(s)`), and a list of names cut after a few, `meter-1, meter-2, meter-3, meter-4, meter-5 and 10 more`.
 *
 * A site has 50 to 500 devices and thousands of points. In a terminal a command says how many, and names only what
 * needs a person (the failing devices, the first few); `--all` lists every one there. A pipe, `--json` and the MCP
 * tools get every one, as before: agents read all of it, people skim.
 */

/** How many names a line gives before it counts the rest. */
export const NAMED = 5

/** How many devices a terminal lists one by one before a command sums them up (`--all` lists every one). */
export const LISTED = 10

/** A count in the local digit grouping a person reads: `1,200`. */
export const count = (value: number) => value.toLocaleString("en-US")

/** `1 device`, `3 devices`, `1,200 points`; `many` for a noun that does not take an s (`1 address`, `2 addresses`). */
export const plural = (value: number, noun: string, many = `${noun}s`) => `${count(value)} ${value === 1 ? noun : many}`

/** The noun alone for a count: `device` for 1, `devices` otherwise. */
export const nounFor = (value: number, noun: string, many = `${noun}s`) => (value === 1 ? noun : many)

/** `a, b and c`; with more than `limit`, the first `limit` and `and 10 more`. */
export const named = (names: ReadonlyArray<string>, limit = NAMED) => {
  if (names.length <= limit) {
    return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`
  }
  return `${names.slice(0, limit).join(", ")} and ${count(names.length - limit)} more`
}

/** The first `limit` of `items`, and how many are left out. */
export const firstOf = <A>(items: ReadonlyArray<A>, limit = NAMED) => ({
  shown: items.slice(0, limit),
  more: Math.max(0, items.length - limit)
})
