/** Writing CSV (RFC 4180) that PointsList.ts's `parseDelimited` reads back as it was written. */

/** A CSV field: quoted when it holds a separator, a quote or a line break. */
const csvField = (value: string | number) => {
  const text = String(value)
  return /[",;\t\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** One row as a line, without its line break: `separator` between the fields (a comma unless given). */
export const csvLine = (fields: ReadonlyArray<string | number>, separator = ",") => fields.map(csvField).join(separator)

/** Rows as CSV text, comma-separated, one line each. */
export const toCsv = (rows: ReadonlyArray<ReadonlyArray<string | number>>) =>
  `${rows.map((fields) => csvLine(fields)).join("\n")}\n`
