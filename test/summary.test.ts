import { describe, expect, test } from "bun:test"
import reportFixture from "./fixtures/report.json"
import { parseReport } from "../src/jevlint"
import {
  countBySeverity,
  filterFindings,
  formatFindingLine,
  summarize,
  summarizeError,
} from "../src/summary"
import type { Report } from "../src/jevlint"

const report = JSON.parse(JSON.stringify(reportFixture)) as Report

describe("parseReport (contract fixture)", () => {
  test("parses the fixture report", () => {
    const result = parseReport(JSON.stringify(reportFixture))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.scannedFiles).toBe(3)
    expect(result.report.codeUnits).toBe(12)
    expect(result.report.evaluations).toBe(24)
    expect(result.report.findings).toHaveLength(3)
    expect(result.report.findings[0]?.ruleId).toBe("no-todo-comments")
    expect(result.report.findings[0]?.startLine).toBe(10)
    expect(result.report.findings[0]?.severity).toBe("error")
  })

  test("tolerates leading log noise", () => {
    const noisy = `[jevlint] warming cache...\n${JSON.stringify(reportFixture)}\ntrailing line`
    const result = parseReport(noisy)
    expect(result.ok).toBe(true)
  })

  test("parses a report preceded by multiple non-JSON log lines", () => {
    const noisy = [
      "jevlint 1.2.3",
      "[info] loading config",
      "[warn] not a real object: still text",
      JSON.stringify(reportFixture),
    ].join("\n")
    const result = parseReport(noisy)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.findings).toHaveLength(3)
    expect(result.report.findings[0]?.ruleId).toBe("no-todo-comments")
  })

  test("reports errors instead of throwing", () => {
    expect(parseReport("").ok).toBe(false)
    expect(parseReport("not json").ok).toBe(false)
    expect(parseReport('{"findings": "nope"}').ok).toBe(false)
  })

  test("normalizes missing fields", () => {
    const result = parseReport('{"findings":[{"ruleId":"r","severity":"error"}]}')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.findings[0]).toMatchObject({ ruleId: "r", path: "", startLine: 0 })
  })
})

describe("summary", () => {
  test("counts by severity and bounds to maxFindings", () => {
    const summary = summarize(report, { maxFindings: 2 })
    expect(summary.metadata.totalFindings).toBe(3)
    expect(summary.metadata.shownFindings).toBe(2)
    expect(summary.metadata.truncated).toBe(true)
    expect(summary.metadata.countsBySeverity).toEqual({ error: 1, warning: 1, info: 1 })
    expect(summary.text.split("\n").length).toBe(4) // header + 2 findings + truncation note
    expect(summary.text).toContain("no-todo-comments")
    expect(summary.text).toContain("…and 1 more")
  })

  test("filters by severity and rule", () => {
    expect(filterFindings(report.findings, { severity: ["error"] })).toHaveLength(1)
    expect(filterFindings(report.findings, { rule: "prefer-early-return" })).toHaveLength(1)
    const summary = summarize(report, { maxFindings: 20, severity: ["error", "warning"] })
    expect(summary.metadata.totalFindings).toBe(2)
    expect(summary.text).not.toContain("descriptive-names")
  })

  test("reports a clean run", () => {
    const summary = summarize({ ...report, findings: [] }, { maxFindings: 20 })
    expect(summary.metadata.totalFindings).toBe(0)
    expect(summary.text).toContain("no findings")
  })

  test("formats a finding line", () => {
    expect(formatFindingLine(report.findings[0]!)).toBe(
      "- [error] no-todo-comments src/a.ts:10 — Do not leave TODO comments in committed code.",
    )
  })

  test("summarizeError marks ok false", () => {
    const summary = summarizeError("boom")
    expect(summary.metadata.ok).toBe(false)
    expect(summary.metadata.error).toBe("boom")
    expect(summary.text).toBe("jevlint: boom")
  })

  test("countBySeverity handles unknown severities", () => {
    expect(countBySeverity([{ severity: "" } as never])).toEqual({ unknown: 1 })
  })

  test("countBySeverity normalizes casing and whitespace", () => {
    expect(
      countBySeverity([
        { severity: "Error" } as never,
        { severity: " error " } as never,
        { severity: "WARNING" } as never,
      ]),
    ).toEqual({ error: 2, warning: 1 })
  })
})
