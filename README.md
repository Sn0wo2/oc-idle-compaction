# oc-idle-compaction

OpenCode plugin that compacts large sessions after they sit idle, just before their prompt cache expires. Inspired by Claude Code's idle compaction.

Resuming a long session after its cache expires bills the whole context as uncached input. Compacting while the cache is still warm reads it at the cached rate and leaves a small summary to resume from.

Requires OpenCode V2 2.0.29 or later.

## Install

Add the package to your OpenCode2 `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:Sn0wo2/oc-idle-compaction",
      "options": {
        "idleMinutes": 54,
        "minTokens": 200000,
      },
    },
  ],
}
```

## Configure

### Per-Model & Per-Provider Configuration

Configure `idleCompaction` directly under `providers` in `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "your-provider": {
      // Optional: provider-level default
      "idleCompaction": {
        "idleMinutes": 20,
      },
      "models": {
        "your-model": {
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
