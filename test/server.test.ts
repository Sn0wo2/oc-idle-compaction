import { expect, test } from "bun:test";
import type { Plugin, Location } from "@opencode/plugin";
import idleCompaction from "../src/index.ts";
import { loadConfig } from "../src/config/load.ts";

type Event = { type: string; data: Record<string, unknown> };

const IDLE_MINUTES = 0.0005; // 30ms
const IDLE_WAIT = 60;

async function setup(
  input: {
    options?: Record<string, unknown>;
    parents?: Record<string, string>;
    models?: Record<
      string,
      { id?: string; providerID?: string; variant?: string }
    >;
    location?: Location.Info;
  } = {},
) {
  const queue: Event[] = [];
  let wake: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const compactions: string[] = [];
  const cleanup = await idleCompaction.setup({
    options: { idleMinutes: IDLE_MINUTES, ...input.options },
    location: input.location,
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
  ["idleMinutes", -1],
  ["idleMinutes", "54"],
  ["minTokens", Number.NaN],
  ["minTokens", null],
])("rejects invalid %s option %p", (name, value) => {
  expect(() =>
    idleCompaction.setup({
      options: { [name]: value },
    } as unknown as Plugin.Context),
  ).toThrow(`oc-idle-compaction ${name} option must be a non-negative number`);
});

test("supports per-model custom idleMinutes", async () => {
  const harness = await setup({
    options: {
      idleMinutes: 0.001, // 60ms default
      models: {
        "fast-model": {
          idleMinutes: 0.0003, // 18ms
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
      models: {
        "anthropic/claude-3-7-sonnet": {
          minTokens: 50_000,
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
    options: {
      models: {
        "disabled-model": false,
        "explicit-disabled": { enabled: false },
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
    options: {
      providers: {
        custom_provider: {
          minTokens: 10_000,
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
  const store = await loadConfig(undefined, {
    idleMinutes: 50,
    minTokens: 150_000,
    providers: {
      openai: {
        idleMinutes: 40,
      },
    },
    models: {
      "openai/gpt-4o": {
        idleMinutes: 20,
        minTokens: 80_000,
      },
      "claude-opus": false,
    },
  });

  // Global fallback
  const globalResolved = store.resolve({
    providerID: "unknown",
    id: "unknown",
  });
  expect(globalResolved).toEqual({
    enabled: true,
    idleMinutes: 50,
    minTokens: 150_000,
  });

  // Provider-level fallback
  const providerResolved = store.resolve({
    providerID: "openai",
    id: "gpt-3.5-turbo",
  });
  expect(providerResolved).toEqual({
    enabled: true,
    idleMinutes: 40,
    minTokens: 150_000,
  });

  // Model-level override
  const modelResolved = store.resolve({ providerID: "openai", id: "gpt-4o" });
  expect(modelResolved).toEqual({
    enabled: true,
    idleMinutes: 20,
    minTokens: 80_000,
  });

  // Disabled model
  const disabledResolved = store.resolve({
    providerID: "anthropic",
    id: "claude-opus",
  });
  expect(disabledResolved.enabled).toBe(false);
});
