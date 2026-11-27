/**
 * A text question whose default is a placeholder: the input starts empty with the default dim in it, Enter takes the
 * default, and typing replaces it, as create-next-app asks. effect/cli's `Prompt.String` types its default into the
 * input instead, so what a person types lands after it. Drawn in the column of Ui.ts, the line that stays like the
 * other prompts' (`✔ question … answer`).
 */
import { Data, Effect, Option, Terminal } from "effect"
import { Prompt } from "effect/cli"
import { CurrentUi, plain, symbols, type Ui } from "./Ui.ts"

export interface TextInputState {
  readonly value: string
  readonly cursor: number
  readonly error: string | undefined
}

const Action = Data.taggedEnum<Prompt.ActionDefinition>()

/** The question's line: the value, or the placeholder dim when there is none, and the error under it. */
export const textInputLines = (
  ui: Ui,
  message: string,
  placeholder: string,
  state: TextInputState
): { readonly lines: ReadonlyArray<string>; readonly column: number } => {
  const prefix = `${ui.command(symbols.ask)} ${ui.bold(message)} ${ui.dim(symbols.small)} `
  const input = state.value === "" ? ui.dim(placeholder) : state.value
  return {
    lines: [`${prefix}${input}`, ...(state.error === undefined ? [] : [`  ${ui.dim(symbols.small)} ${state.error}`])],
    // The cursor: at the start of the placeholder, or where it is in the value.
    column: plain(prefix).length + (state.value === "" ? 0 : state.cursor)
  }
}

/** What Enter submits: the value as typed, or the placeholder when nothing was. */
export const textInputAnswer = (value: string, placeholder: string) => (value === "" ? placeholder : value)

/** How many terminal rows `line` takes at `columns`. */
const rows = (line: string, columns: number) => Math.max(1, Math.ceil(plain(line).length / Math.max(1, columns)))

/** Whether `text` holds a control character (an escape, a newline): not text to put in the input. */
const hasControl = (text: string) => {
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

const step = (state: TextInputState, value: string, cursor: number) =>
  Effect.succeed(Action.NextFrame({ state: { value, cursor, error: undefined } }))

export const textInput = (options: {
  readonly message: string
  readonly placeholder: string
  readonly validate?: (value: string) => Effect.Effect<string, string>
}): Prompt.Prompt<string> => {
  const { message, placeholder } = options
  const validate = options.validate ?? Effect.succeed
  const draw = Effect.fnUntraced(function* (state: TextInputState) {
    const ui = yield* CurrentUi
    const columns = yield* (yield* Terminal.Terminal).columns
    const { lines, column } = textInputLines(ui, message, placeholder, state)
    return { ui, columns, lines, column }
  })
  return Prompt.Custom<TextInputState, string>(
    { value: "", cursor: 0, error: undefined },
    {
      render: (state, action) =>
        Action.$match(action, {
          Beep: () => Effect.succeed("\u0007"),
          NextFrame: ({ state: next }) =>
            Effect.map(draw(next), ({ columns, lines, column }) => {
              // Back from the end of what was drawn to the cursor: up over the error and the rows the line wrapped
              // onto past the cursor, then to its column.
              const [first = "", ...under] = lines
              const up =
                rows(first, columns) -
                1 -
                Math.floor(column / columns) +
                under.reduce((sum, line) => sum + rows(line, columns), 0)
              const back = `${up > 0 ? `\u001b[${up}A` : ""}\r${column % columns > 0 ? `\u001b[${column % columns}C` : ""}`
              return `${lines.join("\n")}${back}`
            }),
          Submit: ({ value }) =>
            Effect.map(
              draw(state),
              ({ ui }) => `${ui.done(`${ui.bold(message)} ${ui.dim(symbols.ellipsis)} ${value}`)}\n`
            )
        }),
      clear: (state) =>
        Effect.map(draw(state), ({ columns, lines, column }) => {
          // Down from the cursor to the last row drawn, then each row erased on the way up; an error wraps too.
          const total = lines.reduce((sum, line) => sum + rows(line, columns), 0)
          const below = total - 1 - Math.floor(column / columns)
          return `${below > 0 ? `\u001b[${below}B` : ""}${"\u001b[2K\u001b[1A".repeat(total - 1)}\u001b[2K\r`
        }),
      process: (input, state) => {
        const { value, cursor } = state
        if (input.key.ctrl) {
          switch (input.key.name) {
            case "u":
              return step(state, "", 0)
            case "a":
              return step(state, value, 0)
            case "e":
              return step(state, value, value.length)
            default:
              return Effect.succeed(Action.Beep())
          }
        }
        switch (input.key.name) {
          case "enter":
          case "return":
            return Effect.match(validate(textInputAnswer(value, placeholder)), {
              onFailure: (error) => Action.NextFrame({ state: { ...state, error } }),
              onSuccess: (answer) => Action.Submit({ value: answer })
            })
          case "backspace":
            return cursor === 0
              ? Effect.succeed(Action.Beep())
              : step(state, value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1)
          case "delete":
            return cursor >= value.length
              ? Effect.succeed(Action.Beep())
              : step(state, value.slice(0, cursor) + value.slice(cursor + 1), cursor)
          case "left":
            return cursor === 0 ? Effect.succeed(Action.Beep()) : step(state, value, cursor - 1)
          case "right":
            return cursor >= value.length ? Effect.succeed(Action.Beep()) : step(state, value, cursor + 1)
          case "home":
            return step(state, value, 0)
          case "end":
            return step(state, value, value.length)
          // Tab takes the placeholder into the input, to change a part of it.
          case "tab":
            return value === "" ? step(state, placeholder, placeholder.length) : Effect.succeed(Action.Beep())
          default: {
            const typed = Option.getOrElse(input.input, () => "")
            // Only printable text goes in: no escape sequences of keys this input does not use.
            if (typed === "" || hasControl(typed)) return Effect.succeed(Action.Beep())
            return step(state, value.slice(0, cursor) + typed + value.slice(cursor), cursor + typed.length)
          }
        }
      }
    }
  )
}
