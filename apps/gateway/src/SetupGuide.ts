/**
 * The setup guide, for agents that have the CLI or the MCP server but not the repository: `.claude/skills/setup/
 * SKILL.md`, the steps from nothing to a running gateway. `ot-gateway guide setup` prints it, and `ot-gateway mcp`
 * serves it as the `setup` prompt and the `setup_guide` tool, so an agent set up through either gets the same steps
 * as Claude Code's `/setup`.
 *
 * The skill is the one text: the npm package and the image carry a copy as `guides/setup.md` next to the bundle
 * (scripts/build-package.sh, the Dockerfile), and a checkout reads the skill itself.
 */
import { Effect, FileSystem, Option, Schema } from "effect"
import { fileURLToPath } from "node:url"

/** Where the guide is: the copy an installation carries, then the skill in a checkout. */
export const setupGuidePaths = [
  fileURLToPath(new URL("../../../guides/setup.md", import.meta.url)),
  fileURLToPath(new URL("../../../.claude/skills/setup/SKILL.md", import.meta.url))
]

/** The guide could not be found next to this installation. */
export class SetupGuideMissing extends Schema.TaggedError<SetupGuideMissing>()("SetupGuideMissing", {
  message: Schema.String,
  code: Schema.Literal("guide-missing")
}) {}

/** The skill's text without its frontmatter (name and description, which say when Claude Code loads it). */
export const withoutFrontmatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n+/, "")

/**
 * What an agent reads first when the guide comes over MCP: the guide names CLI commands (`otg init`), and each of
 * them is a tool of the server it is talking to.
 */
export const mcpPreface = [
  "You are talking to the ot-gateway MCP server. The guide below names CLI commands as `otg <command>`: each one",
  "with --json is a tool of this server (otg init is the init tool, otg discover --save the discover_save tool,",
  "otg points allow-commands the points_allow_commands tool, otg start the start tool). Use the tools; where a step",
  "needs something no tool does (a shell command such as uname or docker compose version), run it only if you can,",
  "and otherwise ask the user. Steps about the repository checkout or `pnpm` do not apply.",
  ""
].join("\n")

/**
 * The guide's text, read from this installation. Only a missing file moves on to the next place: one that is there
 * but cannot be read fails with its own error.
 */
export const readSetupGuide = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  for (const path of setupGuidePaths) {
    const text = yield* fs.readFileString(path).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone)
    )
    if (Option.isSome(text)) return withoutFrontmatter(text.value)
  }
  return yield* new SetupGuideMissing({
    code: "guide-missing",
    message: `the setup guide is not part of this installation (looked for ${setupGuidePaths.join(", ")})`
  })
})
