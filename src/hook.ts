/**
 * Auto-check hook.
 *
 * After an edit tool completes, run jevlint on all edited files (file-scoped)
 * and attach a bounded findings summary to the tool result. All failures are
 * swallowed and reported as a one-line note instead.
 */

import type { Plugin } from "@opencode/plugin"
import { runCheck, toAbsolutePath, type CheckOutcome, type JeVlintRuntime } from "./jevlint"
import { summarize, summarizeError } from "./summary"

/**
 * Built-in edit tool names we recognize even before inspecting schemas.
 *
 * TODO(verify): exact built-in edit tool ids and their input field names. The
 * docs describe `ctx.tool.list()` but do not enumerate built-ins; these names
 * plus the schema fallback are defensive guesses, confirmed only against the
 * installed `@opencode/plugin`/schema types (which describe shapes, not ids).
 */
export const KNOWN_EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "multiedit",
  "multi_edit",
  "multi-edit",
  "patch",
  "apply_patch",
  "applypatch",
  "notebookedit",
  "notebook_edit",
  "str_replace",
  "strreplace",
  "create",
  "create_file",
])

/** Built-in tools that are definitely not edits and must never trigger a check. */
export const KNOWN_NON_EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "list",
  "ls",
  "glob",
  "grep",
  "search",
  "webfetch",
  "websearch",
  "fetch",
  "bash",
  "shell",
  "task",
  "skill",
  "todowrite",
  "todoread",
  "question",
])

/** Input keys that indicate a tool writes content (so it is likely an edit). */
const WRITE_CONTENT_KEYS: readonly string[] = [
  "content",
  "newString",
  "new_string",
  "oldString",
  "old_string",
  "newText",
  "new_text",
  "patch",
  "diff",
  "edits",
]

/** Candidate input keys that may hold the edited path. */
export const PATH_KEYS: readonly string[] = [
  "filePath",
  "file_path",
  "path",
  "file",
  "filename",
  "fileName",
  "target",
  "targetFile",
]

/** Array input keys that may hold multiple edited paths or multi-edit entries. */
export const PATH_ARRAY_KEYS: readonly string[] = ["edits", "files", "changes", "paths", "targets"]

/** Candidate input keys that may hold the new content, used for debouncing. */
const CONTENT_KEYS: readonly string[] = [
  "content",
  "newString",
  "new_string",
  "newText",
  "new_text",
  "text",
  "patch",
  "diff",
  "edits",
  "files",
]

const DEBOUNCE_TTL_MS = 10 * 60_000
const DEBOUNCE_MAX_ENTRIES = 500
const NO_CONTENT_BUCKET_MS = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function schemaProperties(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema)) return undefined
  const direct = schema.properties
  if (isRecord(direct)) return direct
  const nested = schema.jsonSchema
  if (isRecord(nested) && isRecord(nested.properties)) return nested.properties as Record<string, unknown>
  return undefined
}

/**
 * Discover edit tools from `ctx.tool.list()`. Uses known names first, then
 * falls back to inspecting a tool's input schema. Only write-like tools are
 * accepted so read/list/search tools never trigger an auto-check.
 */
export function discoverEditToolIds(tools: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const tool of tools) {
    if (!isRecord(tool)) continue
    const id = typeof tool.id === "string" ? tool.id : typeof tool.name === "string" ? tool.name : ""
    if (!id) continue
    const lower = id.toLowerCase()
    if (KNOWN_EDIT_TOOL_NAMES.has(lower)) {
      ids.push(id)
      continue
    }
    if (KNOWN_NON_EDIT_TOOL_NAMES.has(lower)) continue
    const properties = schemaProperties(tool.input)
    if (!properties) continue
    const hasPath = PATH_KEYS.some((key) => key in properties)
    const writesContent = WRITE_CONTENT_KEYS.some((key) => key in properties)
    if (hasPath && writesContent) ids.push(id)
  }
  return ids
}

export function isEditTool(name: string, editToolIds: ReadonlySet<string>): boolean {
  if (editToolIds.has(name)) return true
  return KNOWN_EDIT_TOOL_NAMES.has(name.toLowerCase())
}

/**
 * Extract every plausible edited path from a tool input object.
 *
 * Collects all values under `PATH_KEYS` plus string entries nested in the
 * array keys (`edits`, `files`, `changes`, `paths`, `targets`), recursing into
 * array items. Order is preserved and exact-string duplicates are dropped
 * (case-sensitive; the first occurrence wins).
 */
export function extractEditedPaths(input: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const add = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0) return
    if (seen.has(value)) return
    seen.add(value)
    out.push(value)
  }

  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || !isRecord(value)) return
    for (const key of PATH_KEYS) add(value[key])
    for (const key of PATH_ARRAY_KEYS) {
      const entry = value[key]
      if (!Array.isArray(entry)) continue
      for (const item of entry) {
        if (typeof item === "string") add(item)
        else if (isRecord(item)) visit(item, depth + 1)
      }
    }
  }

  visit(input, 0)
  return out
}

function collectContent(value: unknown, depth = 0): string {
  if (depth > 4) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((item) => collectContent(item, depth + 1)).join("\u0000")
  if (isRecord(value)) {
    let out = ""
    for (const key of CONTENT_KEYS) {
      if (key in value) out += `${key}:${collectContent(value[key], depth + 1)}\u0001`
    }
    return out
  }
  return ""
}

/** FNV-1a 32-bit hash, returned as hex. */
export function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function debounceKey(paths: readonly string[] | string, input: unknown, now = Date.now()): string {
  const pathKey = typeof paths === "string" ? paths : paths.join("\u0000")
  const content = collectContent(input)
  const suffix = content.length > 0 ? hashString(content) : `t${Math.floor(now / NO_CONTENT_BUCKET_MS)}`
  return hashString(`${pathKey}\u0000${suffix}`)
}

function pruneDebounce(debounce: Map<string, number>, now: number): void {
  if (debounce.size <= DEBOUNCE_MAX_ENTRIES) return
  for (const [key, at] of debounce) {
    if (now - at > DEBOUNCE_TTL_MS) debounce.delete(key)
  }
  // Still too large: drop the oldest entries (Map preserves insertion order).
  while (debounce.size > DEBOUNCE_MAX_ENTRIES) {
    const oldest = debounce.keys().next()
    if (oldest.done) break
    debounce.delete(oldest.value)
  }
}

/** The shape we rely on from the `execute.after` event (verified against types). */
export interface HookEventLike {
  tool?: string
  status?: string
  input?: unknown
  result?: unknown
  error?: unknown
}

export interface HookState extends JeVlintRuntime {
  editToolIds: ReadonlySet<string>
  debounce: Map<string, number>
  runCheck: (
    paths: readonly string[],
    options: { changed?: boolean; signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<CheckOutcome>
}

/**
 * Decide whether to register the auto-check hook.
 *
 * Auto-check requires the binary to be available AND `jevlint doctor` to report
 * a healthy config/credentials setup. The on-demand `jevlint_check` tool is
 * registered regardless; this only gates the hook, so a missing credential or
 * config does not produce a noisy note on every edit.
 */
export function shouldRegisterAutoCheck(
  options: Pick<JeVlintRuntime["options"], "autoCheck">,
  binaryAvailable: boolean,
  doctorOk: boolean,
): boolean {
  return options.autoCheck !== "off" && binaryAvailable && doctorOk
}

/**
 * Merge a `jevlint` metadata block (and optional note) into a tool result.
 *
 * TODO(verify): whether `result.metadata` is surfaced to the model or only to
 * the UI. We also append the summary to `result.content` because that is the
 * documented tool output field and is definitely shown to the model.
 */
export function attachResultMetadata(
  result: unknown,
  metadata: object,
  note?: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(result) ? { ...result } : {}
  const existing = isRecord(base.metadata) ? base.metadata : {}
  base.metadata = { ...existing, jevlint: metadata }
  if (note) {
    const content = base.content
    if (typeof content === "string" && content.length > 0) {
      base.content = `${content}\n\n${note}`
    } else if (Array.isArray(content)) {
      base.content = [...content, { type: "text", text: note }]
    } else {
      base.content = note
    }
  }
  return base
}

/**
 * Core hook logic. Exported so it can be tested without a live OpenCode
 * context. Never throws.
 */
export async function handleExecuteAfter(event: HookEventLike, state: HookState): Promise<void> {
  try {
    if (event.status !== "completed") return
    const tool = typeof event.tool === "string" ? event.tool : ""
    if (!tool || !isEditTool(tool, state.editToolIds)) return

    const editedPaths = extractEditedPaths(event.input)
    if (editedPaths.length === 0) return

    const now = Date.now()
    const key = debounceKey(editedPaths, event.input, now)
    if (state.debounce.has(key)) return
    state.debounce.set(key, now)
    pruneDebounce(state.debounce, now)

    const outcome =
      state.options.autoCheck === "changed"
        ? await state.runCheck([], { changed: true })
        : await state.runCheck(editedPaths.map((path) => toAbsolutePath(path, state.projectDir)), {
            timeoutMs: state.options.autoCheckTimeoutMs,
          })

    if (outcome.kind === "ok") {
      const summary = summarize(outcome.report, { maxFindings: state.options.maxFindings })
      const note = summary.metadata.totalFindings > 0 ? summary.text : undefined
      event.result = attachResultMetadata(event.result, { ...summary.metadata, exitCode: outcome.exitCode }, note)
    } else {
      const summary = summarizeError(outcome.message, { exitCode: outcome.exitCode })
      event.result = attachResultMetadata(event.result, summary.metadata, summary.text)
    }
  } catch {
    // Fail soft: never let the wrapper break an OpenCode session.
  }
}

/** Register the `execute.after` hook unless auto-check is disabled. */
export async function registerHook(ctx: Plugin.Context, runtime: JeVlintRuntime): Promise<void> {
  let editToolIds: ReadonlySet<string> = new Set<string>()
  try {
    const tools = await ctx.tool.list()
    editToolIds = new Set(discoverEditToolIds(tools as readonly unknown[]))
  } catch {
    // Fall back to the known-name list.
  }

  const state: HookState = {
    ...runtime,
    editToolIds,
    debounce: new Map<string, number>(),
    runCheck: (paths, extra) => runCheck(runtime.options, runtime.projectDir, paths, extra),
  }

  await ctx.tool.hook("execute.after", async (event) => {
    await handleExecuteAfter(event as unknown as HookEventLike, state)
  })
}
