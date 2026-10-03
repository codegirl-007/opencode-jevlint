import { describe, expect, test } from "bun:test"
import {
  compareVersions,
  DEFAULT_AUTO_CHECK_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_FINDINGS,
  DEFAULT_TIMEOUT_MS,
  parseOptions,
  parseSemver,
} from "../src/options"

describe("parseOptions", () => {
  test("applies defaults for empty input", () => {
    const { options, warnings } = parseOptions({})
    expect(warnings).toEqual([])
    expect(options).toEqual({
      binary: "jevlint",
      autoCheck: "file",
      config: undefined,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      autoCheckTimeoutMs: DEFAULT_AUTO_CHECK_TIMEOUT_MS,
      concurrency: DEFAULT_CONCURRENCY,
      maxFindings: DEFAULT_MAX_FINDINGS,
      severity: [],
      extraArgs: [],
      minimumVersion: undefined,
    })
  })

  test("defaults timeoutMs to 30s and autoCheckTimeoutMs to 10s", () => {
    const { options } = parseOptions({})
    expect(options.timeoutMs).toBe(30_000)
    expect(options.autoCheckTimeoutMs).toBe(10_000)
    expect(options.concurrency).toBe(1)
  })

  test("reads valid values", () => {
    const { options, warnings } = parseOptions({
      binary: "/opt/jevlint",
      autoCheck: "changed",
      config: "./jevlint.json",
      timeoutMs: 5000,
      autoCheckTimeoutMs: 2000,
      concurrency: 4,
      maxFindings: 3,
      severity: ["error", "warning"],
      extraArgs: ["--refresh-cache"],
      minimumVersion: "0.4.0",
    })
    expect(warnings).toEqual([])
    expect(options.binary).toBe("/opt/jevlint")
    expect(options.autoCheck).toBe("changed")
    expect(options.config).toBe("./jevlint.json")
    expect(options.timeoutMs).toBe(5000)
    expect(options.autoCheckTimeoutMs).toBe(2000)
    expect(options.concurrency).toBe(4)
    expect(options.maxFindings).toBe(3)
    expect(options.severity).toEqual(["error", "warning"])
    expect(options.extraArgs).toEqual(["--refresh-cache"])
    expect(options.minimumVersion).toBe("0.4.0")
  })

  test("parses comma-separated severity strings", () => {
    const { options } = parseOptions({ severity: "error, warning " })
    expect(options.severity).toEqual(["error", "warning"])
  })

  test("falls back with warnings on invalid values", () => {
    const { options, warnings } = parseOptions({
      binary: "",
      autoCheck: "sometimes",
      timeoutMs: -1,
      autoCheckTimeoutMs: 0,
      concurrency: 1.5,
      maxFindings: "many",
      severity: 42,
      extraArgs: 42,
    })
    expect(options.binary).toBe("jevlint")
    expect(options.autoCheck).toBe("file")
    expect(options.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(options.autoCheckTimeoutMs).toBe(DEFAULT_AUTO_CHECK_TIMEOUT_MS)
    expect(options.concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(options.maxFindings).toBe(DEFAULT_MAX_FINDINGS)
    expect(options.severity).toEqual([])
    expect(options.extraArgs).toEqual([])
    expect(warnings.length).toBeGreaterThanOrEqual(8)
  })

  test("never throws on non-object input", () => {
    expect(() => parseOptions(null)).not.toThrow()
    expect(() => parseOptions("nope")).not.toThrow()
    expect(() => parseOptions(undefined)).not.toThrow()
  })
})

describe("semver", () => {
  test("parses versions with and without v prefix", () => {
    expect(parseSemver("v1.2.3")).toEqual({ parts: [1, 2, 3], pre: "" })
    expect(parseSemver("0.4.0-rc.1")).toEqual({ parts: [0, 4, 0], pre: "rc.1" })
    expect(parseSemver("nope")).toBeUndefined()
  })

  test("compares versions", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1)
    expect(compareVersions("1.2.4", "1.2.3")).toBe(1)
    expect(compareVersions("v2.0.0", "1.9.9")).toBe(1)
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1)
    expect(compareVersions("bogus", "1.0.0")).toBe(0)
  })
})
