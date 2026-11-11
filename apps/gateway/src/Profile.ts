/**
 * Device profiles: one Modbus device model's registers, written once from its register map and reused by every
 * points list that names the model. A row with `profile: eastron-sdm630` and `point: *` takes all its points;
 * `point: Total import energy` takes one. The row still gives what differs per device (host, unit_id, how often,
 * what to send); the profile gives the registers.
 *
 * Profiles live in `profiles/` (the reviewed library, shipped with the CLI) or next to a points list as a
 * `.json` file (a draft, an assistant's first go at a datasheet). Each names the document it was written from,
 * and says whether its values were checked on a real device. A profile never makes a point writable.
 */
import { ByteOrder, DataType, registerWidth, Slug } from "@ot-gateway/core"
import { Effect, FileSystem, Path, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { slugify } from "./Slug.ts"
import { closestMatch } from "./Suggest.ts"

export const profileVersion = 1

export class ProfileError extends Schema.TaggedError<ProfileError>()("ProfileError", { message: Schema.String }) {}

const Text = Schema.String.pipe(Schema.check(Schema.isNonEmpty()))

export const ProfilePoint = Schema.Struct({
  /** The point's name; its slug is the point's id and what a points list picks it by. */
  name: Text,
  /** The 0-based address, as the register map's hex column gives it (30001 is input register 0). */
  register: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
  table: Schema.Literals(["holding", "input", "coil", "discrete"]),
  type: DataType,
  byteOrder: Schema.optionalKey(ByteOrder),
  scale: Schema.optionalKey(Schema.Finite),
  offset: Schema.optionalKey(Schema.Finite),
  unit: Schema.optionalKey(Text),
  description: Schema.optionalKey(Text)
})
export type ProfilePoint = typeof ProfilePoint.Type

export const Profile = Schema.Struct({
  format: Schema.Literal("ot-gateway device profile"),
  version: Schema.Literal(profileVersion),
  /** vendor-model, the name a points list uses. */
  id: Slug,
  vendor: Text,
  model: Text,
  protocol: Schema.Literal("modbus-tcp"),
  /** The register map it was written from: title and revision, and where to get it. */
  source: Schema.Struct({ document: Text, revision: Schema.optionalKey(Text), url: Schema.optionalKey(Text) }),
  /** True only once its values were read from a real device and made sense. */
  verified: Schema.Boolean,
  notes: Schema.optionalKey(Text),
  points: Schema.Array(ProfilePoint).pipe(Schema.check(Schema.isMinLength(1)))
})
export type Profile = typeof Profile.Type

/** What makes a profile wrong beyond its shape: duplicate names and registers that overlap. */
export const profileProblems = (profile: Profile): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const names = new Map<string, string>()
  const taken = new Map<string, string>()
  for (const point of profile.points) {
    const id = slugify(point.name)
    const before = names.get(id)
    if (before !== undefined) problems.push(`"${point.name}" and "${before}" have the same id, ${id}`)
    names.set(id, point.name)
    const bits = point.table === "coil" || point.table === "discrete"
    const width = bits ? 1 : registerWidth(point.type)
    if (!bits && point.register + width - 1 > 65535) problems.push(`"${point.name}" runs past register 65535`)
    for (let register = point.register; register < point.register + width; register++) {
      const key = `${bits ? point.table : "registers"}:${register}`
      const other = taken.get(key)
      if (other !== undefined) problems.push(`"${point.name}" overlaps "${other}" at ${point.table} ${register}`)
      taken.set(key, point.name)
    }
  }
  return problems
}

/** The format as `profiles schema --json` prints it: a JSON Schema, for an assistant writing a profile. */
export const profileJsonSchema = () => Schema.toJsonSchemaDocument(Profile)

/** The format as `profiles schema` prints it, for people. */
export const describeProfileFormat = () =>
  [
    `ot-gateway device profile, version ${profileVersion}: one JSON file per Modbus device model`,
    "",
    '  format, version   "ot-gateway device profile", 1',
    "  id                vendor-model as a slug (eastron-sdm630): what a points list's profile column names",
    "  vendor, model     as the register map writes them",
    '  protocol          "modbus-tcp"',
    "  source            { document, revision, url }: the register map it was written from",
    "  verified          true only once its values were read from a real device and made sense",
    "  notes             how the device is reached and set up (a TCP gateway in front, the word order it uses)",
    "  points            [{ name, register (0-based), table (holding | input | coil | discrete), type,",
    "                      byteOrder, scale, offset, unit, description }]",
    "",
    "A draft next to a points list is named by its path (profile: ./my-meter.json). Nothing in a profile is writable.",
    "ot-gateway profiles schema --json prints the JSON Schema; profiles show eastron-sdm630 a complete one."
  ].join("\n")

/** One profile for people: what it is, where it comes from, and its points. */
export const describeProfile = (profile: Profile) => {
  const width = Math.max(...profile.points.map((point) => slugify(point.name).length)) + 2
  return [
    `${profile.id}: ${profile.vendor} ${profile.model}`,
    `  from ${profile.source.document}${profile.source.revision === undefined ? "" : ` ${profile.source.revision}`}${profile.verified ? ", checked on a device" : ", not yet checked on a device"}`,
    ...(profile.notes === undefined ? [] : [`  ${profile.notes}`]),
    "",
    ...profile.points.map(
      (point) =>
        `  ${slugify(point.name).padEnd(width)}${point.table} ${point.register}, ${point.type}${point.byteOrder === undefined ? "" : ` ${point.byteOrder}`}${point.scale === undefined ? "" : ` × ${point.scale}`}${point.unit === undefined ? "" : `, ${point.unit}`}`
    )
  ].join("\n")
}

/** The reviewed library, as installed next to this app: in a checkout and in the npm package alike. */
export const libraryPath = fileURLToPath(new URL("../../../profiles/", import.meta.url))

const decode = (text: string, where: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Profile))(text).pipe(
    Effect.mapError((error) => new ProfileError({ message: `${where} is not a valid profile:\n${error.message}` }))
  )

/** A profile read from `file` and checked, shape and registers. */
export const readProfile = Effect.fn("readProfile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError(() => new ProfileError({ message: `no profile at ${file}` })))
  const profile = yield* decode(text, file)
  const problems = profileProblems(profile)
  if (problems.length > 0) {
    return yield* new ProfileError({ message: `${file}: ${problems.join("; ")}` })
  }
  return profile
})

/** Every profile in the library, sorted by id. */
export const libraryProfiles = Effect.fn("libraryProfiles")(function* (library: string = libraryPath) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = (yield* fs.readDirectory(library)).filter((file) => file.endsWith(".json")).toSorted()
  return yield* Effect.forEach(files, (file) => readProfile(path.join(library, file)))
})

/**
 * The profile a points list names: a `.json` path (relative to the list) for a draft, otherwise an id from the
 * library, with the closest id suggested when it is not there.
 */
export const resolveProfile = Effect.fn("resolveProfile")(function* (
  name: string,
  options: { readonly relativeTo: string; readonly library?: string }
) {
  const path = yield* Path.Path
  if (name.toLowerCase().endsWith(".json")) {
    return yield* readProfile(path.resolve(options.relativeTo, name))
  }
  const library = options.library ?? libraryPath
  const fs = yield* FileSystem.FileSystem
  const file = path.join(library, `${name.toLowerCase()}.json`)
  if (yield* fs.exists(file)) return yield* readProfile(file)
  const ids = (yield* fs.readDirectory(library))
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
  const meant = closestMatch(name, ids)
  return yield* new ProfileError({
    message: `no profile "${name}"${meant === undefined ? "" : `; did you mean ${meant}?`} (ot-gateway profiles list shows them, a path ending in .json reads a draft)`
  })
})
