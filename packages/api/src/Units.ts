/**
 * A point's unit as people write it: the config keeps QUDT names (`unit:DEG_C`), the status page and
 * `ot-gateway history` show `°C`. Shared, so both say the same.
 */

/** QUDT unit names (`unit:DEG_C`) as people write them. */
export const unitSymbols: Readonly<Record<string, string>> = {
  DEG_C: "°C",
  DEG_F: "°F",
  PERCENT: "%",
  KiloW: "kW",
  W: "W",
  "W-HR": "Wh",
  "KiloW-HR": "kWh",
  "MegaW-HR": "MWh",
  V: "V",
  A: "A",
  PA: "Pa",
  BAR: "bar",
  "M3-PER-HR": "m³/h",
  "L-PER-SEC": "l/s",
  PPM: "ppm"
}

/**
 * Energy units, as QUDT names and as people write them, each in kWh: a point in one of them is a cumulative counter
 * (a meter's reading), which only rises.
 */
const ENERGY_IN_KWH: Readonly<Record<string, number>> = {
  "W-HR": 0.001,
  "KiloW-HR": 1,
  "MegaW-HR": 1000,
  "GigaW-HR": 1_000_000,
  J: 1 / 3_600_000,
  KiloJ: 1 / 3600,
  MegaJ: 1 / 3.6,
  GigaJ: 1000 / 3.6,
  wh: 0.001,
  kwh: 1,
  mwh: 1000,
  gwh: 1_000_000,
  gj: 1000 / 3.6
}

/** One `unit` in kWh when it is an energy unit (`unit:KiloW-HR`, `kWh`, `unit:MegaW-HR`, `unit:GigaJ`, …). */
export const energyUnitInKwh = (unit: string | undefined): number | undefined => {
  if (unit === undefined) return undefined
  const name = unit.replace(/^unit:/, "")
  return ENERGY_IN_KWH[name] ?? ENERGY_IN_KWH[name.toLowerCase()]
}

/** Whether a point in `unit` is an energy counter: Wh, kWh, MWh, GWh or J, in QUDT or as people write them. */
export const isEnergyUnit = (unit: string | undefined) => energyUnitInKwh(unit) !== undefined

/** `°C` for `unit:DEG_C`, a QUDT name without its prefix when it has no common symbol, and "" for none. */
export const unitLabel = (unit: string | undefined) => {
  if (unit === undefined) return ""
  const name = unit.replace(/^unit:/, "")
  return unitSymbols[name] ?? name
}
