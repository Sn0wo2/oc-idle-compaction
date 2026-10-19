import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin, Location } from "@opencode/plugin";
import idleCompaction from "../src/index.ts";
import { loadConfig } from "../src/config/load.ts";

type Event = { type: string; data: Record<string, unknown> };

const IDLE_SECONDS = 0.03;
const IDLE_WAIT = 60;
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
const isolatedConfigDir = await mkdtemp(join(tmpdir(), "oc-idle-compaction-"));
process.env.OPENCODE_CONFIG_DIR = isolatedConfigDir;

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  await rm(isolatedConfigDir, { recursive: true, force: true });
});

async function optionAConfig(config: Record<string, unknown>) {
  const directory = await mkdtemp(join(isolatedConfigDir, "project-"));
  await writeFile(join(directory, "opencode.json"), JSON.stringify(config));
  return {
    location: { directory, project: { directory } } as Location.Info,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function setup(
  input: {
    options?: Record<string, unknown>;
    config?: Record<string, unknown>;
    parents?: Record<string, string>;
    models?: Record<
      string,
      { id?: string; providerID?: string; variant?: string }
    >;
    location?: Location.Info;
  } = {},
) {
  const config = input.config ? await optionAConfig(input.config) : undefined;
  const queue: Event[] = [];
  let wake: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const compactions: string[] = [];
  const cleanup = await idleCompaction.setup({
    options: { idleSeconds: IDLE_SECONDS, ...input.options },
    location: config?.location ?? input.location,
    event: {
      subscribe: (options: { signal: AbortSignal }) => {
        signal = options.signal;
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              const event = queue.shift();
              if (event) yield event;
              else await new Promise<void>((resolve) => (wake = resolve));
            }
          },
        };
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        parentID: input.parents?.[sessionID],
        model: input.models?.[sessionID],
      }),
      compact: async ({ sessionID }: { sessionID: string }) => {
        compactions.push(sessionID);
      },
    },
  } as unknown as Plugin.Context);

  const emit = async (type: string, data: Record<string, unknown>) => {
    queue.push({ type, data });
    wake?.();
    await Bun.sleep(0);
  };

  const step = (sessionID: string, inputTokens: number, read = 0) =>
    emit("session.step.ended", {
      sessionID,
      tokens: {
        input: inputTokens,
        output: 0,
        reasoning: 0,
        cache: { read, write: 0 },
      },
    });

  return {
    compactions,
    emit,
    step,
    signal: () => signal,
    cleanup: async () => {
      if (cleanup) await cleanup();
      wake?.();
      await config?.cleanup();
    },
  };
}

test("compacts a large session after it goes idle", async () => {
  const harness = await setup();
  await harness.step("ses_a", 1_000, 199_000);
  await harness.emit("session.execution.succeeded", { sessionID: "ses_a" });
  expect(harness.compactions).toEqual([]);
  await Bun.sleep(IDLE_WAIT);
  expect(harness.compactions).toEqual(["ses_a"]);
  await harness.cleanup();
});

test("ignores sessions below the token threshold", async () => {
  const harness = await setup();
  await harness.step("ses_a", 199_999);
  await harness.emit("session.execution.succeeded", { sessionID: "ses_a" });
  await Bun.sleep(IDLE_WAIT);
  expect(harness.compactions).toEqual([]);
  await harness.cleanup();
});

test.each(["session.execution.failed", "session.execution.interrupted"])(
  "schedules after %s",
  async (type) => {
    const harness = await setup();
    await harness.step("ses_a", 250_000);
    await harness.emit(type, { sessionID: "ses_a" });
    await Bun.sleep(IDLE_WAIT);
    expect(harness.compactions).toEqual(["ses_a"]);
    await harness.cleanup();
  },
);

test.each([
  "session.execution.started",
  "session.inbox.enqueued",
  "session.compaction.started",
  "session.compaction.ended",
  "session.deleted",
])("cancels on %s", async (type) => {
  const harness = await setup();
  await harness.step("ses_a", 250_000);
  await harness.emit("session.execution.succeeded", { sessionID: "ses_a" });
  await harness.emit(type, { sessionID: "ses_a" });
  await Bun.sleep(IDLE_WAIT);
  expect(harness.compactions).toEqual([]);
  await harness.cleanup();
});

test("skips subagent sessions", async () => {
  const harness = await setup({ parents: { ses_child: "ses_a" } });
  await harness.step("ses_child", 250_000);
  await harness.emit("session.execution.succeeded", { sessionID: "ses_child" });
  await Bun.sleep(IDLE_WAIT);
  expect(harness.compactions).toEqual([]);
  await harness.cleanup();
});

test("respects a custom token threshold", async () => {
  const harness = await setup({ options: { minTokens: 1_000 } });
  await harness.step("ses_a", 1_000);
  await harness.emit("session.execution.succeeded", { sessionID: "ses_a" });
  await Bun.sleep(IDLE_WAIT);
  expect(harness.compactions).toEqual(["ses_a"]);
  await harness.cleanup();
});

test("compacts once until the session grows again", async () => {
  const harness = await setup();
  await harness.step("ses_a", 250_000);
  await harness.emit("session.execution.succeeded", { sessionID: "ses_a" });
  await Bun.sleep(IDLE_WAIT);
  await harness.emit("session.execution.succeeded", { sessionID: "ses_a" });
  await Bun.sleep(IDLE_WAIT);
  expect(harness.compactions).toEqual(["ses_a"]);
  await harness.cleanup();
});

test.each(["session.compaction.ended", "session.compaction.failed"])(
  "does not compact again after %s",
  async (type) => {
    const harness = await setup();
    await harness.step("ses_a", 250_000);
    await harness.emit("session.execution.succeeded", { sessionID: "ses_a" });
    await Bun.sleep(IDLE_WAIT);
    expect(harness.compactions).toEqual(["ses_a"]);
    // The compaction's own request reports the full context it summarized.
    await harness.emit("session.compaction.started", { sessionID: "ses_a" });
    await harness.step("ses_a", 250_000);
    await harness.emit(type, { sessionID: "ses_a" });
    await harness.emit("session.execution.failed", { sessionID: "ses_a" });
    await Bun.sleep(IDLE_WAIT);
    expect(harness.compactions).toEqual(["ses_a"]);
    await harness.cleanup();
  },
);

test("stops listening and clears timers on cleanup", async () => {
  const harness = await setup();
  await harness.step("ses_a", 250_000);
  await harness.emit("session.execution.succeeded", { sessionID: "ses_a" });
  await harness.cleanup();
  expect(harness.signal()?.aborted).toBe(true);
  await Bun.sleep(IDLE_WAIT);
  expect(harness.compactions).toEqual([]);
});

test.each([
  ["idleSeconds", -1],
  ["idleSeconds", "54"],
  ["minTokens", Number.NaN],
  ["minTokens", null],
])("rejects invalid %s option %p", (name, value) => {
  expect(() =>
    idleCompaction.setup({
      options: { [name]: value },
    } as unknown as Plugin.Context),
  ).toThrow(`oc-idle-compaction ${name} option must be a non-negative number`);
});

test("supports per-model custom idleSeconds", async () => {
  const harness = await setup({
    options: {
      idleSeconds: 0.06, // 60ms default
    },
    config: {
      providers: {
        "test-prov": {
          models: {
            "fast-model": {
              idleCompaction: { idleSeconds: 0.018 },
            },
          },
        },
      },
    },
    models: {
      ses_fast: { id: "fast-model", providerID: "test-prov" },
      ses_slow: { id: "slow-model", providerID: "test-prov" },
    },
  });

  await harness.step("ses_fast", 250_000);
  await harness.step("ses_slow", 250_000);
  await harness.emit("session.execution.succeeded", { sessionID: "ses_fast" });
  await harness.emit("session.execution.succeeded", { sessionID: "ses_slow" });

  // After 35ms: fast model should be compacted, slow model not yet
  await Bun.sleep(35);
  expect(harness.compactions).toEqual(["ses_fast"]);

  // After another 45ms (total 80ms): slow model should now also be compacted
  await Bun.sleep(45);
  expect(harness.compactions).toEqual(["ses_fast", "ses_slow"]);
  await harness.cleanup();
});

test("supports per-model custom minTokens", async () => {
  const harness = await setup({
    options: {
      minTokens: 200_000,
    },
    config: {
      providers: {
        anthropic: {
          models: {
            "claude-3-7-sonnet": {
              idleCompaction: { minTokens: 50_000 },
            },
          },
        },
      },
    },
    models: {
      ses_sonnet: { id: "claude-3-7-sonnet", providerID: "anthropic" },
      ses_other: { id: "other-model", providerID: "anthropic" },
    },
  });

  // Both have 80_000 tokens: above sonnet's 50k threshold, below default 200k threshold
  await harness.step("ses_sonnet", 80_000);
  await harness.step("ses_other", 80_000);
  await harness.emit("session.execution.succeeded", {
    sessionID: "ses_sonnet",
  });
  await harness.emit("session.execution.succeeded", { sessionID: "ses_other" });

  await Bun.sleep(IDLE_WAIT);
  expect(harness.compactions).toEqual(["ses_sonnet"]);
  await harness.cleanup();
});

test("supports disabling idle compaction for specific models", async () => {
  const harness = await setup({
    config: {
      providers: {
        prov: {
          models: {
            "disabled-model": { idleCompaction: false },
            "explicit-disabled": {
              idleCompaction: { enabled: false },
            },
          },
        },
      },
    },
    models: {
      ses_disabled: { id: "disabled-model", providerID: "prov" },
      ses_explicit: { id: "explicit-disabled", providerID: "prov" },
      ses_normal: { id: "normal-model", providerID: "prov" },
    },
  });

  await harness.step("ses_disabled", 300_000);
  await harness.step("ses_explicit", 300_000);
  await harness.step("ses_normal", 300_000);

  await harness.emit("session.execution.succeeded", {
    sessionID: "ses_disabled",
  });
  await harness.emit("session.execution.succeeded", {
    sessionID: "ses_explicit",
  });
  await harness.emit("session.execution.succeeded", {
    sessionID: "ses_normal",
  });

  await Bun.sleep(IDLE_WAIT);
  expect(harness.compactions).toEqual(["ses_normal"]);
  await harness.cleanup();
});

test("supports provider-level defaults", async () => {
  const harness = await setup({
    config: {
      providers: {
        custom_provider: {
          idleCompaction: { minTokens: 10_000 },
        },
      },
    },
    models: {
      ses_prov: { id: "any-model", providerID: "custom_provider" },
    },
  });

  await harness.step("ses_prov", 15_000);
  await harness.emit("session.execution.succeeded", { sessionID: "ses_prov" });

  await Bun.sleep(IDLE_WAIT);
  expect(harness.compactions).toEqual(["ses_prov"]);
  await harness.cleanup();
});

test("loadConfig resolves model, provider and global options correctly", async () => {
  const config = await optionAConfig({
    providers: {
      openai: {
        idleCompaction: { idleSeconds: 2400 },
        models: {
          "gpt-4o": {
            idleCompaction: { idleSeconds: 1200, minTokens: 80_000 },
          },
        },
      },
      anthropic: {
        models: {
          "claude-opus": { idleCompaction: false },
        },
      },
    },
  });
  const store = await loadConfig(config.location, {
    idleSeconds: 3000,
    minTokens: 150_000,
  });

  // Global fallback
  const globalResolved = store.resolve({
    providerID: "unknown",
    id: "unknown",
  });
  expect(globalResolved).toEqual({
    enabled: true,
    idleSeconds: 3000,
    minTokens: 150_000,
  });

  // Provider-level fallback
  const providerResolved = store.resolve({
    providerID: "openai",
    id: "gpt-3.5-turbo",
  });
  expect(providerResolved).toEqual({
    enabled: true,
    idleSeconds: 2400,
    minTokens: 150_000,
  });

  // Model-level override
  const modelResolved = store.resolve({ providerID: "openai", id: "gpt-4o" });
  expect(modelResolved).toEqual({
    enabled: true,
    idleSeconds: 1200,
    minTokens: 80_000,
  });

  // Disabled model
  const disabledResolved = store.resolve({
    providerID: "anthropic",
    id: "claude-opus",
  });
  expect(disabledResolved.enabled).toBe(false);
  await config.cleanup();
});
