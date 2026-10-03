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
import { probeBinary, probeDoctor, type JeVlintRuntime } from "./jevlint"
import { registerTool } from "./tool"
import { registerHook, shouldRegisterAutoCheck } from "./hook"

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

    // Detect + guide on credentials/config before enabling auto-check. A failed
    // doctor run disables the hook so every edit does not get a noisy note, but
    // the on-demand tool stays registered.
    let doctorOk = true
    if (runtime.binaryAvailable) {
      const doctor = await probeDoctor(options, projectDir)
      doctorOk = doctor.ok
      if (!doctor.ok && options.autoCheck !== "off") {
        console.warn(
          `[opencode-jevlint] ${doctor.detail}. Auto-check is disabled; run \`jevlint doctor\` to fix ` +
            "credentials/config. The jevlint_check tool is still available.",
        )
      }
    }

    await registerTool(ctx, runtime)

    if (shouldRegisterAutoCheck(options, runtime.binaryAvailable, doctorOk)) {
      await registerHook(ctx, runtime)
    }

    return () => {
      runtime.binaryAvailable = false
    }
  },
})
