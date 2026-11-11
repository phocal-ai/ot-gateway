/**
 * Who may change the gateway through its status page. Every request that is not a GET or HEAD (a check, a save,
 * whatever later stages add) passes these rules before any handler sees it:
 *
 * - **Same origin.** The `Origin` header must be there and name the host the request was sent to (`Host`). A browser
 *   always sends it with a POST or PUT, and a page on another site cannot fake it.
 * - **A custom header**, `X-OT-Gateway: 1`. A cross-site page can only send one after a CORS preflight, which this
 *   server never grants, so even a browser that left `Origin` out could not get a write through.
 * - **Loopback, or a token.** Bound to 127.0.0.1 (the default), the page is reached through SSH or on the machine
 *   itself, and the rules above are enough. Bound to the LAN, editing is off unless `OT_GATEWAY_EDIT_TOKEN` is set,
 *   and then every write must carry it as `Authorization: Bearer <token>`.
 *
 * The status server's Host check (DNS rebinding) runs before these, as for every request.
 */
import { EDIT_HEADER, EDIT_HEADER_VALUE } from "@ot-gateway/api"
import { Config, Option, Redacted } from "effect"
import { createHash, timingSafeEqual } from "node:crypto"

/** The variable that turns editing on for a status page bound to the LAN, and the secret it then needs. */
export const EDIT_TOKEN_VARIABLE = "OT_GATEWAY_EDIT_TOKEN"

/** `OT_GATEWAY_EDIT_TOKEN`, when it is set and not empty. */
export const editToken = Config.Redacted(EDIT_TOKEN_VARIABLE).pipe(
  Config.option,
  Config.map(Option.filter((token) => Redacted.value(token) !== ""))
)

/** Loopback addresses a page served on this machine is reached at. */
export const isLoopbackAddress = (address: string) =>
  address === "localhost" || address === "::1" || address.startsWith("127.")

/** Whether the status page's bind address lets it edit, and how a write proves it may. */
export type EditAccess =
  | { readonly allowed: true; readonly auth: "none" | "token" }
  | { readonly allowed: false; readonly reason: string; readonly fix: string }

export const editAccess = (bindAddress: string, token: Option.Option<Redacted.Redacted>): EditAccess => {
  if (Option.isSome(token)) return { allowed: true, auth: "token" }
  if (isLoopbackAddress(bindAddress)) return { allowed: true, auth: "none" }
  return {
    allowed: false,
    reason: `The status page listens on ${bindAddress}, so anyone on the network can open it, and editing is off without a token.`,
    fix: `Set ${EDIT_TOKEN_VARIABLE} in ot-gateway.env to a long random secret (openssl rand -hex 32) and restart the gateway; the page asks for it once. Or set status.bindAddress to 127.0.0.1 and open the page through an SSH tunnel.`
  }
}

/** The headers a write is judged by, as Node gives them (lower-case names). */
export interface WriteHeaders {
  readonly host?: string | undefined
  readonly origin?: string | undefined
  readonly [EDIT_HEADER]?: string | undefined
  readonly authorization?: string | undefined
}

const digest = (text: string) => createHash("sha256").update(text).digest()

/** Equal tokens, compared in constant time (over their hashes, so the length does not show either). */
const sameToken = (given: string, expected: Redacted.Redacted) =>
  timingSafeEqual(digest(given), digest(Redacted.value(expected)))

/** Whether `origin` (`http://127.0.0.1:8080`) names the same host and port as the Host header. */
export const isSameOrigin = (origin: string | undefined, host: string | undefined) => {
  if (origin === undefined || host === undefined || host === "") return false
  const parsed = URL.parse(origin)
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return false
  const asked = URL.parse(`${parsed.protocol}//${host}`)
  return asked !== null && parsed.host === asked.host
}

/**
 * Why a write must be refused, or undefined when it may go on. The messages say what to do, and never echo a
 * header back.
 */
export const writeRefusal = (
  headers: WriteHeaders,
  access: EditAccess,
  token: Option.Option<Redacted.Redacted>
): string | undefined => {
  if (!access.allowed) return `${access.reason} ${access.fix}`
  if (headers.origin === undefined)
    return "Refused: a change must come from the status page itself, and this request has no Origin header."
  if (!isSameOrigin(headers.origin, headers.host))
    return "Refused: this request comes from another site (its Origin does not match the gateway's address)."
  if (headers[EDIT_HEADER] !== EDIT_HEADER_VALUE)
    return `Refused: a change must carry the header ${EDIT_HEADER}: ${EDIT_HEADER_VALUE}, as the status page sends it.`
  if (Option.isSome(token)) {
    const authorization = headers.authorization ?? ""
    const given = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined
    if (given === undefined || !sameToken(given, token.value))
      return `Refused: editing on this gateway needs the token set in ${EDIT_TOKEN_VARIABLE}, as Authorization: Bearer <token>.`
  }
  return undefined
}

/** Methods that only read: everything else goes through `writeRefusal`. */
export const isReadOnlyMethod = (method: string) => method === "GET" || method === "HEAD"
