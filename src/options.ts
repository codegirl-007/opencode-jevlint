/**
 * Option parsing and validation for the opencode-jevlint plugin.
 *
 * Everything here is intentionally forgiving: a bad option value produces a
 * warning and falls back to a safe default rather than throwing during
 * `setup`, because a plugin must never break an OpenCode session.
 */

export type AutoCheckMode = "off" | "file" | "changed"

export interface JeVlintOptions {
  /** Explicit binary path or command name. Defaults to `jevlint` on PATH. */
  binary: string
  /** When to auto-run jevlint after edits. Defaults to `"file"`. */
  autoCheck: AutoCheckMode
  /** Optional `--config` path passed to `jevlint check`. */
  config?: string
  /** Hard timeout for a single jevlint invocation, in milliseconds. */
  timeoutMs: number
  /** Maximum number of findings embedded in a summary. */
  maxFindings: number
  /** Optional severity allow-list for reported findings (empty = all). */
  severity: string[]
  /** Extra raw arguments appended to `jevlint check` before the paths. */
  extraArgs: string[]
  /** Optional minimum required jevlint version, e.g. `"0.4.0"`. */
  minimumVersion?: string
}

export interface ParsedOptions {
  options: JeVlintOptions
  warnings: string[]
}

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_FINDINGS = 20

const AUTO_CHECK_MODES: readonly AutoCheckMode[] = ["off", "file", "changed"]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parsePositiveInt(value: unknown, fallback: number, warnings: string[], name: string): number {
  if (value === undefined) return fallback
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    warnings.push(`option \`${name}\` must be a positive integer; using ${fallback}`)
    return fallback
  }
  return n
}

function parseNonNegativeInt(value: unknown, fallback: number, warnings: string[], name: string): number {
  if (value === undefined) return fallback
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    warnings.push(`option \`${name}\` must be a non-negative integer; using ${fallback}`)
    return fallback
  }
  return n
}

/** Accepts an array of strings or a comma-separated string. */
function parseStringList(value: unknown, warnings: string[], name: string): string[] {
  if (value === undefined) return []
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  }
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const item of value) {
      const str = asNonEmptyString(item)
      if (str) out.push(str)
      else warnings.push(`option \`${name}\` contained a non-string entry; ignoring it`)
    }
    return out
  }
  warnings.push(`option \`${name}\` must be an array of strings or a comma-separated string; ignoring it`)
  return []
}

/**
 * Parse and validate raw plugin options from `ctx.options`.
 * Never throws.
 */
export function parseOptions(raw: unknown): ParsedOptions {
  const warnings: string[] = []
  const input = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && !isPlainObject(raw)) {
    warnings.push("plugin options must be an object; using defaults")
  }

  let binary = asNonEmptyString(input.binary)
  if (input.binary !== undefined && !binary) {
    warnings.push("option `binary` must be a non-empty string; using `jevlint`")
  }
  binary ??= "jevlint"

  let autoCheck: AutoCheckMode = "file"
  if (input.autoCheck !== undefined) {
    const candidate = asNonEmptyString(input.autoCheck)
    if (candidate && (AUTO_CHECK_MODES as readonly string[]).includes(candidate)) {
      autoCheck = candidate as AutoCheckMode
    } else {
      warnings.push(`option \`autoCheck\` must be one of ${AUTO_CHECK_MODES.join(" | ")}; using "file"`)
    }
  }

  const config = asNonEmptyString(input.config)
  if (input.config !== undefined && !config) {
    warnings.push("option `config` must be a non-empty string; ignoring it")
  }

  const timeoutMs = parsePositiveInt(input.timeoutMs, DEFAULT_TIMEOUT_MS, warnings, "timeoutMs")
  const maxFindings = parseNonNegativeInt(input.maxFindings, DEFAULT_MAX_FINDINGS, warnings, "maxFindings")
  const severity = parseStringList(input.severity, warnings, "severity")
  const extraArgs = parseStringList(input.extraArgs, warnings, "extraArgs")

  const minimumVersion = asNonEmptyString(input.minimumVersion)
  if (input.minimumVersion !== undefined && !minimumVersion) {
    warnings.push("option `minimumVersion` must be a non-empty string; ignoring it")
  }

  return {
    warnings,
    options: {
      binary,
      autoCheck,
      config,
      timeoutMs,
      maxFindings,
      severity,
      extraArgs,
      minimumVersion,
    },
  }
}

/** Parse a `MAJOR.MINOR.PATCH[-pre]` version into comparable numeric parts. */
export function parseSemver(value: string): { parts: number[]; pre: string } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim())
  if (!match) return undefined
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? "",
  }
}

/**
 * Compare two semver strings. Returns -1, 0, or 1.
 * A version with a pre-release tag sorts before the same version without one.
 * Unparseable values compare as 0 (equal).
 */
export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i++) {
    const l = left.parts[i] ?? 0
    const r = right.parts[i] ?? 0
    if (l < r) return -1
    if (l > r) return 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === "") return 1
  if (right.pre === "") return -1
  return left.pre < right.pre ? -1 : 1
}
