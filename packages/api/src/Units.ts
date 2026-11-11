/**
 * A point's unit as people write it: the config keeps QUDT names (`unit:DEG_C`), the status page and
 * `ot-gateway history` show `°C`. Shared, so both say the same.
 */

/** QUDT unit names (`unit:DEG_C`) as people write them. */
const unitSymbols: Record<string, string> = {
  DEG_C: "°C",
  DEG_F: "°F",
  PERCENT: "%",
  KiloW: "kW",
  W: "W",
  "KiloW-HR": "kWh",
  V: "V",
  A: "A",
  PA: "Pa",
  BAR: "bar",
  "M3-PER-HR": "m³/h",
  "L-PER-SEC": "l/s",
  PPM: "ppm"
}

/** `°C` for `unit:DEG_C`, a QUDT name without its prefix when it has no common symbol, and "" for none. */
export const unitLabel = (unit: string | undefined) => {
  if (unit === undefined) return ""
  const name = unit.replace(/^unit:/, "")
  return unitSymbols[name] ?? name
}
