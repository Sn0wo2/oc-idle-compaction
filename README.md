# oc-idle-compaction

OpenCode plugin that compacts large sessions after they sit idle, just before their prompt cache expires. Inspired by Claude Code's idle compaction.

Resuming a long session after its cache expires bills the whole context as uncached input. Compacting while the cache is still warm reads it at the cached rate and leaves a small summary to resume from.

Supports per-model idle compaction configuration, while preserving global defaults.

Requires OpenCode V2 2.0.29 or later.

## Install

Add the package to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["oc-idle-compaction"]
}
```

OpenCode installs npm plugins automatically at startup.

## Use

When a session's turn ends with at least 200k tokens of context, it compacts after 54 minutes without activity. A new prompt or turn cancels the timer. Subagent sessions are skipped.

The 54 minute default targets a 1-hour cache TTL. Lower `idleMinutes` if your provider's cache expires sooner.

## Configure

### 1. Global Configuration

You can configure global defaults in `plugins`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "oc-idle-compaction",
      "options": {
        "idleMinutes": 54,
        "minTokens": 200000
      }
    }
  ]
}
```

- `idleMinutes`: minutes idle before compacting. Defaults to `54`.
- `minTokens`: minimum context size, in tokens, of the last request. Defaults to `200000`.

### 2. Per-Model & Per-Provider Configuration

Idle compaction can be configured per model or per provider in two convenient ways:

#### Option A: In `opencode.json` / `opencode.jsonc` under `providers`

Configure `idleCompaction` directly in your provider and model configurations:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "modelscope": {
      // Optional: provider-level default
      "idleCompaction": {
        "idleMinutes": 20,
      },
      "models": {
        "deepseek-v4-flash-0731": {
          // Model-level override
          "idleCompaction": {
            "idleMinutes": 10,
            "minTokens": 100000,
          },
        },
        "expensive-model": {
          // Disable idle compaction for specific models
          "idleCompaction": false,
        },
      },
    },
  },
}
```

#### Option B: In plugin `options`

Configure `models` and `providers` maps within plugin options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "oc-idle-compaction",
      "options": {
        "idleMinutes": 54,
        "minTokens": 200000,
        "models": {
          "modelscope/deepseek-v4-flash-0731": {
            "idleMinutes": 10,
            "minTokens": 100000,
          },
          "claude-3-7-sonnet": {
            "idleMinutes": 15,
          },
          "expensive-model": false,
        },
        "providers": {
          "mistral": {
            "idleMinutes": 25,
          },
        },
      },
    },
  ],
}
```

### Precedence

When determining compaction settings for a session's model:

1. Model-specific configuration (`providers.<provider>.models.<model>.idleCompaction` or `options.models["<provider>/<model>"]` / `options.models["<model>"]`)
2. Provider-level configuration (`providers.<provider>.idleCompaction` or `options.providers["<provider>"]`)
3. Global plugin options (`options.idleMinutes`, `options.minTokens`)
4. Default fallback: 54 minutes idle, 200,000 tokens threshold, enabled.

Idle timers live in memory, so restarting OpenCode drops them.

## Local Development

This package includes `.opencode/plugins/oc-idle-compaction.ts`, so OpenCode auto-loads the local source when you run it from the package directory.

```sh
bun install
bun test
bun run check
bun run format
```

Restart OpenCode after changing plugin files or config.

## License

MIT
