import { isPlainObject } from "es-toolkit/predicate";
import type { Location, PluginOptions } from "@opencode/plugin";
import { configPaths, parseConfig } from "../utils/config.ts";

export const DEFAULT_IDLE_MINUTES = 54;
export const DEFAULT_MIN_TOKENS = 200_000;

export type IdleCompactionOptions = {
  idleMinutes?: number;
  minTokens?: number;
  enabled?: boolean;
};

export type ResolvedIdleCompactionConfig = {
  idleMinutes: number;
  minTokens: number;
  enabled: boolean;
};

export type ModelRef = {
  id?: string;
  providerID?: string;
  variant?: string;
};

export function parseNumber(name: string, value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `oc-idle-compaction ${name} option must be a non-negative number`,
    );
  }
  return value;
}

export function parseModelOptions(
  raw: unknown,
): IdleCompactionOptions | undefined {
  if (raw === false) return { enabled: false };
  if (raw === true) return { enabled: true };
  if (!isPlainObject(raw)) return undefined;

  const result: IdleCompactionOptions = {};

  if (typeof raw.enabled === "boolean") {
    result.enabled = raw.enabled;
  }

  const rawIdle = raw.idleMinutes ?? raw.idle_minutes ?? raw.idle;
  if (rawIdle !== undefined) {
    result.idleMinutes = parseNumber(
      "idleMinutes",
      rawIdle,
      DEFAULT_IDLE_MINUTES,
    );
  }

  const rawTokens = raw.minTokens ?? raw.min_tokens;
  if (rawTokens !== undefined) {
    result.minTokens = parseNumber("minTokens", rawTokens, DEFAULT_MIN_TOKENS);
  }

  return result;
}

export function extractIdleOptions(
  raw: Record<string, unknown>,
): IdleCompactionOptions | undefined {
  if (raw.idleCompaction !== undefined) {
    return parseModelOptions(raw.idleCompaction);
  }
  if (raw.idle_compaction !== undefined) {
    return parseModelOptions(raw.idle_compaction);
  }
  if (
    raw.idleMinutes !== undefined ||
    raw.idle_minutes !== undefined ||
    raw.minTokens !== undefined ||
    raw.min_tokens !== undefined ||
    raw.enabled !== undefined
  ) {
    return parseModelOptions(raw);
  }
  return undefined;
}

export class ConfigStore {
  readonly globalConfig: ResolvedIdleCompactionConfig;
  readonly modelConfigs = new Map<string, IdleCompactionOptions>();
  readonly providerConfigs = new Map<string, IdleCompactionOptions>();

  constructor(globalConfig: ResolvedIdleCompactionConfig) {
    this.globalConfig = globalConfig;
  }

  resolve(model?: ModelRef) {
    if (!model) return this.globalConfig;

    const { providerID, id: modelID, variant } = model;

    let modelOpt: IdleCompactionOptions | undefined;

    // Check with variant first
    if (providerID && modelID && variant) {
      modelOpt =
        this.modelConfigs.get(`${providerID}/${modelID}:${variant}`) ??
        this.modelConfigs.get(`${modelID}:${variant}`);
    }

    // Check without variant
    if (!modelOpt && providerID && modelID) {
      modelOpt = this.modelConfigs.get(`${providerID}/${modelID}`);
    }
    if (!modelOpt && modelID) {
      modelOpt = this.modelConfigs.get(modelID);
    }

    const providerOpt = providerID
      ? this.providerConfigs.get(providerID)
      : undefined;

    return {
      enabled:
        modelOpt?.enabled ?? providerOpt?.enabled ?? this.globalConfig.enabled,
      idleMinutes:
        modelOpt?.idleMinutes ??
        providerOpt?.idleMinutes ??
        this.globalConfig.idleMinutes,
      minTokens:
        modelOpt?.minTokens ??
        providerOpt?.minTokens ??
        this.globalConfig.minTokens,
    };
  }
}

export async function loadConfig(
  location?: Location.Info,
  options?: PluginOptions,
) {
  const store = new ConfigStore({
    idleMinutes: parseNumber(
      "idleMinutes",
      options?.idleMinutes,
      DEFAULT_IDLE_MINUTES,
    ),
    minTokens: parseNumber("minTokens", options?.minTokens, DEFAULT_MIN_TOKENS),
    enabled: typeof options?.enabled === "boolean" ? options.enabled : true,
  });

  for (const document of await Promise.all(
    configPaths(location).map(async (path) => {
      const text = await Bun.file(path)
        .text()
        .catch(() => "");
      if (!text) return undefined;
      try {
        return parseConfig(text, path);
      } catch (error) {
        console.warn(
          `[oc-idle-compaction] ignoring invalid config at ${path}`,
          error,
        );
        return undefined;
      }
    }),
  )) {
    if (!document || !isPlainObject(document.providers)) continue;
    for (const [providerID, rawProvider] of Object.entries(
      document.providers,
    )) {
      if (!isPlainObject(rawProvider)) continue;

      const providerOpt = extractIdleOptions(rawProvider);
      if (providerOpt) {
        store.providerConfigs.set(providerID, providerOpt);
      }

      if (!isPlainObject(rawProvider.models)) continue;

      for (const [configKey, rawModel] of Object.entries(rawProvider.models)) {
        if (!isPlainObject(rawModel)) continue;
        const modelOpt = extractIdleOptions(rawModel);
        if (!modelOpt) continue;

        store.modelConfigs.set(`${providerID}/${configKey}`, modelOpt);
        store.modelConfigs.set(configKey, modelOpt);

        const modelID =
          typeof rawModel.modelID === "string"
            ? rawModel.modelID.trim()
            : undefined;
        if (modelID) {
          store.modelConfigs.set(`${providerID}/${modelID}`, modelOpt);
          store.modelConfigs.set(modelID, modelOpt);
        }
      }
    }
  }

  return store;
}
