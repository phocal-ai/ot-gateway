/**
 * How the user ran the CLI, so the next commands it prints can be run as printed: `pnpm ot-gateway` in a checkout
 * (the root package.json's `ot-gateway` script), `npx ot-gateway` through npx, and `ot-gateway` otherwise (the npm
 * package installed globally, or the Docker wrapper). Read from the variables a package manager sets for the
 * process it starts; nothing else is known about the shell, so anything unrecognised is `ot-gateway`.
 */
import { Config, Option } from "effect"

/** The variables package managers set for a script or `npx`. */
export interface InvocationEnvironment {
  /** The script's name (`ot-gateway`), or `npx` for npx. */
  readonly npm_lifecycle_event?: string | undefined
  /** The package manager's own entry point (`…/pnpm.cjs`, `…/npm-cli.js`). */
  readonly npm_execpath?: string | undefined
  /** `pnpm/10.28.0 npm/? node/v24…`: the package manager first. */
  readonly npm_config_user_agent?: string | undefined
  /** npm's own command: `exec` for npx, `run-script` for a script. */
  readonly npm_command?: string | undefined
}

/** The command that ran the CLI, as a prefix for the commands it prints: `pnpm ot-gateway`, or `ot-gateway`. */
export const cliCommand = (env: InvocationEnvironment): string => {
  if (env.npm_lifecycle_event === "ot-gateway") {
    const manager = `${env.npm_config_user_agent ?? ""} ${env.npm_execpath ?? ""}`
    if (/(^|[/\s])pnpm/.test(manager)) return "pnpm ot-gateway"
    if (/(^|[/\s])yarn/.test(manager)) return "yarn ot-gateway"
    // npm passes flags after `--` on to the script.
    return "npm run ot-gateway --"
  }
  if (env.npm_lifecycle_event === "npx" || env.npm_command === "exec") return "npx ot-gateway"
  return "ot-gateway"
}

const optionalEnv = (name: string) => Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined))

/** `cliCommand` of the process's environment. */
export const invocation = Config.all({
  npm_lifecycle_event: optionalEnv("npm_lifecycle_event"),
  npm_execpath: optionalEnv("npm_execpath"),
  npm_config_user_agent: optionalEnv("npm_config_user_agent"),
  npm_command: optionalEnv("npm_command")
}).pipe(Config.map(cliCommand))
