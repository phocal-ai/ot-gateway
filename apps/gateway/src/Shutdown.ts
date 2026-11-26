/**
 * How the gateway process exits. `NodeRuntime.runMain` interrupts the main
 * fiber on SIGINT and SIGTERM, and Effect's default teardown turns an
 * interrupted program into exit code 130, which a service manager such as
 * systemd records as a failure. For the gateway, being told to stop is the
 * normal way to stop: once every scope has closed (devices, BACnet socket,
 * the broker's `offline` message), that is exit code 0. A usage mistake
 * (an unknown command or flag, or a command run without the answers it
 * needs) is 2, so a script or an agent can tell it
 * from a failed run. Anything else (a failure or a defect) keeps the
 * default code, 1.
 */
import { Cause, Exit, Result, Runtime } from "effect"
import { exitsAsUsage, USAGE_EXIT_CODE } from "./Output.ts"

export const gatewayTeardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return onExit(0)
  if (Exit.isFailure(exit)) {
    const error = Cause.findError(exit.cause)
    if (Result.isSuccess(error) && exitsAsUsage(error.success)) {
      return onExit(USAGE_EXIT_CODE)
    }
  }
  return Runtime.defaultTeardown(exit, onExit)
}
