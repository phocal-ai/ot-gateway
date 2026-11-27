/**
 * How `init` and `discover` look to a person at a terminal: one column. A symbol sits in the first two columns
 * (the prompts' own `?` and `✔`, and ours: `✔` done, `!` to do, `✖` failed), and every line of text starts in the
 * third, so the answers, what was found and what comes next line up under each other. Notes are dim, commands
 * cyan, as the prompts color their answers. Scripts and agents never see any of this: their output is unchanged.
 */
import { Console, Context, Effect, Fiber } from "effect"
import { Prompt } from "effect/cli"
import { stripVTControlCharacters } from "node:util"
import { WhoIsProgress, type WhoIsShown } from "./Discover.ts"

/** Whether to color: a terminal on stdout and no `NO_COLOR`, as the prompts decide. */
export const colorsWanted = (stdoutIsTTY: boolean | undefined, env: Readonly<Record<string, string | undefined>>) =>
  stdoutIsTTY === true && (env.NO_COLOR ?? "") === ""

const sgr = (on: boolean, open: number, close: number) => (text: string) =>
  on && text !== "" ? `\u001b[${open}m${text}\u001b[${close}m` : text

/** The symbols, the same in every line and in the prompts (`promptTheme`), whatever the platform. */
export const symbols = { done: "✔", todo: "!", failed: "✖", ask: "?", pointer: "❯", small: "›", ellipsis: "…" }

/** The text of `text` without its colors, to measure it. */
export const plain = (text: string) => stripVTControlCharacters(text)

/** `text` in lines of at most `width` columns, broken at spaces; a word longer than a line stays whole. */
export const wrap = (text: string, width: number): ReadonlyArray<string> => {
  if (width < 20 || plain(text).length <= width) return [text]
  const lines: Array<string> = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line !== "" && plain(line).length + 1 + plain(word).length > width) {
      lines.push(line)
      line = word
    } else line = line === "" ? word : `${line} ${word}`
  }
  return [...lines, line]
}

export type Ui = ReturnType<typeof makeUi>

/** The styles for a terminal `width` columns wide, colored or not; `live` draws spinners (stderr is a terminal). */
export const makeUi = (colors: boolean, width = 80, live = false) => {
  const bold = sgr(colors, 1, 22)
  const dim = sgr(colors, 2, 22)
  const green = sgr(colors, 32, 39)
  const yellow = sgr(colors, 33, 39)
  const red = sgr(colors, 31, 39)
  const cyan = sgr(colors, 36, 39)
  const text = Math.max(20, width - 2)
  /** A symbol, then `line` wrapped, each line in the text column. */
  const marked = (symbol: string, line: string, style: (text: string) => string = (same) => same) =>
    wrap(line, text)
      .map((part, index) => `${index === 0 ? symbol : " "} ${style(part)}`)
      .join("\n")
  return {
    colors,
    live,
    bold,
    dim,
    command: cyan,
    /** The first line: the command's name and the version. */
    header: (name: string, version: string) => `${bold(name)} ${dim(version)}\n`,
    done: (line: string) => marked(green(symbols.done), line),
    todo: (line: string) => marked(yellow(symbols.todo), line),
    failed: (line: string) => marked(red(symbols.failed), line),
    /** A dim line (or lines) in the text column: what happens, a hint. */
    note: (lines: string) =>
      lines
        .split("\n")
        .map((line) => (line.trim() === "" ? "" : marked(" ", line.trim(), dim)))
        .join("\n"),
    /** Text set in the text column as it is, a table for one (no wrapping). */
    indent: (lines: string) =>
      lines
        .split("\n")
        .map((line) => (line === "" ? "" : `  ${line}`))
        .join("\n"),
    /** Labels and values in two columns, the labels dim: what to run next. */
    rows: (pairs: ReadonlyArray<readonly [string, string]>) => {
      const labelWidth = Math.max(0, ...pairs.map(([label]) => label.length))
      return pairs.map(([label, value]) => `  ${dim(label.padEnd(labelWidth))}  ${value}`).join("\n")
    }
  }
}

/** The styles for this process: colors on a terminal, its width. */
export const terminalUi = () =>
  makeUi(colorsWanted(process.stdout.isTTY, process.env), process.stdout.columns ?? 80, process.stderr.isTTY)

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/**
 * `effect` with a spinner and `text` on stderr while it runs, the line erased when it ends; without a terminal,
 * `text` once as a note. A function as `text` is read on every frame, for progress ("52 of 254").
 */
export const spinning =
  (ui: Ui, text: string | (() => string)) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    ui.live
      ? Effect.gen(function* () {
          let frame = 0
          const draw = Effect.sync(() => {
            const line = typeof text === "string" ? text : text()
            process.stderr.write(`\r\u001b[2K${ui.command(frames[frame % frames.length] ?? "")} ${ui.dim(line)}`)
            frame += 1
          })
          const spinner = yield* Effect.forkChild(Effect.forever(Effect.andThen(draw, Effect.sleep("80 millis"))))
          return yield* effect.pipe(
            Effect.ensuring(
              Fiber.interrupt(spinner).pipe(Effect.andThen(Effect.sync(() => process.stderr.write("\r\u001b[2K"))))
            )
          )
        })
      : Console.error(ui.note(typeof text === "string" ? text : text())).pipe(Effect.andThen(effect))

/** Who-Is shown to a person: a spinner while it listens, then how many devices answered. */
const whoIsSpinner =
  (ui: Ui): WhoIsShown =>
  (target) =>
  (listen) =>
    spinning(
      ui,
      `Looking for BACnet devices (Who-Is to ${target})`
    )(listen).pipe(
      Effect.tap((devices) =>
        devices.length === 0
          ? Effect.void
          : Console.error(ui.done(`${devices.length} BACnet device${devices.length === 1 ? "" : "s"} answered`))
      )
    )

/** The `Ui` of the flow that runs: `inColumn` provides it, so a prompt deep inside draws in the same style. */
export const CurrentUi = Context.Reference<Ui>("@ot-gateway/gateway/CurrentUi", { defaultValue: () => terminalUi() })

/** A plain `Ui`, for tests and for text that may end up in a file. */
export const plainUi = makeUi(false, 1000)

/** The prompts' theme: the symbols above on every platform, so a prompt's line matches ours. */
export const promptTheme = (ui: Ui) =>
  Prompt.makeTheme({
    prefix: symbols.ask,
    tick: symbols.done,
    pointer: symbols.pointer,
    pointerSmall: symbols.small,
    ellipsis: symbols.ellipsis,
    descriptionSeparator: "· ",
    colors: ui.colors
  })

/** Whether a line is styled already: one of ours with a symbol, or colored. */
const styled = (line: string) =>
  line.startsWith("\u001b") || [symbols.done, symbols.todo, symbols.failed].some((symbol) => line.startsWith(symbol))

/**
 * The `Console` of a flow a person answers: what the steps say on stderr (discovery's progress, what was left out
 * and why) becomes dim notes in the text column, so it lines up with the prompts. stdout is left as it is.
 */
export const notesConsole =
  (ui: Ui) =>
  (base: Console.Console): Console.Console => ({
    assert: (condition, ...args) => base.assert(condition, ...args),
    clear: () => base.clear(),
    count: (label) => base.count(label),
    countReset: (label) => base.countReset(label),
    debug: (...args) => base.debug(...args),
    dir: (...args) => base.dir(...args),
    dirxml: (...args) => base.dirxml(...args),
    group: (...args) => base.group(...args),
    groupCollapsed: (...args) => base.groupCollapsed(...args),
    groupEnd: () => base.groupEnd(),
    info: (...args) => base.info(...args),
    log: (...args) => base.log(...args),
    table: (data) => base.table(data),
    time: (label) => base.time(label),
    timeEnd: (label) => base.timeEnd(label),
    timeLog: (label, ...args) => base.timeLog(label, ...args),
    trace: (...args) => base.trace(...args),
    warn: (...args) => base.warn(...args),
    error: (...args) =>
      base.error(
        args
          .map((arg) => (typeof arg === "string" ? arg : String(arg)))
          .join(" ")
          .split("\n")
          .map((line) => (styled(line) ? line : ui.note(line)))
          .join("\n")
      )
  })

/** `effect` with the prompts' theme and stderr's notes in the column of `ui`. */
export const inColumn =
  (ui: Ui) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.updateService(Console.Console, notesConsole(ui)),
      Effect.provideService(Prompt.Theme, promptTheme(ui)),
      Effect.provideService(CurrentUi, ui),
      Effect.provideService(WhoIsProgress, whoIsSpinner(ui))
    )
