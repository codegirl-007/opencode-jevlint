import { describe, expect, test } from "bun:test"
import { buildCheckArgs, toAbsolutePath } from "../src/jevlint"
import { parseOptions } from "../src/options"

function opts(extra: Record<string, unknown> = {}) {
  return parseOptions(extra).options
}

describe("buildCheckArgs", () => {
  test("builds the base command", () => {
    expect(buildCheckArgs(opts(), { paths: ["src/a.ts"] })).toEqual([
      "check",
      "--format",
      "json",
      "--concurrency",
      "1",
      "src/a.ts",
    ])
  })

  test("includes --changed and paths", () => {
    expect(buildCheckArgs(opts(), { changed: true, paths: ["src/a.ts"] })).toEqual([
      "check",
      "--changed",
      "--format",
      "json",
      "--concurrency",
      "1",
      "src/a.ts",
    ])
  })

  test("includes --config and extra args before paths", () => {
    const options = opts({ config: "./jevlint.json", extraArgs: ["--refresh-cache"] })
    expect(buildCheckArgs(options, { paths: ["src"] })).toEqual([
      "check",
      "--format",
      "json",
      "--concurrency",
      "1",
      "--config",
      "./jevlint.json",
      "--refresh-cache",
      "src",
    ])
  })

  test("omits empty paths", () => {
    expect(buildCheckArgs(opts(), { paths: ["", "src/a.ts", ""] })).toEqual([
      "check",
      "--format",
      "json",
      "--concurrency",
      "1",
      "src/a.ts",
    ])
  })

  test("uses the configured concurrency flag", () => {
    const options = opts({ concurrency: 4 })
    expect(buildCheckArgs(options, { paths: ["src"] })).toEqual([
      "check",
      "--format",
      "json",
      "--concurrency",
      "4",
      "src",
    ])
  })
})

describe("toAbsolutePath", () => {
  test("resolves relative paths against project dir", () => {
    expect(toAbsolutePath("src/a.ts", "/work/project")).toBe("/work/project/src/a.ts")
  })
  test("keeps absolute paths", () => {
    expect(toAbsolutePath("/tmp/a.ts", "/work/project")).toBe("/tmp/a.ts")
  })
})
