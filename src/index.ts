import { Plugin } from "@opencode/plugin";
import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_MIN_TOKENS,
  loadConfig,
  parseNumber,
} from "./config/load.ts";

export default Plugin.define({
  id: "oc-idle-compaction",
  setup(ctx) {
    // Validate global options synchronously so invalid options are rejected immediately
    parseNumber("idleMinutes", ctx.options.idleMinutes, DEFAULT_IDLE_MINUTES);
    parseNumber("minTokens", ctx.options.minTokens, DEFAULT_MIN_TOKENS);

    return (async () => {
      const store = await loadConfig(ctx.location, ctx.options);

      const context = new Map<string, number>();
      const timers = new Map<string, ReturnType<typeof setTimeout>>();
      const compacting = new Set<string>();
      let scheduleSeq = 0;
      const scheduleTokens = new Map<string, number>();

      function cancel(sessionID: string) {
        scheduleTokens.delete(sessionID);
        const timer = timers.get(sessionID);
        if (timer) {
          clearTimeout(timer);
          timers.delete(sessionID);
        }
      }

      async function compact(sessionID: string) {
        timers.delete(sessionID);
        const currentTokens = context.get(sessionID) ?? 0;
        const session = await getSession(sessionID);
        if (session === null) return;

        if (session?.parentID) return;

        const config = store.resolve(session?.model);
        if (!config.enabled || currentTokens < config.minTokens) return;

        context.delete(sessionID);
        await ctx.session.compact({ sessionID });
      }

      async function getSession(sessionID: string) {
        try {
          return await ctx.session.get({ sessionID });
        } catch (error) {
          console.error("oc-idle-compaction:", error);
          return null;
        }
      }

      async function schedule(sessionID: string) {
        cancel(sessionID);
        const token = ++scheduleSeq;
        scheduleTokens.set(sessionID, token);

        const session = await getSession(sessionID);
        if (session === null) return;

        if (scheduleTokens.get(sessionID) !== token) return;
        scheduleTokens.delete(sessionID);

        // Subagent sessions are never resumed directly, so refreshing their cache is wasted spend.
        if (session?.parentID) return;

        const config = store.resolve(session?.model);
        if (!config.enabled) return;

        if ((context.get(sessionID) ?? 0) < config.minTokens) return;

        timers.set(
          sessionID,
          setTimeout(() => {
            compact(sessionID).catch((error) =>
              console.error("oc-idle-compaction:", error),
            );
          }, config.idleMinutes * 60_000),
        );
      }

      const controller = new AbortController();
      void (async () => {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          switch (event.type) {
            case "session.step.ended": {
              // A compaction's own request reads the whole context; it says nothing about the session's size afterwards.
              if (compacting.has(event.data.sessionID)) break;
              const { input, output, cache } = event.data.tokens;
              context.set(
                event.data.sessionID,
                input + output + cache.read + cache.write,
              );
              break;
            }
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
              void schedule(event.data.sessionID);
              break;
            case "session.execution.started":
            case "session.inbox.enqueued":
              cancel(event.data.sessionID);
              break;
            case "session.compaction.started":
              cancel(event.data.sessionID);
              compacting.add(event.data.sessionID);
              break;
            // After a failed compaction, wait for the next turn rather than retrying every idle period.
            case "session.compaction.ended":
            case "session.compaction.failed":
            case "session.deleted":
              cancel(event.data.sessionID);
              compacting.delete(event.data.sessionID);
              context.delete(event.data.sessionID);
              break;
          }
        }
      })().catch((error) => {
        if (!controller.signal.aborted)
          console.error("oc-idle-compaction:", error);
      });

      return () => {
        controller.abort();
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        scheduleTokens.clear();
      };
    })();
  },
});
