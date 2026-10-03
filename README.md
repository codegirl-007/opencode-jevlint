# opencode-jevlint

An [OpenCode](https://opencode.ai/v2/) V2 plugin that wraps the [`jevlint`](https://github.com/codegirl-007/jevlint)
CLI. `jevlint` checks code against plain-language rules using Tree-sitter plus a decision API.

The plugin:

- registers a `jevlint_check` tool so the model can run checks on demand, and
- auto-runs `jevlint` after edits (file-scoped by default) and attaches a bounded findings summary to the edit
  tool result.

It is **detect + guide only**: it never downloads or installs the `jevlint` binary, and it never stores credentials.

## Requirements

- OpenCode V2 (this plugin exports only the V2 `setup()` lifecycle; there is no V1 `server()` export).
- The `jevlint` binary available on `PATH`, or an explicit `binary` option pointing at it.
- Credentials for `jevlint`'s decision API, supplied through the environment (see below).

## Install

```sh
bun add opencode-jevlint
# or: npm install opencode-jevlint
```

Then add it to `opencode.jsonc`. Use the object form to pass options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-jevlint",
      "options": {
        "autoCheck": "file",
        "maxFindings": 20
      }
    }
  ]
}
```

Plugins in `.opencode/plugins/` are loaded automatically; a published package such as this one must be listed under
`plugins` as shown above.

## Install the `jevlint` binary

Pick one of:

- **GitHub Releases** — download the archive for your platform from
  <https://github.com/codegirl-007/jevlint/releases>, unpack it, and put `jevlint` somewhere on your `PATH`.
- **Go install** — with Go 1.26+:

  ```sh
  go install github.com/codegirl-007/jevlint/cmd/jevlint@latest
  ```

  Make sure `$(go env GOPATH)/bin` is on your `PATH`.

Verify the installation and your credentials at any time with:

```sh
jevlint version
jevlint doctor
```

If the binary is missing, the plugin warns once during setup and disables auto-check. The `jevlint_check` tool stays
registered and returns a short note explaining how to fix it.

## Credentials

Set these in the environment that launches OpenCode. The plugin reads neither key nor config; `jevlint` does.

- `TYPESAFE_API_KEY`, **or**
- `JEVLINT_PROVIDER=cloudflare` together with
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AUTH_TOKEN`.

Never commit these values. The plugin does not persist them anywhere.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `binary` | `string` | `"jevlint"` | Explicit path to the `jevlint` binary, or a command name resolved on `PATH`. |
| `autoCheck` | `"off" \| "file" \| "changed"` | `"file"` | When to auto-run after edits. `"off"` disables the hook; `"file"` checks only the edited file; `"changed"` checks working-copy changes. |
| `config` | `string` | – | Passed as `--config <path>` to `jevlint check`. |
| `timeoutMs` | `number` | `30000` | Hard timeout for one on-demand `jevlint` invocation (the `jevlint_check` tool). |
| `autoCheckTimeoutMs` | `number` | `10000` | Shorter timeout for the synchronous auto-check hook. Bounds how much latency the hook may add to an edit result. |
| `concurrency` | `number` | `1` | Number of parallel workers, passed as `--concurrency <n>` to `jevlint check`. |
| `maxFindings` | `number` | `20` | Maximum number of findings embedded in a summary. |
| `severity` | `string[]` or comma string | `[]` (all) | Severity allow-list for reported findings, e.g. `["error", "warning"]`. |
| `extraArgs` | `string[]` | `[]` | Extra raw arguments appended to `jevlint check` before the paths, e.g. `["--refresh-cache"]`. |
| `minimumVersion` | `string` | – | Minimum required `jevlint` version. If the installed binary is older, setup warns and disables auto-check. |

Invalid option values produce a warning and fall back to the default; they never throw.

## The `jevlint_check` tool

The model can call `jevlint_check` with:

| Input | Type | Description |
| --- | --- | --- |
| `paths` | `string[]` | Files or directories to check, relative to the project or absolute. Defaults to the project directory. |
| `changed` | `boolean` | Only check working-copy changes (`--changed`). |
| `rule` | `string` | Only report findings for this exact rule id. |
| `severity` | `string` | Comma-separated severity allow-list, e.g. `"error,warning"`. |

The result contains a bounded text summary and structured `metadata.jevlint` (`ok`, `findings`, `totalFindings`,
`countsBySeverity`, `truncated`, …).

Under the hood the plugin runs:

```sh
jevlint check --format json --concurrency <n> [--config <path>] [extraArgs] <paths...>
```

`<n>` is the `concurrency` option (default `1`). Exit code `0` (no findings) and `1` (findings) are both treated as success; exit code `2`, a timeout, a missing
binary, or unparseable JSON is reported softly and never breaks the session.

## Auto-check behavior

Auto-check is **detect + guide**: it only registers the hook when the binary is available *and*
`jevlint doctor --offline --json` exits `0` (config + credentials look healthy). If the doctor probe fails, setup logs
a single warning and skips the hook so you do not get a noisy note on every edit; the `jevlint_check` tool stays
registered.

Unless `autoCheck` is `"off"`, the plugin registers an `execute.after` tool hook. When a completed tool call looks like
an edit, the plugin extracts **all** edited paths from the tool input (checking several candidate keys and nested
multi-file entries, preserving order and de-duplicating), runs the check, and:

- adds a `jevlint` block to the tool result's `metadata`, and
- appends a short text note to the result content when there are findings (or a one-line note if the check failed).

The hook is **synchronous and additive**: because `execute.after` is awaited, the edit result waits for the check. The
`autoCheckTimeoutMs` option (default `10000`) bounds that added latency; when the check times out the result gets a
one-line error note instead of findings. The on-demand tool uses the longer `timeoutMs` (default `30000`).

In `"file"` mode the plugin passes every edited file to a single `jevlint check` invocation. In `"changed"` mode it
passes `--changed` and no paths, which asks jevlint to check the whole working copy on *every* edit; that mode requires
a git repository and is considerably more expensive than `"file"`.

Identical `paths + content` checks are debounced in memory to avoid repeated runs on the same edit. All hook work is
wrapped so a failure can never surface out of the hook.

## Limitations

- **External binary.** This plugin is a wrapper. It cannot check code unless the `jevlint` binary is installed and its
  credentials are configured. It does not bundle, download, or auto-update `jevlint`.
- **Detection, not installation.** A missing or too-old binary disables auto-check; the on-demand tool reports the
  problem but cannot fix it.
- **Bounded auto-check.** `autoCheck: "file"` checks only the files the edit touched (all of them for a batched edit)
  and is bounded by `autoCheckTimeoutMs`. `autoCheck: "changed"` checks the whole working copy on every edit, requires
  a git repository, and is more expensive; use the `jevlint_check` tool for broader coverage on demand.
- **Best-effort edit detection.** Edit tools are recognized by known names and, for custom tools, by their input
  schema. An unusual custom tool may not be detected.
- **V2 only.** There is intentionally no V1 `server()` export.

## Development

```sh
bun install
bun run typecheck
bun test
```

Tests use a fake `jevlint` shell script; they need no network access and no API keys. `test/fixtures/report.json`
captures the `jevlint check --format json` contract.

## License

MIT
