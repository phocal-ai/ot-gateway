/**
 * `ot-gateway report`: what a public issue must not carry is replaced, the same bug has the same fingerprint on
 * another site, and nothing is filed without the user's yes.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { GatewayConfig } from "@ot-gateway/core"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import { join } from "node:path"
import {
  commandWords,
  draftReport,
  fingerprintIn,
  fingerprintOf,
  formatDraft,
  formatSend,
  type GhResult,
  GitHub,
  identifiersOf,
  type IssueRef,
  issueLink,
  MAX_REPORT_LENGTH,
  parseDraft,
  publicText,
  ReportFailed,
  reportFileName,
  sendReport
} from "../src/Report.ts"

const site = {
  site: "acme-vienna",
  building: "tower-b",
  id: "pi-roof",
  mqtt: {
    url: "mqtts://mqtt.acme-corp.example:8883",
    username: "acme-gateway",
    passwordEnv: "REPORT_TEST_PASSWORD"
  },
  devices: [
    {
      protocol: "modbus-tcp",
      id: "meter",
      host: "plc7.acme.lan",
      unitId: 1,
      points: [
        { id: "energy", name: "Tenant Huber energy", table: "input", address: 100, dataType: "float64" },
        { id: "t1", name: "t1", table: "input", address: 2, dataType: "int16" }
      ]
    },
    {
      protocol: "modbus-tcp",
      id: "meter-2",
      host: "192.168.10.41",
      unitId: 1,
      points: [{ id: "energy", name: "Shop energy", table: "input", address: 100, dataType: "float64" }]
    }
  ]
}

const siteConfig = Schema.decodeUnknownSync(GatewayConfig)(site)
const machine = { hostname: "acme-pi-04", home: "/home/lukas" }
const options = { identifiers: identifiersOf(siteConfig), secrets: ["s3cret-pw"], machine }

describe("publicText", () => {
  it("replaces the config's names by placeholders, the same device by the same one, and not inside longer ids", () => {
    const { text, replaced } = publicText(
      "read meter/energy failed, meter-2/energy did not; kilometer and meter_x stay. Topic acme-vienna/tower-b/meter/energy, gateway pi-roof, tenant huber energy",
      options
    )
    expect(text).toBe(
      "read device-1/point-1 failed, device-2/point-1 did not; kilometer and meter_x stay. Topic site-1/building-1/device-1/point-1, gateway gateway-1, point-1"
    )
    expect(replaced).toMatchObject({ device: 3, site: 1, building: 1, gateway: 1 })
  })

  it("leaves a two-letter id and the default gateway id, which would match too much", () => {
    expect(publicText("t1 on main", options).text).toBe("t1 on main")
    expect(identifiersOf(Schema.decodeUnknownSync(GatewayConfig)({ ...site, id: "main" }))).not.toContainEqual(
      expect.objectContaining({ kind: "gateway" })
    )
  })

  it("replaces addresses, the same address by the same placeholder, and keeps loopback and versions", () => {
    const { text } = publicText(
      "192.168.10.41:502 then 10.0.0.7, again 192.168.10.41; 127.0.0.1:5020 and 0.0.0.0 stay, v0.17.3 and Linux 6.18.44 too. MAC 00:1A:2b:3C:4D:5E, fe80::1ff:fe23:4567:890a, at 14:21:03",
      options
    )
    expect(text).toBe(
      "ip-1:502 then ip-2, again ip-1; 127.0.0.1:5020 and 0.0.0.0 stay, v0.17.3 and Linux 6.18.44 too. MAC mac-1, ip-3, at 14:21:03"
    )
  })

  it("replaces host names: the config's, this machine's and any other URL's, but not GitHub's", () => {
    const { text } = publicText(
      "plc7.acme.lan:502 via mqtts://gw:pw@mqtt.acme-corp.example:8883 on acme-pi-04; http://scada.other.example/x; https://github.com/phocal-ai/ot-gateway/issues/1 and mqtt://localhost:1883",
      options
    )
    expect(text).toBe(
      "host-2:502 via mqtts://[redacted]@host-1:8883 on this-machine; http://host-3/x; https://github.com/phocal-ai/ot-gateway/issues/1 and mqtt://localhost:1883"
    )
  })

  it("replaces secrets, the broker login, e-mail addresses and home folders", () => {
    const { text, replaced } = publicText(
      "login acme-gateway with s3cret-pw, ask j.huber@acme-corp.example; /home/lukas/site/ot-gateway.json, /Users/anna/x and C:\\Users\\Anna\\x",
      options
    )
    expect(text).toBe(
      "login broker-login with [redacted], ask email; ~/site/ot-gateway.json, /Users/user/x and C:\\Users\\user\\x"
    )
    expect(replaced).toMatchObject({ secret: 1, login: 1, email: 1, home: 3 })
  })

  it("changes nothing on a second pass, and numbers a new address after the ones the text has", () => {
    const first = publicText("meter at 192.168.10.41 and 10.0.0.7 via mqtt://broker.x.example, /home/anna/a", options)
    const second = publicText(first.text, options)
    expect(second.text).toBe(first.text)
    expect(second.replaced).toEqual({})
    expect(publicText(`${first.text} and 172.16.0.9`, options).text).toContain("and ip-3")
  })

  it("does not let a site named like the tool rewrite the draft's own lines", () => {
    const named = Schema.decodeUnknownSync(GatewayConfig)({ ...site, site: "ot-gateway", building: "report" })
    expect(identifiersOf(named).map((each) => each.kind)).not.toContain("site")
    expect(identifiersOf(named).map((each) => each.kind)).not.toContain("building")
  })
})

describe("fingerprint", () => {
  it("is the same for the same bug on another site, and another for another error", () => {
    const here = fingerprintOf({
      code: "invalid-response",
      command: "pnpm ot-gateway read device-1/point-3 --json",
      error: "invalid response from ip-1:502 after 2000 ms",
      title: "read fails"
    })
    const there = fingerprintOf({
      code: "invalid-response",
      command: "npx ot-gateway@0.17.3 read device-12/point-40",
      error: "Invalid response from ip-7:1502 after 150 ms",
      title: "reading the meter does not work"
    })
    expect(here).toMatch(/^[0-9a-f]{12}$/)
    expect(there).toBe(here)
    expect(
      fingerprintOf({ code: "invalid-response", command: "ot-gateway read x", error: "short frame", title: "t" })
    ).not.toBe(here)
  })

  it("takes the command's own words, without how it was started and its arguments", () => {
    expect(commandWords("pnpm ot-gateway points allow-commands meter/setpoint --min=1")).toBe("points allow-commands")
    expect(commandWords("otg read meter/power")).toBe("read")
    expect(commandWords("docker run ghcr.io/x ot-gateway status --json")).toBe("status")
    expect(commandWords("read meter")).toBe("read")
    expect(commandWords("")).toBe("")
  })

  it("falls back on the title when there is no error", () => {
    expect(fingerprintOf({ title: "Status page shows 3 devices twice" })).toBe(
      fingerprintOf({ title: "status page shows 12 devices  twice" })
    )
  })
})

/** A GitHub that answers from memory and records what `gh` was asked. */
const gitHub = (given: {
  readonly found?: ReadonlyArray<IssueRef>
  readonly searchFails?: boolean
  readonly newest?: string
  /** `gh`'s answers by its first two words; no `gh` at all when left out. */
  readonly gh?: Readonly<Record<string, GhResult>>
}) => {
  const calls: Array<ReadonlyArray<string>> = []
  const layer = Layer.succeed(
    GitHub,
    GitHub.of({
      searchIssues: () =>
        given.searchFails === true
          ? Effect.fail(new ReportFailed({ code: "report-not-filed", message: "could not search the issues" }))
          : Effect.succeed(given.found ?? []),
      gh: (args) =>
        Effect.sync(() => {
          calls.push(args)
          return Option.fromNullishOr(given.gh?.[args.slice(0, 2).join(" ")])
        }),
      latestRelease: Effect.succeed(Option.fromNullishOr(given.newest))
    })
  )
  return { layer, calls }
}

const signedIn: GhResult = {
  exitCode: 0,
  stdout: "",
  stderr: "github.com\n  ✓ Logged in to github.com account octo-user (keyring)\n"
}

const folderWithSite = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const folder = yield* fs.makeTempDirectoryScoped()
  yield* fs.writeFileString(join(folder, "ot-gateway.json"), JSON.stringify(site))
  yield* fs.writeFileString(join(folder, "ot-gateway.env"), "REPORT_TEST_PASSWORD=s3cret-pw\n")
  return folder
})

const input = {
  title: "read fails on a float64 input register of meter",
  what: "$ ot-gateway read meter/energy\nerror: invalid response from plc7.acme.lan:502 (192.168.10.41)",
  expected: "A value, as probe reads it",
  steps: "ot-gateway read meter/energy",
  ruledOut: "probe 192.168.10.41 100 reads the register; password s3cret-pw is right",
  command: "ot-gateway read meter/energy",
  code: "invalid-response",
  error: "invalid response from plc7.acme.lan:502",
  model: "Acme PM5000, firmware 1.2",
  device: "meter"
}

const leaks = ["acme", "plc7", "192.168", "s3cret-pw", "Huber", "tower-b", "pi-roof", "lukas"]

describe("report draft", () => {
  it.effect(
    "writes the issue text without the site's names, with versions, the device's protocol and what to settle",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const folder = yield* folderWithSite
        const output = join(folder, "report.md")
        const found = [
          { number: 212, title: "float64 reads fail", url: "https://github.com/x/y/issues/212", state: "open" }
        ]
        const draft = yield* draftReport({
          input,
          config: join(folder, "ot-gateway.json"),
          env: {},
          cli: "ot-gateway",
          output,
          machine
        }).pipe(Effect.provide(gitHub({ found, newest: "v99.0.0" }).layer))
        expect(yield* fs.readFileString(output)).toBe(draft.text)
        for (const leak of leaks) expect(draft.text).not.toContain(leak)
        expect(draft.title).toBe("read fails on a float64 input register of device-1")
        expect(draft.text).toContain("- Command: `ot-gateway read device-1/point-1`")
        expect(draft.text).toContain("- Protocol: modbus-tcp")
        expect(draft.text).toContain("- Vendor and model: Acme PM5000, firmware 1.2")
        expect(draft.text).toContain("## Ruled out")
        expect(fingerprintIn(draft.text)).toBe(draft.fingerprint)
        expect(parseDraft(draft.text)?.title).toBe(draft.title)
        // The code is one explain covers, and the same bug is reported already: both are said before filing.
        expect(draft.warnings.map((warning) => warning.about)).toEqual(["code"])
        expect(draft.existing).toEqual(found)
        expect(draft.next).toBe(`ot-gateway report send ${output} --to 212`)
        expect(formatDraft(draft)).toContain("Nothing is filed yet.")
        expect(formatDraft(draft)).toContain("#212 float64 reads fail (open)")
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("says when there is no config to take the names from, and when the search did not answer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const draft = yield* draftReport({
        // The code bug says the fault is ours: no warning to rule the site out first.
        input: { title: "crash in status", what: "TypeError at 10.1.2.3", code: "bug" },
        config: join(folder, "ot-gateway.json"),
        env: {},
        cli: "npx ot-gateway",
        output: join(folder, "report.md"),
        machine
      }).pipe(Effect.provide(gitHub({ searchFails: true }).layer))
      expect(draft.text).toContain("TypeError at ip-1")
      expect(draft.warnings.map((warning) => warning.about)).toEqual(["config", "search"])
      expect(draft.existing).toEqual([])
      expect(draft.next).toBe(`npx ot-gateway report send ${join(folder, "report.md")}`)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("refuses a report without a text, and one longer than an issue takes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folder = yield* fs.makeTempDirectoryScoped()
      const draft = (what: string) =>
        draftReport({
          input: { title: "crash", what },
          config: join(folder, "ot-gateway.json"),
          env: {},
          cli: "ot-gateway",
          output: join(folder, "report.md"),
          machine
        }).pipe(Effect.provide(gitHub({}).layer), Effect.flip)
      expect((yield* draft("  ")).code).toBe("report-draft-invalid")
      const long = yield* draft("x".repeat(MAX_REPORT_LENGTH))
      expect(long.code).toBe("report-draft-invalid")
      expect(long.message).toContain("more than the 16000")
      expect(yield* fs.exists(join(folder, "report.md"))).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("report send", () => {
  const drafted = Effect.gen(function* () {
    const folder = yield* folderWithSite
    const output = join(folder, "report.md")
    yield* draftReport({
      input,
      config: join(folder, "ot-gateway.json"),
      env: {},
      cli: "ot-gateway",
      output,
      machine
    }).pipe(Effect.provide(gitHub({}).layer))
    return { folder, output, config: join(folder, "ot-gateway.json") }
  })

  it.effect("files nothing without the user's yes: it says what it would file, where and as whom", () =>
    Effect.gen(function* () {
      const { output, config } = yield* drafted
      const github = gitHub({ gh: { "auth status": signedIn } })
      const result = yield* sendReport({
        draft: output,
        config,
        env: {},
        yes: false,
        link: false,
        cli: "ot-gateway",
        machine
      }).pipe(Effect.provide(github.layer))
      expect(result).toMatchObject({ filed: false, method: "gh", target: "a new issue", account: "octo-user" })
      expect(result.next).toBe(`ot-gateway report send ${output} --yes`)
      expect(result.note).toContain("Not filed")
      expect(github.calls.map((call) => call.slice(0, 2).join(" "))).toEqual(["auth status"])
      expect(formatSend(result)).toContain("## What happened")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("files with gh on a yes, after cleaning what was added to the draft by hand", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { output, config } = yield* drafted
      yield* fs.writeFileString(output, `${yield* fs.readFileString(output)}\nAlso seen on meter-2 at 192.168.10.41.\n`)
      const github = gitHub({
        gh: {
          "auth status": signedIn,
          "issue create": { exitCode: 0, stdout: "https://github.com/phocal-ai/ot-gateway/issues/300\n", stderr: "" }
        }
      })
      const result = yield* sendReport({
        draft: output,
        config,
        env: {},
        yes: true,
        link: false,
        cli: "ot-gateway",
        machine
      }).pipe(Effect.provide(github.layer))
      expect(result).toMatchObject({
        filed: true,
        method: "gh",
        url: "https://github.com/phocal-ai/ot-gateway/issues/300",
        replaced: { device: 1, address: 1 }
      })
      const create = github.calls[1] ?? []
      expect(create.slice(0, 4)).toEqual(["issue", "create", "--repo", "phocal-ai/ot-gateway"])
      expect(create[create.indexOf("--title") + 1]).toBe("read fails on a float64 input register of device-1")
      const body = create[create.indexOf("--body") + 1] ?? ""
      expect(body).toContain("Also seen on device-2 at ip-")
      expect(body).not.toContain("# read fails")
      for (const leak of leaks) expect(body).not.toContain(leak)
      // The file is the text that was filed.
      expect(yield* fs.readFileString(output)).toBe(result.text)
      expect(formatSend(result)).toBe(
        "Replaced by placeholders: 1 × device, 1 × address.\nFiled as a new issue: https://github.com/phocal-ai/ot-gateway/issues/300"
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("adds a comment to the issue that reports the same bug", () =>
    Effect.gen(function* () {
      const { output, config } = yield* drafted
      const github = gitHub({
        gh: {
          "auth status": signedIn,
          "issue comment": {
            exitCode: 0,
            stdout: "https://github.com/phocal-ai/ot-gateway/issues/212#c1\n",
            stderr: ""
          }
        }
      })
      const result = yield* sendReport({
        draft: output,
        config,
        env: {},
        to: 212,
        yes: true,
        link: false,
        cli: "ot-gateway",
        machine
      }).pipe(Effect.provide(github.layer))
      expect(result).toMatchObject({ filed: true, target: "a comment on #212" })
      expect(github.calls[1]?.slice(0, 3)).toEqual(["issue", "comment", "212"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("gives a link to the filled-in form when no gh is signed in, and with --link asks gh nothing", () =>
    Effect.gen(function* () {
      const { output, config } = yield* drafted
      const none = gitHub({})
      const result = yield* sendReport({
        draft: output,
        config,
        env: {},
        yes: true,
        link: false,
        cli: "ot-gateway",
        machine
      }).pipe(Effect.provide(none.layer))
      expect(result).toMatchObject({ filed: false, method: "link" })
      expect(result.url).toMatch(/^https:\/\/github\.com\/phocal-ai\/ot-gateway\/issues\/new\?title=read%20fails/)
      expect(decodeURIComponent(result.url ?? "")).toContain("## What happened")
      expect(result.note).toContain("Without a GitHub account")
      const signed = gitHub({ gh: { "auth status": signedIn } })
      const linked = yield* sendReport({
        draft: output,
        config,
        env: {},
        to: 212,
        yes: true,
        link: true,
        cli: "ot-gateway",
        machine
      }).pipe(Effect.provide(signed.layer))
      expect(linked).toMatchObject({
        filed: false,
        method: "link",
        url: "https://github.com/phocal-ai/ot-gateway/issues/212"
      })
      expect(signed.calls).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("fails with the way out when gh does not file it, and refuses a file that is no draft", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { folder, output, config } = yield* drafted
      const github = gitHub({
        gh: { "auth status": signedIn, "issue create": { exitCode: 1, stdout: "", stderr: "HTTP 403: forbidden\n" } }
      })
      const failed = yield* sendReport({
        draft: output,
        config,
        env: {},
        yes: true,
        link: false,
        cli: "ot-gateway",
        machine
      }).pipe(Effect.provide(github.layer), Effect.flip)
      expect(failed).toMatchObject({ code: "report-not-filed", next: `ot-gateway report send ${output} --link` })
      expect(failed.message).toContain("HTTP 403: forbidden")
      const other = join(folder, "notes.md")
      yield* fs.writeFileString(other, "# Notes\n\nNot a report.\n")
      const refused = yield* sendReport({
        draft: other,
        config,
        env: {},
        yes: true,
        link: false,
        cli: "ot-gateway",
        machine
      }).pipe(Effect.provide(github.layer), Effect.flip)
      expect(refused.code).toBe("report-draft-invalid")
      const missing = yield* sendReport({
        draft: join(folder, "none.md"),
        config,
        env: {},
        yes: true,
        link: false,
        cli: "ot-gateway",
        machine
      }).pipe(Effect.provide(github.layer), Effect.flip)
      expect(missing.code).toBe("report-draft-invalid")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe("the draft's parts", () => {
  it("leaves the text out of a link that would be too long to open", () => {
    expect(issueLink("t", "short").withBody).toBe(true)
    const long = issueLink("a title", "x ".repeat(4000))
    expect(long).toEqual({ url: "https://github.com/phocal-ai/ot-gateway/issues/new?title=a%20title", withBody: false })
  })

  it("names the file by the local time", () => {
    expect(reportFileName(new Date(2026, 10, 27, 7, 8, 9).getTime())).toBe("ot-gateway-report-20261127-070809.md")
  })
})
