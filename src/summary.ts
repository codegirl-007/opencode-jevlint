/**
 * Convert a jevlint `Report` into a bounded, human-readable summary plus a
 * structured metadata object for tool results.
 */

import type { Finding, Report } from "./jevlint"

export interface SummaryOptions {
  maxFindings: number
  /** Optional severity allow-list (empty/undefined = all severities). */
  severity?: readonly string[]
  /** Optional exact rule id filter. */
  rule?: string
}

export interface JeVlintMetadata {
  ok: boolean
  tool: "jevlint"
  exitCode?: number
  scannedFiles?: number
  codeUnits?: number
  evaluations?: number
  /** Alias for `totalFindings`, matching the plugin contract. */
  findings: number
  totalFindings: number
  shownFindings: number
  truncated: boolean
  countsBySeverity: Record<string, number>
  /** Bounded human-readable summary (same text returned as content). */
  summary?: string
  error?: string
}

export interface Summary {
  text: string
  metadata: JeVlintMetadata
}

const MAX_DESCRIPTION_LENGTH = 200
const MAX_SNIPPET_LENGTH = 160

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

/** Filter findings by severity and rule id, preserving order. */
export function filterFindings(
  findings: readonly Finding[],
  options: Pick<SummaryOptions, "severity" | "rule"> = {},
): Finding[] {
  const severities = options.severity?.map((s) => s.toLowerCase()).filter((s) => s.length > 0) ?? []
  const rule = options.rule?.toLowerCase()
  return findings.filter((finding) => {
    if (severities.length > 0 && !severities.includes(finding.severity.toLowerCase())) return false
    if (rule && finding.ruleId.toLowerCase() !== rule) return false
    return true
  })
}

export function countBySeverity(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const finding of findings) {
    const key = finding.severity || "unknown"
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return "none"
  return entries.map(([severity, count]) => `${severity} ${count}`).join(", ")
}

export function formatFindingLine(finding: Finding): string {
  const location = finding.path
    ? `${finding.path}${finding.startLine ? `:${finding.startLine}` : ""}`
    : "(unknown path)"
  const description = truncate(finding.description || finding.name || finding.kind || "(no description)", MAX_DESCRIPTION_LENGTH)
  const rule = finding.ruleId || "(no rule)"
  return `- [${finding.severity || "unknown"}] ${rule} ${location} — ${description}`
}

/**
 * Build a bounded summary from a report.
 *
 * `maxFindings` limits how many finding lines are embedded; `totalFindings`
 * in metadata always reflects the full filtered count.
 */
export function summarize(report: Report, options: SummaryOptions): Summary {
  const findings = filterFindings(report.findings, options)
  const totalFindings = findings.length
  const maxFindings = Number.isFinite(options.maxFindings) && options.maxFindings >= 0 ? options.maxFindings : 0
  const shown = findings.slice(0, maxFindings)
  const countsBySeverity = countBySeverity(findings)
  const truncated = totalFindings > shown.length

  const lines: string[] = []
  if (totalFindings === 0) {
    lines.push(`jevlint: no findings (${report.scannedFiles} file(s), ${report.evaluations} evaluation(s))`)
  } else {
    lines.push(
      `jevlint: ${totalFindings} finding(s) (${formatCounts(countsBySeverity)}) in ${report.scannedFiles} file(s)`,
    )
    for (const finding of shown) lines.push(formatFindingLine(finding))
    if (truncated) lines.push(`…and ${totalFindings - shown.length} more (raise maxFindings to see them)`)
  }

  return {
    text: lines.join("\n"),
    metadata: {
      ok: true,
      tool: "jevlint",
      scannedFiles: report.scannedFiles,
      codeUnits: report.codeUnits,
      evaluations: report.evaluations,
      findings: totalFindings,
      totalFindings,
      shownFindings: shown.length,
      truncated,
      countsBySeverity,
      summary: lines.join("\n"),
    },
  }
}

/** Build a summary/metadata object for a failed check. */
export function summarizeError(message: string, extra: Partial<JeVlintMetadata> = {}): Summary {
  const text = `jevlint: ${message}`
  return {
    text,
    metadata: {
      ok: false,
      tool: "jevlint",
      findings: 0,
      totalFindings: 0,
      shownFindings: 0,
      truncated: false,
      countsBySeverity: {},
      error: message,
      summary: text,
      ...extra,
    },
  }
}

/** Optional snippet formatter, exported for tests and future UI use. */
export function formatSnippet(finding: Finding): string | undefined {
  if (!finding.snippet) return undefined
  return truncate(finding.snippet, MAX_SNIPPET_LENGTH)
}
