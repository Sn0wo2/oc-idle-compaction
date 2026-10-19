# oc-idle-compaction

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Sn0wo2/oc-idle-compaction)

> OpenCode2 plugin that compacts large idle sessions before their prompt cache expires. Inspired by Claude Code's idle compaction.

## Install

Requires OpenCode `v2.0.29` or later.

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
