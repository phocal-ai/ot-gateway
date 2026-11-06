/**
 * The folder a gateway runs from with Docker Compose: `ot-gateway.json`, `compose.yaml` (packaging/compose.yaml,
 * which mounts that config and reads `ot-gateway.env`) and `ot-gateway.env`, the one place for what does not belong
 * in the config: the broker password (left empty for the operator, when the broker needs a login) and the
 * telemetry variables (commented out). `init` writes the last two next to the config.
 *
 * Neither file is ever replaced: a compose.yaml may have been edited, and an env file holds a secret. The env
 * file is created readable by its owner only, and nothing here reads it back.
 */
import type { GatewayConfig } from "@ot-gateway/core"
import { Effect, FileSystem, Path } from "effect"
import { fileURLToPath } from "node:url"

/** packaging/compose.yaml, as installed next to this app: in a checkout, the npm package and the image alike. */
export const composeTemplatePath = fileURLToPath(new URL("../../../packaging/compose.yaml", import.meta.url))

/** The config's name in the folder: compose.yaml mounts `./ot-gateway.json`. */
export const folderConfigName = "ot-gateway.json"

export interface FolderFiles {
  /** Files written now. */
  readonly written: ReadonlyArray<string>
  /** Files that were there already and were left as they are. */
  readonly kept: ReadonlyArray<string>
  /** Why compose.yaml was not written, when it was not. */
  readonly noCompose?: string | undefined
}

/**
 * The env file's text: the password variable, empty, when the broker needs a login, and the telemetry
 * variables commented out, so the operator finds where both go without reading the docs first.
 */
export const envFileText = (passwordEnv: string | undefined) =>
  [
    "# Secrets and settings for this gateway, kept out of ot-gateway.json. Docker Compose and ot-gateway read",
    "# this file; keep it yours alone (chmod 600) and out of git.",
    ...(passwordEnv === undefined ? [] : ["", "# The MQTT broker password.", `${passwordEnv}=`]),
    "",
    "# Telemetry: uncomment and fill in to send traces, metrics and logs over OTLP (observability/README.md).",
    "# OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com/otlp",
    "# OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<token>",
    "# OTEL_TRACES_EXPORTER=otlp",
    "# OTEL_METRICS_EXPORTER=otlp",
    "# OTEL_LOGS_EXPORTER=otlp",
    "# OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production",
    "# OTEL_TRACES_SAMPLER=traceidratio",
    "# OTEL_TRACES_SAMPLER_ARG=0.1",
    ""
  ].join("\n")

/**
 * Writes compose.yaml and ot-gateway.env next to the config at `configPath`. A dry run writes nothing and says
 * what it would write.
 */
export const writeFolderFiles = Effect.fn("writeFolderFiles")(function* (
  configPath: string,
  config: GatewayConfig,
  options: { readonly dryRun?: boolean } = {}
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const folder = path.dirname(configPath)
  const written: Array<string> = []
  const kept: Array<string> = []

  const create = Effect.fnUntraced(function* (file: string, text: string, mode: number) {
    if (yield* fs.exists(file)) return kept.push(file)
    if (options.dryRun !== true) yield* fs.writeFileString(file, text, { flag: "wx", mode })
    return written.push(file)
  })

  const noCompose =
    path.basename(configPath) === folderConfigName
      ? undefined
      : `compose.yaml runs ./${folderConfigName}; this config is ${path.basename(configPath)}`
  if (noCompose === undefined) {
    yield* create(path.join(folder, "compose.yaml"), yield* fs.readFileString(composeTemplatePath), 0o644)
  }
  yield* create(path.join(folder, "ot-gateway.env"), envFileText(config.mqtt.passwordEnv), 0o600)
  return { written, kept, noCompose } satisfies FolderFiles
})
