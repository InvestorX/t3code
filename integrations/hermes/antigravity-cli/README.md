# Hermes × Google Antigravity CLI

This model-provider plugin connects Hermes Agent to the **official** Google Antigravity CLI (`agy`) as an external subprocess.

It intentionally does **not** implement the removed direct Google OAuth / Code Assist provider. Google credentials remain owned by the official Antigravity CLI and its normal credential store; the plugin never reads or refreshes Google tokens.

## Prerequisites

1. Install the official Antigravity CLI so `agy` is on `PATH`.
2. Run `agy` interactively once and sign in.
3. Enable the Hermes provider in T3 Code. T3 installs this plugin into the active `$HERMES_HOME/plugins/model-providers/antigravity-cli/` directory.

Hermes will expose the provider as `antigravity-cli` (aliases: `antigravity`, `agy`). Available model IDs are discovered with `agy models`.

## Safety model

Inference calls run `agy` in a fresh temporary working directory, use `--sandbox`, and never pass `--dangerously-skip-permissions`. The prompt instructs Antigravity to act as Hermes' model backend and to request Hermes tools rather than modifying the user's project itself.

For full Antigravity-agent delegation against the actual workspace, use T3's separate `antigravity_delegate` tool instead. That path preserves T3's provider/runtime boundaries and denies delegated permission requests rather than silently escalating them.

## Optional overrides

- `HERMES_ANTIGRAVITY_CLI_COMMAND` — alternate `agy` executable path.
- `ANTIGRAVITY_CLI_PATH` — secondary executable override.
- `HERMES_ANTIGRAVITY_CLI_ARGS` — additional CLI arguments parsed by Hermes' external-process provider seam.
