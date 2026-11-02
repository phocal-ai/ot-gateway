/**
 * BACnet tag encoding (ASHRAE 135, clause 20.2): application-tagged values,
 * context tags and opening/closing tags. Pure functions over bytes.
 *
 * Decoding goes through a `Reader` that throws `BacnetCodecError` internally;
 * every exported decoder catches it and returns a `Result`, so callers never
 * see an exception.
 */
import { Result, Schema } from "effect"

export class BacnetCodecError extends Schema.TaggedError<BacnetCodecError>()("BacnetCodecError", {
  message: Schema.String
}) {}

/** Application tag numbers (clause 20.2.1.4). */
export const ApplicationTag = {
  Null: 0,
  Boolean: 1,
  Unsigned: 2,
  Signed: 3,
  Real: 4,
  Double: 5,
  OctetString: 6,
  CharacterString: 7,
  BitString: 8,
  Enumerated: 9,
  Date: 10,
  Time: 11,
  ObjectIdentifier: 12
} as const

export interface ObjectId {
  readonly objectType: number
  readonly instance: number
}

/** The largest instance number; 4,194,303 is the wildcard (clause 12.11.1). */
export const MAX_INSTANCE = 0x3f_ff_ff

/**
 * A decoded value. Application-tagged primitives map one to one; anything
 * context-tagged inside a property value (a constructed type) is kept as
 * `context` (primitive, raw bytes) or `constructed` (opening ... closing).
 */
export type BacnetValue =
  | { readonly type: "null" }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "unsigned"; readonly value: number }
  | { readonly type: "signed"; readonly value: number }
  | { readonly type: "real"; readonly value: number }
  | { readonly type: "double"; readonly value: number }
  | { readonly type: "octet-string"; readonly value: Uint8Array }
  | { readonly type: "character-string"; readonly value: string }
  | { readonly type: "bit-string"; readonly value: ReadonlyArray<boolean> }
  | { readonly type: "enumerated"; readonly value: number }
  | {
      readonly type: "date"
      readonly year: number | undefined
      readonly month: number
      readonly day: number
      readonly weekday: number
    }
  | {
      readonly type: "time"
      readonly hour: number
      readonly minute: number
      readonly second: number
      readonly hundredths: number
    }
  | { readonly type: "object-identifier"; readonly value: ObjectId }
  | { readonly type: "context"; readonly tagNumber: number; readonly data: Uint8Array }
  | { readonly type: "constructed"; readonly tagNumber: number; readonly values: ReadonlyArray<BacnetValue> }

// --- Encoding ----------------------------------------------------------------

/** Collects bytes; every `encode*` function writes into one. */
export class Writer {
  private readonly chunks: Array<number> = []
  byte(value: number) {
    this.chunks.push(value & 0xff)
    return this
  }
  bytes(values: ArrayLike<number>) {
    for (let i = 0; i < values.length; i++) this.chunks.push((values[i] ?? 0) & 0xff)
    return this
  }
  u16(value: number) {
    return this.byte(value >> 8).byte(value)
  }
  u32(value: number) {
    return this.u16(Math.floor(value / 0x1_00_00)).u16(value & 0xff_ff)
  }
  toBytes() {
    return Uint8Array.from(this.chunks)
  }
}

/** Tag octet(s), then the extended length if any (clause 20.2.1.1–20.2.1.3). */
const writeTag = (writer: Writer, tagNumber: number, context: boolean, lengthValueType: number) => {
  const classBit = context ? 0x08 : 0x00
  const tagBits = tagNumber <= 14 ? tagNumber << 4 : 0xf0
  writer.byte(tagBits | classBit | Math.min(lengthValueType, 5))
  if (tagNumber > 14) writer.byte(tagNumber)
  if (lengthValueType <= 4) return
  if (lengthValueType <= 253) writer.byte(lengthValueType)
  else if (lengthValueType <= 0xff_ff) writer.byte(254).u16(lengthValueType)
  else writer.byte(255).u32(lengthValueType)
}

const writeTagged = (writer: Writer, tagNumber: number, context: boolean, content: Uint8Array) => {
  writeTag(writer, tagNumber, context, content.length)
  writer.bytes(content)
}

export const writeOpening = (writer: Writer, tagNumber: number) => {
  writer.byte((tagNumber <= 14 ? tagNumber << 4 : 0xf0) | 0x0e)
  if (tagNumber > 14) writer.byte(tagNumber)
}

export const writeClosing = (writer: Writer, tagNumber: number) => {
  writer.byte((tagNumber <= 14 ? tagNumber << 4 : 0xf0) | 0x0f)
  if (tagNumber > 14) writer.byte(tagNumber)
}

/** Fewest big-endian bytes for an unsigned integer (clause 20.2.4). */
const unsignedContent = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`not an unsigned integer: ${value}`)
  const out: Array<number> = []
  let rest = value
  do {
    out.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  } while (rest > 0)
  return Uint8Array.from(out)
}

/** Fewest two's complement bytes for a signed integer (clause 20.2.5). */
const signedContent = (value: number): Uint8Array => {
  if (!Number.isInteger(value) || value < -0x80_00_00_00 || value > 0x7f_ff_ff_ff) {
    throw new RangeError(`not a 32-bit signed integer: ${value}`)
  }
  const length =
    value >= -0x80 && value <= 0x7f
      ? 1
      : value >= -0x80_00 && value <= 0x7f_ff
        ? 2
        : value >= -0x80_00_00 && value <= 0x7f_ff_ff
          ? 3
          : 4
  const out = new Uint8Array(length)
  let rest = value
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest & 0xff
    rest >>= 8
  }
  return out
}

const objectIdContent = ({ objectType, instance }: ObjectId): Uint8Array => {
  if (objectType < 0 || objectType > 0x3_ff || instance < 0 || instance > MAX_INSTANCE) {
    throw new RangeError(`object identifier out of range: ${objectType}:${instance}`)
  }
  return new Writer().u32(objectType * 0x40_00_00 + instance).toBytes()
}

const encoder = new TextEncoder()

/** The content octets of an application value, and its tag number. */
const applicationContent = (value: BacnetValue): { readonly tag: number; readonly content: Uint8Array } => {
  switch (value.type) {
    case "null":
      return { tag: ApplicationTag.Null, content: new Uint8Array(0) }
    case "boolean":
      // Handled by the caller: the value lives in the tag itself.
      return { tag: ApplicationTag.Boolean, content: new Uint8Array(0) }
    case "unsigned":
      return { tag: ApplicationTag.Unsigned, content: unsignedContent(value.value) }
    case "signed":
      return { tag: ApplicationTag.Signed, content: signedContent(value.value) }
    case "real": {
      const out = new Uint8Array(4)
      new DataView(out.buffer).setFloat32(0, value.value)
      return { tag: ApplicationTag.Real, content: out }
    }
    case "double": {
      const out = new Uint8Array(8)
      new DataView(out.buffer).setFloat64(0, value.value)
      return { tag: ApplicationTag.Double, content: out }
    }
    case "octet-string":
      return { tag: ApplicationTag.OctetString, content: value.value }
    case "character-string":
      // Character set 0: ISO 10646 (UTF-8), clause 20.2.9.
      return { tag: ApplicationTag.CharacterString, content: Uint8Array.from([0, ...encoder.encode(value.value)]) }
    case "bit-string": {
      const bits = value.value
      const bytes = new Uint8Array(1 + Math.ceil(bits.length / 8))
      bytes[0] = (8 - (bits.length % 8)) % 8
      bits.forEach((bit, i) => {
        if (bit) bytes[1 + (i >> 3)] = (bytes[1 + (i >> 3)] ?? 0) | (0x80 >> (i & 7))
      })
      return { tag: ApplicationTag.BitString, content: bytes }
    }
    case "enumerated":
      return { tag: ApplicationTag.Enumerated, content: unsignedContent(value.value) }
    case "date":
      return {
        tag: ApplicationTag.Date,
        content: Uint8Array.from([
          value.year === undefined ? 0xff : value.year - 1900,
          value.month,
          value.day,
          value.weekday
        ])
      }
    case "time":
      return {
        tag: ApplicationTag.Time,
        content: Uint8Array.from([value.hour, value.minute, value.second, value.hundredths])
      }
    case "object-identifier":
      return { tag: ApplicationTag.ObjectIdentifier, content: objectIdContent(value.value) }
    case "context":
    case "constructed":
      throw new RangeError(`${value.type} values are not application-tagged`)
  }
}

/** Write one value as it appears inside a property value: application-tagged, or its context form. */
export const writeValue = (writer: Writer, value: BacnetValue): void => {
  switch (value.type) {
    case "boolean":
      writeTag(writer, ApplicationTag.Boolean, false, value.value ? 1 : 0)
      return
    case "context":
      writeTagged(writer, value.tagNumber, true, value.data)
      return
    case "constructed":
      writeOpening(writer, value.tagNumber)
      for (const inner of value.values) writeValue(writer, inner)
      writeClosing(writer, value.tagNumber)
      return
    case "null":
    case "unsigned":
    case "signed":
    case "real":
    case "double":
    case "octet-string":
    case "character-string":
    case "bit-string":
    case "enumerated":
    case "date":
    case "time":
    case "object-identifier": {
      const { tag, content } = applicationContent(value)
      writeTagged(writer, tag, false, content)
    }
  }
}

export const writeContextUnsigned = (writer: Writer, tagNumber: number, value: number) =>
  writeTagged(writer, tagNumber, true, unsignedContent(value))

export const writeContextEnumerated = writeContextUnsigned

export const writeContextObjectId = (writer: Writer, tagNumber: number, id: ObjectId) =>
  writeTagged(writer, tagNumber, true, objectIdContent(id))

export const writeContextBoolean = (writer: Writer, tagNumber: number, value: boolean) =>
  writeTagged(writer, tagNumber, true, Uint8Array.of(value ? 1 : 0))

export const writeContextReal = (writer: Writer, tagNumber: number, value: number) => {
  const content = new Uint8Array(4)
  new DataView(content.buffer).setFloat32(0, value)
  writeTagged(writer, tagNumber, true, content)
}

// --- Decoding ----------------------------------------------------------------

export interface Tag {
  readonly tagNumber: number
  readonly context: boolean
  readonly kind: "value" | "opening" | "closing"
  /** Content length, or the value itself for an application Boolean. */
  readonly lengthValueType: number
}

/** Constructed values nest at most this deep; deeper input is refused instead of exhausting the stack. */
export const MAX_NESTING = 32

/** Invalid UTF-8 becomes U+FFFD rather than failing the whole answer. */
const utf8 = new TextDecoder("utf-8")

const fromCodeUnits = (units: ReadonlyArray<number>) => units.map((unit) => String.fromCharCode(unit)).join("")

/**
 * A character string's text by its character set (clause 20.2.9). Decoding
 * is lenient: a description in an old character set must not cost the
 * present value read in the same request. DBCS (1) and JIS X 0208 (2) are
 * read byte by byte, which garbles them but keeps the rest of the answer.
 */
const decodeCharacterString = (charset: number, bytes: Uint8Array): string => {
  switch (charset) {
    case 0:
      return utf8.decode(bytes)
    case 3: {
      const points: Array<number> = []
      for (let i = 0; i + 3 < bytes.length; i += 4) {
        const point =
          (((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)) >>>
          0
        points.push(point <= 0x10_ff_ff ? point : 0xff_fd)
      }
      return points.map((point) => String.fromCodePoint(point)).join("")
    }
    case 4: {
      const units: Array<number> = []
      for (let i = 0; i + 1 < bytes.length; i += 2) units.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0))
      return fromCodeUnits(units)
    }
    default:
      // 5 is ISO 8859-1, whose bytes are the first 256 code points.
      return fromCodeUnits([...bytes])
  }
}

/**
 * The shortest decimal that is the same single-precision number, so a real
 * 72.4 reads as 72.4 rather than 72.40000152587891. Encoding it again gives
 * the same four bytes.
 */
export const shortestFloat32 = (value: number): number => {
  if (!Number.isFinite(value)) return value
  for (let precision = 1; precision < 10; precision++) {
    const candidate = Number(value.toPrecision(precision))
    if (Math.fround(candidate) === value) return candidate
  }
  return value
}

/** Reads tags and values from a byte array; throws `BacnetCodecError`, caught by `decodeWith`. */
export class Reader {
  offset = 0
  readonly data: Uint8Array
  constructor(data: Uint8Array) {
    this.data = data
  }
  get remaining() {
    return this.data.length - this.offset
  }
  fail(message: string): never {
    throw new BacnetCodecError({ message })
  }
  private need(n: number) {
    if (this.remaining < n) this.fail(`truncated: need ${n} more byte(s) at offset ${this.offset}`)
  }
  byte() {
    this.need(1)
    return this.data[this.offset++] ?? 0
  }
  u16() {
    return (this.byte() << 8) | this.byte()
  }
  u32() {
    return this.u16() * 0x1_00_00 + this.u16()
  }
  bytes(n: number) {
    this.need(n)
    const out = this.data.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }

  /** Read the next tag header. */
  tag(): Tag {
    const first = this.byte()
    let tagNumber = first >> 4
    if (tagNumber === 15) tagNumber = this.byte()
    const context = (first & 0x08) !== 0
    const lvt = first & 0x07
    if (context && lvt === 6) return { tagNumber, context, kind: "opening", lengthValueType: 0 }
    if (context && lvt === 7) return { tagNumber, context, kind: "closing", lengthValueType: 0 }
    if (!context && lvt > 5) this.fail(`application tag ${tagNumber} with length/value/type ${lvt}`)
    if (lvt < 5) return { tagNumber, context, kind: "value", lengthValueType: lvt }
    const extended = this.byte()
    const length = extended === 254 ? this.u16() : extended === 255 ? this.u32() : extended
    return { tagNumber, context, kind: "value", lengthValueType: length }
  }

  /** The next tag without consuming it, or `undefined` at the end. */
  peekTag(): Tag | undefined {
    if (this.remaining === 0) return undefined
    const at = this.offset
    const tag = this.tag()
    this.offset = at
    return tag
  }

  /** Whether the next tag is context tag `tagNumber` of the given kind. */
  peekContext(tagNumber: number, kind: Tag["kind"] = "value") {
    const tag = this.peekTag()
    return tag !== undefined && tag.context && tag.tagNumber === tagNumber && tag.kind === kind
  }

  private expectContext(tagNumber: number): Tag {
    const tag = this.tag()
    if (!tag.context || tag.tagNumber !== tagNumber || tag.kind !== "value") {
      this.fail(`expected context tag ${tagNumber}, got ${describeTag(tag)}`)
    }
    return tag
  }

  opening(tagNumber: number) {
    const tag = this.tag()
    if (tag.kind !== "opening" || tag.tagNumber !== tagNumber) {
      this.fail(`expected opening tag ${tagNumber}, got ${describeTag(tag)}`)
    }
  }

  closing(tagNumber: number) {
    const tag = this.tag()
    if (tag.kind !== "closing" || tag.tagNumber !== tagNumber) {
      this.fail(`expected closing tag ${tagNumber}, got ${describeTag(tag)}`)
    }
  }

  /** Up to 8 bytes; values above 2^53 lose precision, as JavaScript numbers do. */
  unsignedOf(length: number) {
    if (length < 1 || length > 8) this.fail(`unsigned of ${length} bytes is not supported`)
    let value = 0
    for (const byte of this.bytes(length)) value = value * 256 + byte
    return value
  }

  contextUnsigned(tagNumber: number) {
    return this.unsignedOf(this.expectContext(tagNumber).lengthValueType)
  }

  contextObjectId(tagNumber: number): ObjectId {
    const tag = this.expectContext(tagNumber)
    if (tag.lengthValueType !== 4) this.fail(`object identifier of ${tag.lengthValueType} bytes`)
    return objectIdFrom(this.u32())
  }

  contextBoolean(tagNumber: number) {
    const tag = this.expectContext(tagNumber)
    if (tag.lengthValueType !== 1) this.fail(`boolean of ${tag.lengthValueType} bytes`)
    return this.byte() !== 0
  }

  contextReal(tagNumber: number) {
    const tag = this.expectContext(tagNumber)
    if (tag.lengthValueType !== 4) this.fail(`real of ${tag.lengthValueType} bytes`)
    return shortestFloat32(
      new DataView(this.data.buffer, this.data.byteOffset).getFloat32(this.bytes(4).byteOffset - this.data.byteOffset)
    )
  }

  /** The next value, which must be an application Unsigned. */
  applicationUnsigned(): number {
    const value = this.value()
    return value.type === "unsigned" ? value.value : this.fail(`expected unsigned, got ${value.type}`)
  }

  /** The next value, which must be an application Enumerated. */
  applicationEnumerated(): number {
    const value = this.value()
    return value.type === "enumerated" ? value.value : this.fail(`expected enumerated, got ${value.type}`)
  }

  /** The next value, which must be an application ObjectIdentifier. */
  applicationObjectId(): ObjectId {
    const value = this.value()
    return value.type === "object-identifier" ? value.value : this.fail(`expected object identifier, got ${value.type}`)
  }

  /** One value as it appears inside a property value (application-tagged or context/constructed). */
  value(depth = 0): BacnetValue {
    const tag = this.tag()
    if (tag.kind === "closing") this.fail(`unexpected closing tag ${tag.tagNumber}`)
    if (tag.kind === "opening") {
      if (depth >= MAX_NESTING) this.fail(`constructed values nested deeper than ${MAX_NESTING}`)
      const values: Array<BacnetValue> = []
      while (!this.peekContext(tag.tagNumber, "closing")) {
        if (this.remaining === 0) this.fail(`opening tag ${tag.tagNumber} is never closed`)
        values.push(this.value(depth + 1))
      }
      this.closing(tag.tagNumber)
      return { type: "constructed", tagNumber: tag.tagNumber, values }
    }
    if (tag.context)
      return { type: "context", tagNumber: tag.tagNumber, data: Uint8Array.from(this.bytes(tag.lengthValueType)) }
    return this.applicationContent(tag.tagNumber, tag.lengthValueType)
  }

  private applicationContent(tagNumber: number, length: number): BacnetValue {
    switch (tagNumber) {
      case ApplicationTag.Null:
        return { type: "null" }
      case ApplicationTag.Boolean:
        if (length > 1) this.fail(`boolean with value ${length}`)
        return { type: "boolean", value: length === 1 }
      case ApplicationTag.Unsigned:
        return { type: "unsigned", value: this.unsignedOf(length) }
      case ApplicationTag.Signed: {
        if (length < 1 || length > 8) this.fail(`signed of ${length} bytes is not supported`)
        const bytes = this.bytes(length)
        // A negative number is the inverted magnitude minus one, so small negatives stay exact at 8 bytes.
        const negative = (bytes[0] ?? 0) >= 0x80
        let magnitude = 0
        for (const byte of bytes) magnitude = magnitude * 256 + (negative ? 0xff - byte : byte)
        return { type: "signed", value: negative ? -magnitude - 1 : magnitude }
      }
      case ApplicationTag.Real: {
        if (length !== 4) this.fail(`real of ${length} bytes`)
        const bytes = this.bytes(4)
        return { type: "real", value: shortestFloat32(new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0)) }
      }
      case ApplicationTag.Double: {
        if (length !== 8) this.fail(`double of ${length} bytes`)
        const bytes = this.bytes(8)
        return { type: "double", value: new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0) }
      }
      case ApplicationTag.OctetString:
        return { type: "octet-string", value: Uint8Array.from(this.bytes(length)) }
      case ApplicationTag.CharacterString: {
        if (length < 1) this.fail("character string without a character set")
        const bytes = this.bytes(length)
        return { type: "character-string", value: decodeCharacterString(bytes[0] ?? 0, bytes.subarray(1)) }
      }
      case ApplicationTag.BitString: {
        if (length < 1) this.fail("bit string without its unused-bits octet")
        const [unused = 0, ...octets] = this.bytes(length)
        if (unused > 7 || (octets.length === 0 && unused !== 0)) this.fail(`bit string with ${unused} unused bits`)
        const count = octets.length * 8 - unused
        const bits: Array<boolean> = []
        for (let i = 0; i < count; i++) bits.push((((octets[i >> 3] ?? 0) << (i & 7)) & 0x80) !== 0)
        return { type: "bit-string", value: bits }
      }
      case ApplicationTag.Enumerated:
        return { type: "enumerated", value: this.unsignedOf(length) }
      case ApplicationTag.Date: {
        if (length !== 4) this.fail(`date of ${length} bytes`)
        const [year = 0xff, month = 0xff, day = 0xff, weekday = 0xff] = this.bytes(4)
        return { type: "date", year: year === 0xff ? undefined : 1900 + year, month, day, weekday }
      }
      case ApplicationTag.Time: {
        if (length !== 4) this.fail(`time of ${length} bytes`)
        const [hour = 0xff, minute = 0xff, second = 0xff, hundredths = 0xff] = this.bytes(4)
        return { type: "time", hour, minute, second, hundredths }
      }
      case ApplicationTag.ObjectIdentifier:
        if (length !== 4) this.fail(`object identifier of ${length} bytes`)
        return { type: "object-identifier", value: objectIdFrom(this.u32()) }
      default:
        return this.fail(`reserved application tag ${tagNumber}`)
    }
  }
}

const objectIdFrom = (raw: number): ObjectId => ({
  objectType: Math.floor(raw / 0x40_00_00),
  instance: raw % 0x40_00_00
})

const describeTag = (tag: Tag) =>
  tag.kind === "value"
    ? `${tag.context ? "context" : "application"} tag ${tag.tagNumber}`
    : `${tag.kind} tag ${tag.tagNumber}`

/** Run a decoder over `bytes`, turning a thrown codec error into a failed `Result`. */
export const decodeWith = <A>(
  bytes: Uint8Array,
  decode: (reader: Reader) => A,
  options: { readonly whole?: boolean } = {}
): Result.Result<A, BacnetCodecError> => {
  try {
    const reader = new Reader(bytes)
    const value = decode(reader)
    if (options.whole !== false && reader.remaining > 0) {
      return Result.fail(new BacnetCodecError({ message: `${reader.remaining} unexpected trailing byte(s)` }))
    }
    return Result.succeed(value)
  } catch (error) {
    if (error instanceof BacnetCodecError) return Result.fail(error)
    throw error
  }
}

/** Encode values the way a property value carries them. */
export const encodeValues = (values: ReadonlyArray<BacnetValue>): Uint8Array => {
  const writer = new Writer()
  for (const value of values) writeValue(writer, value)
  return writer.toBytes()
}

/** Decode a run of values (the content of a property value). */
export const decodeValues = (bytes: Uint8Array): Result.Result<ReadonlyArray<BacnetValue>, BacnetCodecError> =>
  decodeWith(bytes, (reader) => {
    const values: Array<BacnetValue> = []
    while (reader.remaining > 0) values.push(reader.value())
    return values
  })
