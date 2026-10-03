import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import reportFixture from "./fixtures/report.json"
import { probeBinary, probeDoctor, runCheck, type CheckOutcome } from "../src/jevlint"
import { parseOptions, type JeVlintOptions } from "../src/options"
import {
  attachResultMetadata,
  debounceKey,
  discoverEditToolIds,
  extractEditedPaths,
  handleExecuteAfter,
  isEditTool,
  shouldRegisterAutoCheck,
  type HookEventLike,
  type HookState,
} from "../src/hook"

let workDir = ""
let okScript = ""
let findingsScript = ""
let errorScript = ""
let missingScript = ""
let doctorOkScript = ""
let doctorBadScript = ""

const reportJson = JSON.stringify(reportFixture)

function reportScript(code: number, json = reportJson): string {
  return `#!/usr/bin/env bash
if [ "$1" = "version" ]; then
  echo "jevlint v1.2.3"
  exit 0
fi
cat <<'JE_VLINT_EOF'
${json}
JE_VLINT_EOF
exit ${code}
`
}

function errorScriptBody(): string {
  return `#!/usr/bin/env bash
if [ "$1" = "version" ]; then
  echo "jevlint v1.2.3"
  exit 0
fi
echo "config error" 1>&2
exit 2
`
}

async function makeExecutable(path: string, body: string): Promise<string> {
  await writeFile(path, body, "utf8")
  await chmod(path, 0o755)
  return path
}

/** A binary whose `doctor --offline --json` subcommand exits with `doctorCode`. */
function doctorScriptBody(doctorCode: number): string {
  return `#!/usr/bin/env bash
if [ "$1" = "version" ]; then
  echo "jevlint v1.2.3"
  exit 0
fi
if [ "$1" = "doctor" ]; then
  echo '{"ok": true}'
  ${doctorCode === 0 ? "exit 0" : `exit ${doctorCode}`}
fi
echo "unexpected args" 1>&2
exit 2
`
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "jevlint-plugin-test-"))
  okScript = await makeExecutable(join(workDir, "jevlint-ok"), reportScript(0))
  findingsScript = await makeExecutable(join(workDir, "jevlint-findings"), reportScript(1))
  errorScript = await makeExecutable(join(workDir, "jevlint-error"), errorScriptBody())
  missingScript = join(workDir, "jevlint-missing")
  doctorOkScript = await makeExecutable(join(workDir, "jevlint-doctor-ok"), doctorScriptBody(0))
  doctorBadScript = await makeExecutable(join(workDir, "jevlint-doctor-bad"), doctorScriptBody(2))
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

function optionsFor(binary: string): JeVlintOptions {
  return parseOptions({ binary, timeoutMs: 10_000 }).options
}

function stateWith(
  binary: string,
  runCheckOverride?: HookState["runCheck"],
): { state: HookState; getCalls: () => number } {
  const options = optionsFor(binary)
  let calls = 0
  const runCheckImpl: HookState["runCheck"] =
    runCheckOverride ??
    (async (paths, extra) => {
      calls += 1
      return runCheck(options, workDir, paths, extra)
    })
  const state: HookState = {
    options,
    projectDir: workDir,
    binaryAvailable: true,
    editToolIds: new Set(["edit"]),
    debounce: new Map(),
    runCheck: runCheckImpl,
  }
  return { state, getCalls: () => calls }
}

describe("jevlint process integration (fake binary)", () => {
  test("probe succeeds and reads the version", async () => {
    const probe = await probeBinary(optionsFor(okScript), workDir)
    expect(probe.ok).toBe(true)
    expect(probe.version).toBe("1.2.3")
  })

  test("probe fails for a missing binary without throwing", async () => {
    const probe = await probeBinary(optionsFor(missingScript), workDir)
    expect(probe.ok).toBe(false)
    expect(probe.message).toContain("not found")
  })

  test("probe enforces minimumVersion", async () => {
    const below = await probeBinary(
      parseOptions({ binary: okScript, minimumVersion: "9.9.9", timeoutMs: 10_000 }).options,
      workDir,
    )
    expect(below.ok).toBe(false)
    const above = await probeBinary(
      parseOptions({ binary: okScript, minimumVersion: "1.0.0", timeoutMs: 10_000 }).options,
      workDir,
    )
    expect(above.ok).toBe(true)
  })

  test("parses exit 0 and exit 1 reports", async () => {
    const zero = await runCheck(optionsFor(okScript), workDir, ["src/a.ts"])
    expect(zero.kind).toBe("ok")
    if (zero.kind === "ok") {
      expect(zero.exitCode).toBe(0)
      expect(zero.report.findings).toHaveLength(3)
    }

    const one = await runCheck(optionsFor(findingsScript), workDir, ["src/a.ts"])
    expect(one.kind).toBe("ok")
    if (one.kind === "ok") {
      expect(one.exitCode).toBe(1)
      expect(one.report.findings).toHaveLength(3)
    }
  })

  test("treats exit 2 as an error", async () => {
    const outcome = await runCheck(optionsFor(errorScript), workDir, ["src/a.ts"])
    expect(outcome.kind).toBe("error")
    if (outcome.kind === "error") {
      expect(outcome.exitCode).toBe(2)
      expect(outcome.stderr).toContain("config error")
    }
  })

  test("treats a missing binary as an error", async () => {
    const outcome = await runCheck(optionsFor(missingScript), workDir, ["src/a.ts"])
    expect(outcome.kind).toBe("error")
  })

  test("probeDoctor is ok when doctor exits 0", async () => {
    const probe = await probeDoctor(optionsFor(doctorOkScript), workDir)
    expect(probe.ok).toBe(true)
    expect(probe.detail).toContain("healthy")
  })

  test("probeDoctor reports failure when doctor exits 2 without throwing", async () => {
    const probe = await probeDoctor(optionsFor(doctorBadScript), workDir)
    expect(probe.ok).toBe(false)
    expect(probe.detail).toContain("exit 2")
  })

  test("probeDoctor passes --config through", async () => {
    // The bad script only accepts `version`/`doctor`; with a config arg `$1` is
    // still `doctor`, so this exercises the argument plumbing without hanging.
    const probe = await probeDoctor(
      parseOptions({ binary: doctorOkScript, config: "./jevlint.json", timeoutMs: 10_000 }).options,
      workDir,
    )
    expect(probe.ok).toBe(true)
  })
})

describe("auto-check registration decision", () => {
  test("requires binary, doctor health, and a non-off mode", () => {
    const on = parseOptions({ autoCheck: "file" }).options
    expect(shouldRegisterAutoCheck(on, true, true)).toBe(true)
    expect(shouldRegisterAutoCheck(on, false, true)).toBe(false)
    expect(shouldRegisterAutoCheck(on, true, false)).toBe(false)
    expect(shouldRegisterAutoCheck(parseOptions({ autoCheck: "off" }).options, true, true)).toBe(false)
  })
})

describe("edit tool discovery", () => {
  test("recognizes known names and write-like schemas, ignores read/grep", () => {
    const tools = [
      { id: "edit", input: { type: "object", properties: { filePath: {}, oldString: {}, newString: {} } } },
      { id: "read", input: { type: "object", properties: { filePath: {} } } },
      { id: "grep", input: { type: "object", properties: { pattern: {}, path: {} } } },
      { id: "modify", input: { type: "object", properties: { filePath: {}, content: {} } } },
      { id: "write", input: { type: "object", properties: { filePath: {}, content: {} } } },
      { id: "bash", input: { type: "object", properties: { command: {}, filePath: {} } } },
    ]
    expect(discoverEditToolIds(tools)).toEqual(["edit", "modify", "write"])
  })

  test("isEditTool falls back to known names", () => {
    expect(isEditTool("edit", new Set())).toBe(true)
    expect(isEditTool("Read", new Set())).toBe(false)
    expect(isEditTool("custom_writer", new Set(["custom_writer"]))).toBe(true)
  })
})

describe("edited path extraction", () => {
  test("reads all top-level path keys", () => {
    expect(extractEditedPaths({ filePath: "src/a.ts" })).toEqual(["src/a.ts"])
    expect(extractEditedPaths({ file_path: "a.py" })).toEqual(["a.py"])
    expect(extractEditedPaths({ path: "b.go" })).toEqual(["b.go"])
  })

  test("reads nested multi-edit entries across several array keys", () => {
    expect(extractEditedPaths({ edits: [{ filePath: "src/x.ts" }] })).toEqual(["src/x.ts"])
    expect(extractEditedPaths({ files: ["src/y.ts"] })).toEqual(["src/y.ts"])
    expect(
      extractEditedPaths({
        edits: [{ path: "src/a.ts" }, { target: "src/b.ts" }],
        files: ["src/c.ts"],
        changes: [{ filePath: "src/d.ts" }],
      }),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"])
  })

  test("preserves order and de-duplicates exact strings", () => {
    expect(
      extractEditedPaths({
        filePath: "src/a.ts",
        edits: [{ path: "src/a.ts" }, { path: "src/b.ts" }, "src/a.ts"],
        files: ["src/b.ts", "src/c.ts"],
      }),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
  })

  test("returns an empty list when no path is present", () => {
    expect(extractEditedPaths({})).toEqual([])
    expect(extractEditedPaths(null)).toEqual([])
    expect(extractEditedPaths({ edits: [null, 3, {}] })).toEqual([])
  })
})

describe("result metadata attachment", () => {
  test("preserves existing metadata and string content", () => {
    const result = attachResultMetadata({ content: "ok", metadata: { other: 1 } }, { ok: true }, "note")
    expect(result.metadata).toEqual({ other: 1, jevlint: { ok: true } })
    expect(result.content).toBe("ok\n\nnote")
  })
  test("appends to array content", () => {
    const result = attachResultMetadata({ content: [{ type: "text", text: "hi" }] }, { ok: true }, "note")
    expect(result.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "note" },
    ])
  })
  test("handles a missing result", () => {
    const result = attachResultMetadata(undefined, { ok: false }, "note")
    expect(result.content).toBe("note")
    expect(result.metadata).toEqual({ jevlint: { ok: false } })
  })
})

describe("debounce key", () => {
  test("is stable for identical path and content", () => {
    const now = 1_000_000
    expect(debounceKey("a.ts", { newString: "x" }, now)).toBe(debounceKey("a.ts", { newString: "x" }, now))
    expect(debounceKey(["a.ts"], { newString: "x" }, now)).toBe(debounceKey(["a.ts"], { newString: "x" }, now))
  })
  test("changes when content changes", () => {
    const now = 1_000_000
    expect(debounceKey("a.ts", { newString: "x" }, now)).not.toBe(debounceKey("a.ts", { newString: "y" }, now))
  })
  test("changes when the path list changes", () => {
    const now = 1_000_000
    expect(debounceKey(["a.ts"], { newString: "x" }, now)).not.toBe(debounceKey(["a.ts", "b.ts"], { newString: "x" }, now))
  })
  test("buckets by time when content is absent", () => {
    expect(debounceKey("a.ts", {}, 0)).not.toBe(debounceKey("a.ts", {}, 6_000))
  })
})

describe("handleExecuteAfter", () => {
  test("attaches findings metadata and appends a note", async () => {
    const { state, getCalls } = stateWith(findingsScript)
    const event: HookEventLike = {
      tool: "edit",
      status: "completed",
      input: { filePath: "src/a.ts", newString: "changed" },
      result: { content: "edited" },
    }
    await handleExecuteAfter(event, state)
    const result = event.result as { content: string; metadata: { jevlint: { totalFindings: number; ok: boolean } } }
    expect(result.metadata.jevlint.ok).toBe(true)
    expect(result.metadata.jevlint.totalFindings).toBe(3)
    expect(result.content).toContain("edited")
    expect(result.content).toContain("jevlint:")
    expect(getCalls()).toBe(1)
  })

  test("debounces identical path+content", async () => {
    const { state, getCalls } = stateWith(findingsScript)
    const event: HookEventLike = {
      tool: "edit",
      status: "completed",
      input: { filePath: "src/a.ts", newString: "same" },
      result: { content: "edited" },
    }
    await handleExecuteAfter(event, state)
    await handleExecuteAfter(event, state)
    expect(getCalls()).toBe(1)
  })

  test("re-checks when content changes", async () => {
    const { state, getCalls } = stateWith(findingsScript)
    await handleExecuteAfter(
      { tool: "edit", status: "completed", input: { filePath: "src/a.ts", newString: "one" }, result: {} },
      state,
    )
    await handleExecuteAfter(
      { tool: "edit", status: "completed", input: { filePath: "src/a.ts", newString: "two" }, result: {} },
      state,
    )
    expect(getCalls()).toBe(2)
  })

  test("uses --changed in changed mode", async () => {
    let seen: { paths: readonly string[]; changed?: boolean } | undefined
    const options = parseOptions({ binary: findingsScript, timeoutMs: 10_000, autoCheck: "changed" }).options
    const state: HookState = {
      options,
      projectDir: workDir,
      binaryAvailable: true,
      editToolIds: new Set(["edit"]),
      debounce: new Map(),
      runCheck: async (paths, extra) => {
        seen = { paths, changed: extra?.changed }
        return {
          kind: "ok",
          exitCode: 1,
          durationMs: 1,
          report: { scannedFiles: 1, codeUnits: 0, evaluations: 0, findings: [] },
        }
      },
    }
    await handleExecuteAfter(
      { tool: "edit", status: "completed", input: { filePath: "src/a.ts", newString: "z" }, result: {} },
      state,
    )
    expect(seen?.changed).toBe(true)
    expect(seen?.paths).toEqual([])
  })

  test("checks every edited file in a batched edit, resolving and de-duplicating", async () => {
    let seen: readonly string[] | undefined
    const options = optionsFor(findingsScript)
    const state: HookState = {
      options,
      projectDir: workDir,
      binaryAvailable: true,
      editToolIds: new Set(["edit"]),
      debounce: new Map(),
      runCheck: async (paths) => {
        seen = paths
        return {
          kind: "ok",
          exitCode: 1,
          durationMs: 1,
          report: { scannedFiles: 1, codeUnits: 0, evaluations: 0, findings: [] },
        }
      },
    }
    await handleExecuteAfter(
      {
        tool: "multiedit",
        status: "completed",
        input: {
          edits: [{ filePath: "src/a.ts" }, { filePath: "src/b.ts" }],
          files: ["src/c.ts", "src/a.ts"],
        },
        result: {},
      },
      state,
    )
    expect(seen).toEqual([join(workDir, "src/a.ts"), join(workDir, "src/b.ts"), join(workDir, "src/c.ts")])
  })

  test("passes autoCheckTimeoutMs to the auto-check runCheck", async () => {
    let seenTimeout: number | undefined
    const options = parseOptions({ binary: findingsScript, autoCheckTimeoutMs: 1_234 }).options
    const state: HookState = {
      options,
      projectDir: workDir,
      binaryAvailable: true,
      editToolIds: new Set(["edit"]),
      debounce: new Map(),
      runCheck: async (_paths, extra) => {
        seenTimeout = extra?.timeoutMs
        return {
          kind: "ok",
          exitCode: 0,
          durationMs: 1,
          report: { scannedFiles: 1, codeUnits: 0, evaluations: 0, findings: [] },
        }
      },
    }
    await handleExecuteAfter(
      { tool: "edit", status: "completed", input: { filePath: "src/a.ts", newString: "t" }, result: {} },
      state,
    )
    expect(seenTimeout).toBe(1_234)
  })

  test("ignores non-edit tools, errored tools and inputs without a path", async () => {
    const { state, getCalls } = stateWith(findingsScript)
    await handleExecuteAfter({ tool: "read", status: "completed", input: { filePath: "a" }, result: {} }, state)
    await handleExecuteAfter({ tool: "edit", status: "error", input: { filePath: "a" }, result: {} }, state)
    await handleExecuteAfter({ tool: "edit", status: "completed", input: {}, result: {} }, state)
    expect(getCalls()).toBe(0)
  })

  test("attaches a one-line note when the check errors", async () => {
    const { state } = stateWith(errorScript)
    const event: HookEventLike = {
      tool: "edit",
      status: "completed",
      input: { filePath: "src/a.ts", newString: "boom" },
      result: { content: "edited" },
    }
    await handleExecuteAfter(event, state)
    const result = event.result as { content: string; metadata: { jevlint: { ok: boolean; error?: string } } }
    expect(result.metadata.jevlint.ok).toBe(false)
    expect(result.content).toContain("jevlint:")
  })

  test("adds no note when there are no findings", async () => {
    const empty: CheckOutcome = {
      kind: "ok",
      exitCode: 0,
      durationMs: 1,
      report: { scannedFiles: 1, codeUnits: 0, evaluations: 0, findings: [] },
    }
    const { state } = stateWith(okScript, async () => empty)
    const event: HookEventLike = {
      tool: "edit",
      status: "completed",
      input: { filePath: "src/a.ts", newString: "clean" },
      result: { content: "edited" },
    }
    await handleExecuteAfter(event, state)
    const result = event.result as { content: string; metadata: { jevlint: { totalFindings: number } } }
    expect(result.metadata.jevlint.totalFindings).toBe(0)
    expect(result.content).toBe("edited")
  })

  test("swallows a thrown runCheck", async () => {
    const { state } = stateWith(okScript, async () => {
      throw new Error("boom")
    })
    const event: HookEventLike = {
      tool: "edit",
      status: "completed",
      input: { filePath: "src/a.ts", newString: "throw" },
      result: { content: "edited" },
    }
    await expect(handleExecuteAfter(event, state)).resolves.toBeUndefined()
    expect((event.result as { content: string }).content).toBe("edited")
  })
})
