/**
 * jevlint CLI wrapper: binary probing, argument construction, process spawning
 * and JSON report parsing.
 *
 * Runtime-agnostic: prefers `Bun.spawn` (OpenCode's runtime) and falls back to
 * `node:child_process`. Every external interaction is guarded so a failure
 * returns a typed error instead of throwing.
 */

import { isAbsolute, resolve as resolvePath } from "node:path"
import { compareVersions, type JeVlintOptions } from "./options"

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface Finding {
  ruleId: string
  description: string
  severity: string
  status: string
  path: string
  language?: string
  kind?: string
  name?: string
  startLine: number
  endLine?: number
  startColumn?: number
  endColumn?: number
  snippet?: string
  locations?: unknown
  /** Index signature kept so unexpected jevlint fields survive normalization. */
  [key: string]: unknown
}

export interface Report {
  scannedFiles: number
  codeUnits: number
  evaluations: number
  findings: Finding[]
}

export interface RunProcessResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  /** Set when the process could not be spawned at all (e.g. ENOENT). */
  spawnError?: string
  durationMs: number
}

export type CheckOutcome =
  | { kind: "ok"; report: Report; exitCode: number; durationMs: number }
  | { kind: "error"; message: string; exitCode?: number; stderr?: string; durationMs: number }

export interface BinaryProbe {
  ok: boolean
  version?: string
  message: string
}

/** Runtime state shared by the tool and the auto-check hook. */
export interface JeVlintRuntime {
  options: JeVlintOptions
  /** Directory used as `cwd` for every jevlint invocation. */
  projectDir: string
  /** Whether `jevlint version` succeeded during setup. */
  binaryAvailable: boolean
}

/* -------------------------------------------------------------------------- */
/* Argument building                                                          */
/* -------------------------------------------------------------------------- */

export interface BuildCheckArgsInput {
  paths?: readonly string[]
  changed?: boolean
}

/**
 * Build the argv for a check (excluding the binary itself).
 *
 * Shape: `check [--changed] --format json --concurrency 1 [--config X] [extraArgs] <paths...>`
 */
export function buildCheckArgs(options: JeVlintOptions, input: BuildCheckArgsInput = {}): string[] {
  const args: string[] = ["check"]
  if (input.changed) args.push("--changed")
  args.push("--format", "json", "--concurrency", "1")
  if (options.config) args.push("--config", options.config)
  for (const extra of options.extraArgs) args.push(extra)
  for (const path of input.paths ?? []) {
    if (typeof path === "string" && path.length > 0) args.push(path)
  }
  return args
}

/** Resolve a possibly relative path against the project directory. */
export function toAbsolutePath(path: string, projectDir: string): string {
  return isAbsolute(path) ? path : resolvePath(projectDir, path)
}

/* -------------------------------------------------------------------------- */
/* Process spawning                                                           */
/* -------------------------------------------------------------------------- */

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${code}: ${error.message}` : error.message
  }
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

interface SpawnInput {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  env?: Record<string, string | undefined>
}

function hasBunSpawn(): boolean {
  return typeof (globalThis as Record<string, unknown>).Bun === "object" &&
    typeof ((globalThis as Record<string, unknown>).Bun as { spawn?: unknown }).spawn === "function"
}

async function streamToText(stream: unknown): Promise<string> {
  if (!stream) return ""
  // Bun may hand back a file descriptor number when not piped; ignore those.
  if (typeof stream === "number") return ""
  if (typeof (stream as { getReader?: unknown }).getReader === "function") {
    try {
      return await new Response(stream as ReadableStream<Uint8Array>).text()
    } catch {
      return ""
    }
  }
  return ""
}

async function runWithBun(input: SpawnInput): Promise<RunProcessResult> {
  const started = Date.now()
  const bun = (globalThis as Record<string, unknown>).Bun as {
    spawn: (cmd: string[], options: Record<string, unknown>) => {
      stdout?: unknown
      stderr?: unknown
      exited: Promise<number>
      kill: () => void
    }
  }

  let proc: ReturnType<typeof bun.spawn>
  try {
    proc = bun.spawn([input.command, ...input.args], {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: false,
      spawnError: errorMessage(error),
      durationMs: Date.now() - started,
    }
  }

  let timedOut = false
  let aborted = false
  const kill = () => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, input.timeoutMs)
  const onAbort = () => {
    aborted = true
    kill()
  }
  if (input.signal) {
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener("abort", onAbort, { once: true })
  }

  try {
    const [stdout, stderr, code] = await Promise.all([
      streamToText(proc.stdout),
      streamToText(proc.stderr),
      proc.exited,
    ])
    return { code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started }
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: "",
      timedOut,
      aborted,
      spawnError: errorMessage(error),
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", onAbort)
  }
}

async function runWithNode(input: SpawnInput): Promise<RunProcessResult> {
  const started = Date.now()
  let spawn: typeof import("node:child_process").spawn
  try {
    ;({ spawn } = await import("node:child_process"))
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: false,
      spawnError: `node:child_process unavailable: ${errorMessage(error)}`,
      durationMs: Date.now() - started,
    }
  }

  return await new Promise<RunProcessResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let aborted = false
    let settled = false

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: { ...process.env, ...(input.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        spawnError: errorMessage(error),
        durationMs: Date.now() - started,
      })
      return
    }

    const finish = (result: RunProcessResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const kill = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill("SIGKILL")
    }, input.timeoutMs)
    const onAbort = () => {
      aborted = true
      kill("SIGKILL")
    }
    if (input.signal) {
      if (input.signal.aborted) onAbort()
      else input.signal.addEventListener("abort", onAbort, { once: true })
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on("error", (error) => {
      finish({
        code: null,
        stdout,
        stderr,
        timedOut,
        aborted,
        spawnError: errorMessage(error),
        durationMs: Date.now() - started,
      })
    })
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started })
    })
  })
}

/** Run a process, preferring Bun.spawn and falling back to node:child_process. */
export async function runProcess(input: SpawnInput): Promise<RunProcessResult> {
  return hasBunSpawn() ? runWithBun(input) : runWithNode(input)
}

/* -------------------------------------------------------------------------- */
/* Report parsing                                                             */
/* -------------------------------------------------------------------------- */

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Extract the outermost JSON object from a string that may contain log noise. */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

function normalizeFinding(raw: unknown): Finding {
  const f = isRecord(raw) ? raw : {}
  return {
    ...f,
    ruleId: asString(f.ruleId ?? f.ruleID ?? f.rule),
    description: asString(f.description),
    severity: asString(f.severity, "unknown"),
    status: asString(f.status),
    path: asString(f.path ?? f.file),
    language: asOptionalString(f.language),
    kind: asOptionalString(f.kind),
    name: asOptionalString(f.name),
    startLine: asNumber(f.startLine),
    endLine: isRecord(f) && f.endLine !== undefined ? asNumber(f.endLine) : undefined,
    startColumn: f.startColumn !== undefined ? asNumber(f.startColumn) : undefined,
    endColumn: f.endColumn !== undefined ? asNumber(f.endColumn) : undefined,
    snippet: asOptionalString(f.snippet),
    locations: f.locations,
  }
}

export type ParseReportResult = { ok: true; report: Report } | { ok: false; error: string }

/** Parse stdout from `jevlint check --format json`. Tolerant of log noise. */
export function parseReport(stdout: string): ParseReportResult {
  const text = typeof stdout === "string" ? stdout.trim() : ""
  if (text.length === 0) return { ok: false, error: "empty stdout" }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const candidate = extractJsonObject(text)
    if (!candidate) return { ok: false, error: "stdout did not contain a JSON object" }
    try {
      parsed = JSON.parse(candidate)
    } catch (error) {
      return { ok: false, error: `invalid JSON: ${errorMessage(error)}` }
    }
  }

  if (!isRecord(parsed)) return { ok: false, error: "report was not a JSON object" }

  const rawFindings = parsed.findings
  if (rawFindings !== undefined && !Array.isArray(rawFindings)) {
    return { ok: false, error: "report `findings` was not an array" }
  }

  return {
    ok: true,
    report: {
      scannedFiles: asNumber(parsed.scannedFiles),
      codeUnits: asNumber(parsed.codeUnits),
      evaluations: asNumber(parsed.evaluations),
      findings: Array.isArray(rawFindings) ? rawFindings.map(normalizeFinding) : [],
    },
  }
}

/* -------------------------------------------------------------------------- */
/* High-level helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Run `jevlint check` and parse the report. Never throws. */
export async function runCheck(
  options: JeVlintOptions,
  projectDir: string,
  paths: readonly string[],
  extra: { changed?: boolean; signal?: AbortSignal } = {},
): Promise<CheckOutcome> {
  const args = buildCheckArgs(options, { paths, changed: extra.changed })
  const run = await runProcess({
    command: options.binary,
    args,
    cwd: projectDir,
    timeoutMs: options.timeoutMs,
    signal: extra.signal,
  })

  if (run.aborted) {
    return { kind: "error", message: "jevlint check was cancelled", durationMs: run.durationMs }
  }
  if (run.timedOut) {
    return {
      kind: "error",
      message: `jevlint timed out after ${options.timeoutMs}ms`,
      durationMs: run.durationMs,
    }
  }
  if (run.spawnError) {
    return {
      kind: "error",
      message: `could not run jevlint: ${run.spawnError}`,
      durationMs: run.durationMs,
    }
  }

  const stderr = run.stderr.trim()
  if (run.code === 2) {
    return {
      kind: "error",
      message: "jevlint reported a config/runtime error (exit 2)",
      exitCode: 2,
      stderr: stderr || undefined,
      durationMs: run.durationMs,
    }
  }

  const parsed = parseReport(run.stdout)
  if (!parsed.ok) {
    // Exit 0/1 are expected to carry a report; anything else is an error.
    if (run.code !== 0 && run.code !== 1) {
      return {
        kind: "error",
        message: `jevlint exited ${run.code} without a parseable report`,
        exitCode: run.code ?? undefined,
        stderr: stderr || undefined,
        durationMs: run.durationMs,
      }
    }
    return {
      kind: "error",
      message: `could not parse jevlint report: ${parsed.error}`,
      exitCode: run.code ?? undefined,
      stderr: stderr || undefined,
      durationMs: run.durationMs,
    }
  }

  return { kind: "ok", report: parsed.report, exitCode: run.code ?? 0, durationMs: run.durationMs }
}

/** Run `jevlint version` and extract the semantic version. Never throws. */
export async function getVersion(
  options: JeVlintOptions,
  projectDir: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; version?: string; raw?: string; message?: string }> {
  const run = await runProcess({
    command: options.binary,
    args: ["version"],
    cwd: projectDir,
    timeoutMs: Math.min(options.timeoutMs, 15_000),
    signal,
  })
  if (run.spawnError) {
    return { ok: false, message: `jevlint binary not found or not executable (${run.spawnError})` }
  }
  if (run.timedOut) return { ok: false, message: "jevlint version timed out" }
  if (run.aborted) return { ok: false, message: "jevlint version was cancelled" }
  const raw = `${run.stdout}\n${run.stderr}`.trim()
  if (run.code !== 0) {
    return { ok: false, raw, message: `jevlint version exited with code ${run.code}` }
  }
  const match = /v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(raw)
  return { ok: true, version: match?.[1], raw }
}

/**
 * Detect + guide only: verify the binary works and satisfies `minimumVersion`.
 * Never throws; the caller decides whether to warn and disable auto-check.
 */
export async function probeBinary(
  options: JeVlintOptions,
  projectDir: string,
  signal?: AbortSignal,
): Promise<BinaryProbe> {
  const result = await getVersion(options, projectDir, signal)
  if (!result.ok) {
    return {
      ok: false,
      message: result.message ?? "jevlint is unavailable",
    }
  }
  if (options.minimumVersion) {
    if (!result.version) {
      return {
        ok: false,
        message: `could not determine jevlint version to compare against minimumVersion ${options.minimumVersion}`,
      }
    }
    if (compareVersions(result.version, options.minimumVersion) < 0) {
      return {
        ok: false,
        version: result.version,
        message: `jevlint ${result.version} is older than the required minimumVersion ${options.minimumVersion}`,
      }
    }
  }
  return { ok: true, version: result.version, message: result.version ? `jevlint ${result.version}` : "jevlint available" }
}
