import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import reportFixture from "./fixtures/report.json"
import { executeTool, parseToolInput } from "../src/tool"
import { parseOptions } from "../src/options"
import type { JeVlintRuntime } from "../src/jevlint"

let workDir = ""
let script = ""

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "jevlint-tool-test-"))
  script = join(workDir, "jevlint")
  const body = `#!/usr/bin/env bash
if [ "$1" = "version" ]; then
  echo "jevlint v1.2.3"
  exit 0
fi
cat <<'JE_VLINT_EOF'
${JSON.stringify(reportFixture)}
JE_VLINT_EOF
exit 1
`
  await writeFile(script, body, "utf8")
  await chmod(script, 0o755)
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

function runtime(): JeVlintRuntime {
  return {
    options: parseOptions({ binary: script, timeoutMs: 10_000 }).options,
    projectDir: workDir,
    binaryAvailable: true,
  }
}

describe("parseToolInput", () => {
  test("parses and trims recognized fields", () => {
    expect(parseToolInput({ paths: ["a.ts", "", 3], changed: true, rule: " r ", severity: "error" })).toEqual({
      paths: ["a.ts"],
      changed: true,
      rule: "r",
      severity: "error",
    })
  })
  test("ignores invalid fields and non-objects", () => {
    expect(parseToolInput(null)).toEqual({})
    expect(parseToolInput({ changed: "yes", paths: "nope" })).toEqual({})
  })
})

describe("executeTool", () => {
  test("filters findings by severity", async () => {
    const result = await executeTool(runtime(), { paths: ["src"], severity: "error" })
    expect(result.metadata.jevlint.ok).toBe(true)
    expect(result.metadata.jevlint.totalFindings).toBe(1)
    expect(result.content).not.toContain("prefer-early-return")
  })

  test("filters findings by rule", async () => {
    const result = await executeTool(runtime(), { paths: ["src"], rule: "prefer-early-return" })
    expect(result.metadata.jevlint.totalFindings).toBe(1)
    expect(result.content).toContain("prefer-early-return")
  })

  test("returns a soft message when the binary is unavailable", async () => {
    const nod = { ...runtime(), binaryAvailable: false }
    const result = await executeTool(nod, { paths: ["src"] })
    expect(result.metadata.jevlint.ok).toBe(false)
    expect(result.content).toContain("not available")
  })

  test("returns a soft message for a missing binary", async () => {
    const bad = {
      options: parseOptions({ binary: join(workDir, "missing"), timeoutMs: 5_000 }).options,
      projectDir: workDir,
      binaryAvailable: true,
    }
    const result = await executeTool(bad, { paths: ["src"] })
    expect(result.metadata.jevlint.ok).toBe(false)
    expect(result.content).toContain("jevlint:")
  })
})
