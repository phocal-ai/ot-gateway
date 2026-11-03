/**
 * How the gateway process exits. `NodeRuntime.runMain` interrupts the main
 * fiber on SIGINT and SIGTERM, and Effect's default teardown turns an
 * interrupted program into exit code 130, which a service manager such as
 * systemd records as a failure. For the gateway, being told to stop is the
 * normal way to stop: once every scope has closed (devices, BACnet socket,
 * the broker's `offline` message), that is exit code 0. Anything else (a
 * failure or a defect) keeps the default code.
 */
import { Cause, Exit, Runtime } from "effect"

export const gatewayTeardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return onExit(0)
  return Runtime.defaultTeardown(exit, onExit)
}
