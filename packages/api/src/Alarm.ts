/**
 * Which points are alarms, and when an alarm is active: one rule for the gateway (its alarm tracker, `/api/status`,
 * `ot-gateway status`, the alarm events and metrics) and the status page, so both tell the same truth. Pure, and
 * shaped flat like the page's `PointInfo`; the gateway passes a config point's `semantics` fields in.
 */

/** When an alarm point's alarm is active: its value on (true, not 0) or off (false, 0). */
export type AlarmPolarity = "on" | "off"

/** What makes a point an alarm: its config's `alarmWhen`, or its semantics (Brick class, Haystack tags). */
export interface AlarmFields {
  readonly alarmWhen?: AlarmPolarity | undefined
  readonly brick?: string | undefined
  readonly haystack?: ReadonlyArray<string> | undefined
}

/**
 * When a point's alarm is active, or `undefined` for a point that is no alarm. The config's `alarmWhen` wins (a points
 * list's `alarm` column); otherwise what the config says the point means: the Brick class `Alarm` or one of its
 * subclasses, whose names end in `_Alarm` (`Smoke_Detection_Alarm`), or the Haystack tag `alarm` make it an alarm,
 * active when on. A class that only mentions alarms (`Alarm_Delay_Parameter`, a setting) is none.
 */
export const effectiveAlarmWhen = (point: AlarmFields): AlarmPolarity | undefined => {
  if (point.alarmWhen !== undefined) return point.alarmWhen
  const brick = point.brick
  const bySemantics =
    (brick !== undefined && (brick === "Alarm" || brick.endsWith("_Alarm"))) ||
    (point.haystack?.includes("alarm") ?? false)
  return bySemantics ? "on" : undefined
}

/**
 * Whether `value` makes the alarm of a point with polarity `when` active. `on`: `true`, or a number other than 0 (a
 * flag read as a register). `off`: `false` or 0, as a normally-closed contact reads on a fault.
 */
export const isAlarmActive = (when: AlarmPolarity, value: number | boolean) =>
  when === "on" ? value === true || (typeof value === "number" && value !== 0) : value === false || value === 0
