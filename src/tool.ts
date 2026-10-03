/**
 * `jevlint_check` tool: lets the model run a jevlint check on demand.
 */

import type { Plugin } from "@opencode/plugin"
import {
  runCheck,
  toAbsolutePath,
  type CheckOutcome,
  type JeVlintRuntime,
} from "./jevlint"
import { summarize, summarizeError, type JeVlintMetadata } from "./summary"

export interface ToolInput {
  paths?: string[]
  changed?: boolean
  rule?: string
  severity?: string
}

export interface ToolResultPayload {
  content: string
  metadata: { jevlint: JeVlintMetadata }
}

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description: "File or directory paths to check, relative to the project or absolute. Defaults to the project directory.",
    },
    changed: {
      type: "boolean",
      description: "Only check files changed in the working copy (passes --changed to jevlint).",
    },
    rule: {
      type: "string",
      description: "Only report findings for this exact rule id.",
    },
    severity: {
      type: "string",
      description: "Comma-separated severity allow-list, e.g. \"error,warning\".",
    },
  },
  additionalProperties: false,
} as const

/** Defensive parse of the (untyped) tool input. */
export function parseToolInput(input: unknown): ToolInput {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const out: ToolInput = {}

  if (Array.isArray(record.paths)) {
    out.paths = record.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
  }
  if (typeof record.changed === "boolean") out.changed = record.changed
  if (typeof record.rule === "string" && record.rule.trim().length > 0) out.rule = record.rule.trim()
  if (typeof record.severity === "string" && record.severity.trim().length > 0) out.severity = record.severity.trim()
  return out
}

function parseSeverityFilter(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
}

/** Run the check and format the result. Never throws. */
export async function executeTool(
  runtime: JeVlintRuntime,
  input: unknown,
  signal?: AbortSignal,
): Promise<ToolResultPayload> {
  const parsed = parseToolInput(input)

  if (!runtime.binaryAvailable) {
    const { text, metadata } = summarizeError(
      "jevlint is not available. Install the jevlint binary and/or set the `binary` option.",
    )
    return { content: text, metadata: { jevlint: metadata } }
  }

  const paths = (parsed.paths ?? []).map((p) => toAbsolutePath(p, runtime.projectDir))

  let outcome: CheckOutcome
  try {
    outcome = await runCheck(runtime.options, runtime.projectDir, paths, {
      changed: parsed.changed,
      signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const { text, metadata } = summarizeError(`unexpected failure: ${message}`)
    return { content: text, metadata: { jevlint: metadata } }
  }

  if (outcome.kind === "error") {
    const { text, metadata } = summarizeError(outcome.message, {
      exitCode: outcome.exitCode,
      error: outcome.stderr ? `${outcome.message}: ${outcome.stderr}` : outcome.message,
    })
    return { content: text, metadata: { jevlint: metadata } }
  }

  const summary = summarize(outcome.report, {
    maxFindings: runtime.options.maxFindings,
    severity: parseSeverityFilter(parsed.severity),
    rule: parsed.rule,
  })
  return {
    content: summary.text,
    metadata: { jevlint: { ...summary.metadata, exitCode: outcome.exitCode } },
  }
}

export const JE_VLINT_NAMESPACE = { name: "jevlint", description: "Run jevlint checks against plain-language rules" }

/**
 * Register the `jevlint_check` tool.
 *
 * TODO(verify): the docs state a tool added under namespace `jevlint` with the
 * name `check` gets the effective id `jevlint_check` (unsupported characters
 * become `_`). That namespacing rule is documented but not runtime-verified
 * here; the literal name was chosen to match the documented behavior.
 */
export async function registerTool(ctx: Plugin.Context, runtime: JeVlintRuntime): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.namespace(JE_VLINT_NAMESPACE)
    editor.add({
      name: "check",
      description:
        "Run jevlint, which checks code against plain-language rules using Tree-sitter, and return a summary of findings. " +
        "Use `paths` to scope the check, `changed` for working-copy changes, and `rule`/`severity` to filter findings.",
      input: TOOL_INPUT_SCHEMA,
      options: { namespace: JE_VLINT_NAMESPACE.name },
      execute: async (input, context) => {
        const result = await executeTool(runtime, input, context.signal)
        return { content: result.content, metadata: result.metadata }
      },
    })
  })
}
