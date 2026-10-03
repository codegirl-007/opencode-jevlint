/**
 * opencode-jevlint — an OpenCode V2 plugin that wraps the jevlint CLI.
 *
 * - registers `jevlint_check` so the model can run checks on demand
 * - registers an `execute.after` hook that auto-checks edited files and
 *   attaches a bounded findings summary to the tool result
 *
 * Binary handling is detect + guide only: if jevlint is missing we warn once
 * during setup and disable auto-check. The plugin never stores credentials.
 */

import { Plugin } from "@opencode/plugin"
import { parseOptions } from "./options"
import { probeBinary, type JeVlintRuntime } from "./jevlint"
import { registerTool } from "./tool"
import { registerHook } from "./hook"

export default Plugin.define({
  id: "opencode-jevlint",
  async setup(ctx) {
    const { options, warnings } = parseOptions(ctx.options)

    for (const warning of warnings) {
      console.warn(`[opencode-jevlint] ${warning}`)
    }

    const projectDir = ctx.location.project?.canonical ?? ctx.location.directory

    const runtime: JeVlintRuntime = {
      options,
      projectDir,
      binaryAvailable: false,
    }

    // Probe the binary once. `probeBinary` never throws.
    const probe = await probeBinary(options, projectDir)
    runtime.binaryAvailable = probe.ok
    if (probe.ok) {
      console.info(`[opencode-jevlint] ${probe.message}; autoCheck=${options.autoCheck}`)
    } else {
      console.warn(
        `[opencode-jevlint] ${probe.message}. ` +
          "Install jevlint (https://github.com/codegirl-007/jevlint) or set the `binary` option. " +
          "Auto-check is disabled; the jevlint_check tool will report this.",
      )
    }

    await registerTool(ctx, runtime)

    if (options.autoCheck !== "off" && runtime.binaryAvailable) {
      await registerHook(ctx, runtime)
    }

    return () => {
      runtime.binaryAvailable = false
    }
  },
})
