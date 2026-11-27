/**
 * The point picker of `discover`: a list to tick, drawn in the column of Ui.ts. Each row is a point's name, its unit
 * and where it is, in aligned columns, the metadata dim; the keys are in a footer instead of "Select all" rows
 * among the points. Enter takes the ticked points and the line that stays says how many.
 *
 * Built on effect/cli's `Prompt.Custom`, so it runs like the other prompts (Ctrl-C quits, the same terminal).
 */
import { Data, Effect, Terminal } from "effect"
import { Prompt } from "effect/cli"
import { plain, symbols, type Ui } from "./Ui.ts"

export interface PickerRow<A> {
  readonly value: A
  /** The name, first and bold when focused. */
  readonly title: string
  /** The columns after the name (a unit, where the point is), dim and aligned. */
  readonly details: ReadonlyArray<string>
  readonly selected: boolean
}

export interface PickerState {
  readonly index: number
  readonly selected: ReadonlySet<number>
  /** The first row shown, when the list is longer than a page. */
  readonly top: number
  readonly error: string | undefined
}

/** The keys a picker takes, as its footer says them. */
export const pickerKeys = "↑↓ move · space toggle · a all or none · enter confirm"

const Action = Data.taggedEnum<Prompt.ActionDefinition>()

/** The window of rows to show: `index` in view, at most `page` rows. */
export const visibleRange = (index: number, top: number, total: number, page: number) => {
  const size = Math.min(page, total)
  const start = index < top ? index : index >= top + size ? index - size + 1 : top
  return { start: Math.max(0, Math.min(start, total - size)), end: Math.max(0, Math.min(start, total - size)) + size }
}

/** `text` cut to `width` columns of visible text, so a row never wraps and the frame can be cleared line by line. */
const fit = (text: string, width: number) => {
  if (plain(text).length <= width) return text
  // Rows are built from plain parts and styled per part; cutting the plain text and dropping the styles is safe.
  return `${plain(text).slice(0, Math.max(0, width - 1))}…`
}

/** The rows as text: the pointer, the checkbox, the name padded to the longest, then each detail column. */
export const pickerLines = <A>(
  ui: Ui,
  message: string,
  rows: ReadonlyArray<PickerRow<A>>,
  state: PickerState,
  options: { readonly page: number; readonly columns: number }
): ReadonlyArray<string> => {
  const { start, end } = visibleRange(state.index, state.top, rows.length, options.page)
  const titleWidth = Math.max(0, ...rows.map((row) => row.title.length))
  const detailWidths = rows.reduce<Array<number>>((widths, row) => {
    row.details.forEach((detail, column) => (widths[column] = Math.max(widths[column] ?? 0, detail.length)))
    return widths
  }, [])
  const width = Math.max(20, options.columns - 1)
  const lines = rows.slice(start, end).map((row, offset) => {
    const at = start + offset
    const focused = at === state.index
    const ticked = state.selected.has(at)
    const pointer = focused ? ui.command(symbols.pointer) : " "
    const box = ticked ? ui.command("◼") : ui.dim("◻")
    const title = row.title.padEnd(titleWidth)
    const details = row.details.map((detail, column) => detail.padEnd(detailWidths[column] ?? 0)).join("  ")
    const text = `${pointer} ${box} ${focused ? ui.bold(title) : title}  ${ui.dim(details.trimEnd())}`
    return plain(text).length > width ? fit(text, width) : text
  })
  const more = rows.length > end - start ? ui.dim(`  ${start + 1}-${end} of ${rows.length}`) : undefined
  return [
    `${ui.command(symbols.ask)} ${ui.bold(message)}`,
    ...lines,
    ...(more === undefined ? [] : [more]),
    state.error === undefined ? ui.dim(`  ${pickerKeys}`) : `  ${ui.dim(pickerKeys)}  ${state.error}`
  ]
}

/** What the line that stays says: how many of the rows were ticked. */
export const pickedSummary = (picked: number, total: number, noun: string) =>
  picked === total ? `all ${total} ${noun}` : `${picked} of ${total} ${noun}`

/** Erases `lines` lines, the cursor being on the last of them, and leaves it at the start of the first. */
const erase = (lines: number) => `${"\u001b[2K\u001b[1A".repeat(Math.max(0, lines - 1))}\u001b[2K\r`

/**
 * A list to tick: `rows` with their `selected` ticked first. `noun` names the rows in the line that stays
 * ("points"). None ticked is an answer too: the caller says what then.
 */
export const picker = <A>(
  ui: Ui,
  options: {
    readonly message: string
    readonly rows: ReadonlyArray<PickerRow<A>>
    readonly noun: string
    readonly page?: number
  }
): Prompt.Prompt<ReadonlyArray<A>> => {
  const { rows, message, noun } = options
  const page = options.page ?? 15
  const initial: PickerState = {
    index: 0,
    top: 0,
    error: undefined,
    selected: new Set(rows.flatMap((row, index) => (row.selected ? [index] : [])))
  }
  const frame = Effect.fnUntraced(function* (state: PickerState) {
    const terminal = yield* Terminal.Terminal
    return pickerLines(ui, message, rows, state, { page, columns: yield* terminal.columns })
  })
  const move = (state: PickerState, by: number) => {
    const index = (state.index + by + rows.length) % rows.length
    const { start } = visibleRange(index, state.top, rows.length, page)
    return Action.NextFrame({ state: { ...state, index, top: start, error: undefined } })
  }
  return Prompt.Custom<PickerState, ReadonlyArray<A>>(initial, {
    render: (state, action) =>
      Action.$match(action, {
        Beep: () => Effect.succeed("\u0007"),
        NextFrame: ({ state: next }) => Effect.map(frame(next), (lines) => `\u001b[?25l${lines.join("\n")}`),
        Submit: () =>
          Effect.succeed(
            `${ui.done(`${ui.bold(message)} ${ui.dim(symbols.ellipsis)} ${pickedSummary(state.selected.size, rows.length, noun)}`)}\n`
          )
      }),
    clear: (state) => Effect.map(frame(state), (lines) => erase(lines.length)),
    process: (input, state) => {
      switch (input.key.name) {
        case "up":
        case "k":
          return Effect.succeed(move(state, -1))
        case "down":
        case "j":
        case "tab":
          return Effect.succeed(move(state, 1))
        case "space": {
          const selected = new Set(state.selected)
          if (selected.has(state.index)) selected.delete(state.index)
          else selected.add(state.index)
          return Effect.succeed(Action.NextFrame({ state: { ...state, selected, error: undefined } }))
        }
        case "a": {
          const all = state.selected.size === rows.length
          const selected = new Set(all ? [] : rows.map((_, index) => index))
          return Effect.succeed(Action.NextFrame({ state: { ...state, selected, error: undefined } }))
        }
        case "enter":
        case "return": {
          const picked = rows.flatMap((row, index) => (state.selected.has(index) ? [row.value] : []))
          return Effect.succeed(Action.Submit({ value: picked }))
        }
        default:
          return Effect.succeed(Action.Beep())
      }
    }
  })
}
