# Google Antigravity provider for Hermes Agent

This directory contains the Hermes model-provider plugin used by T3 Code's Hermes integration.

It is a port of the native `google-antigravity` provider merged in NousResearch/hermes-agent PR #50454, adapted to the current Hermes model-provider plugin API.

## What changed from the old native implementation

- Provider registration is entirely plugin-local via `ProviderProfile`.
- OAuth persistence and refresh use Hermes' shared credential pool.
- OAuth Authorization Code + PKCE uses `OAuthPKCEConfig`, `pkce_auth_handler`, and `pkce_refresh_credential`.
- The transport subclasses the current `GeminiNativeClient`, reusing Hermes' current message/tool/stream translation instead of copying the old Gemini Cloud Code adapter.
- Only the Antigravity-specific Code Assist envelope, headers, project discovery, catalog parsing, and OAuth metadata remain provider-owned.

## Manual install for development

Copy this directory to:

```text
$HERMES_HOME/plugins/model-providers/google-antigravity/
```

Then authenticate:

```bash
hermes auth add google-antigravity
```

Inspect the provider/model catalog:

```bash
hermes model
```

Run a one-shot request:

```bash
hermes -z "Reply with: antigravity-ok" --provider google-antigravity -m gemini-3-flash-agent
```

## Environment overrides

`HERMES_ANTIGRAVITY_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or `GOOGLE_CLOUD_PROJECT_ID` can pin the Code Assist project. If none are set, the plugin asks Code Assist for the project and finally falls back to the public Antigravity project used by the reference flow.

## T3 Code packaging

The T3 server package publishes only `dist`, so the runtime integration must materialize these plugin files into the active Hermes home before starting `hermes acp`. Do not rely on this source directory being present in a packaged T3 installation.
