import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runProcess } from "../src/jevlint"

let workDir = ""
let sleepScript = ""

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "jevlint-process-test-"))
  sleepScript = join(workDir, "jevlint-sleep")
  // `exec` replaces the shell so the kill signal reaches the sleeper directly
  // and the stdout/stderr pipes close promptly.
  await writeFile(sleepScript, "#!/usr/bin/env bash\nexec sleep 5\n", "utf8")
  await chmod(sleepScript, 0o755)
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

describe("runProcess", () => {
  test("kills a process that exceeds the timeout", async () => {
    const result = await runProcess({ command: sleepScript, args: [], cwd: workDir, timeoutMs: 150 })
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
  })

  test("kills a process when the signal aborts", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const result = await runProcess({
      command: sleepScript,
      args: [],
      cwd: workDir,
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  })

  test("kills immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runProcess({
      command: sleepScript,
      args: [],
      cwd: workDir,
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  })

  test("reports a spawn error for a missing binary", async () => {
    const result = await runProcess({
      command: join(workDir, "does-not-exist"),
      args: [],
      cwd: workDir,
      timeoutMs: 1_000,
    })
    expect(result.spawnError).toBeDefined()
    expect(result.timedOut).toBe(false)
  })
})
