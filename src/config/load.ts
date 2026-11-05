import type { Location } from "@opencode/plugin"
import { isPlainObject } from "es-toolkit/predicate"
import { type ParseError, parse } from "jsonc-parser"
import { configPaths, parseNumber } from "../utils/config.ts"

export const DEFAULT_IDLE_SECONDS = 3240
export const DEFAULT_MIN_TOKENS = 200_000

type IdleCompactionOptions = {
  idleSeconds?: number
  minTokens?: number
  enabled?: boolean
}

function parseModelOptions(raw: unknown): IdleCompactionOptions | undefined {
  if (typeof raw === "boolean") return { enabled: raw }
  if (!isPlainObject(raw)) return undefined

  const options: IdleCompactionOptions = {}

  if (typeof raw["enabled"] === "boolean") {
    options.enabled = raw["enabled"]
  }

  const idleSeconds = raw["idleSeconds"] ?? raw["idle_seconds"]
  if (idleSeconds !== undefined) {
    options.idleSeconds = parseNumber("oc-idle-compaction idleSeconds", idleSeconds, DEFAULT_IDLE_SECONDS)
  }

  const minTokens = raw["minTokens"] ?? raw["min_tokens"]
  if (minTokens !== undefined) {
    options.minTokens = parseNumber("oc-idle-compaction minTokens", minTokens, DEFAULT_MIN_TOKENS)
  }

  return options
}

function extractIdleOptions(raw: Record<string, unknown>): IdleCompactionOptions | undefined {
  const nested = raw["idleCompaction"] ?? raw["idle_compaction"]
  if (nested !== undefined) return parseModelOptions(nested)
  if (["enabled", "idleSeconds", "idle_seconds", "minTokens", "min_tokens"].some((key) => raw[key] !== undefined)) {
    return parseModelOptions(raw)
  }
  return undefined
}

export async function loadConfig(location: Location.Info | undefined, globalConfig: Required<IdleCompactionOptions>) {
  const modelConfigs = new Map<string, IdleCompactionOptions>()
  const providerConfigs = new Map<string, IdleCompactionOptions>()

  for (const document of await Promise.all(
    configPaths(location).map(async (path) => {
      const text = await Bun.file(path)
        .text()
        .catch(() => "")
      if (!text) return undefined
      try {
        const errors: ParseError[] = []
        const config: unknown = parse(text, errors, { allowTrailingComma: true })
        const first = errors[0]
        if (first)
          throw new SyntaxError(`${path}: JSONC syntax error near offset ${first.offset} (code ${first.error})`)
        if (!isPlainObject(config)) throw new TypeError(`${path} must be an object`)
        return config
      } catch (error) {
        console.warn(`[oc-idle-compaction] ignoring invalid config at ${path}`, error)
        return undefined
      }
    }),
  )) {
    if (!(document && isPlainObject(document["providers"]))) continue
    for (const [providerID, rawProvider] of Object.entries(document["providers"])) {
      if (!isPlainObject(rawProvider)) continue

      const providerOptions = extractIdleOptions(rawProvider)
      if (providerOptions) providerConfigs.set(providerID, providerOptions)

      if (!isPlainObject(rawProvider["models"])) continue
      for (const [configKey, rawModel] of Object.entries(rawProvider["models"])) {
        if (!isPlainObject(rawModel)) continue
        const modelOptions = extractIdleOptions(rawModel)
        if (!modelOptions) continue

        modelConfigs.set(`${providerID}/${configKey}`, modelOptions)
        modelConfigs.set(configKey, modelOptions)

        const modelID = typeof rawModel["modelID"] === "string" ? rawModel["modelID"].trim() : undefined
        if (modelID) {
          modelConfigs.set(`${providerID}/${modelID}`, modelOptions)
          modelConfigs.set(modelID, modelOptions)
        }
      }
    }
  }

  // Variant-specific keys win over plain model keys, which win over the provider default.
  return (model?: { id?: string; providerID?: string; variant?: string } | null) => {
    if (!model) return globalConfig

    const { providerID, id: modelID, variant } = model

    let modelOptions: IdleCompactionOptions | undefined
    if (providerID && modelID && variant) {
      modelOptions =
        modelConfigs.get(`${providerID}/${modelID}:${variant}`) ?? modelConfigs.get(`${modelID}:${variant}`)
    }
    if (!modelOptions && providerID && modelID) modelOptions = modelConfigs.get(`${providerID}/${modelID}`)
    if (!modelOptions && modelID) modelOptions = modelConfigs.get(modelID)

    const providerOptions = providerID ? providerConfigs.get(providerID) : undefined

    return {
      enabled: modelOptions?.enabled ?? providerOptions?.enabled ?? globalConfig.enabled,
      idleSeconds: modelOptions?.idleSeconds ?? providerOptions?.idleSeconds ?? globalConfig.idleSeconds,
      minTokens: modelOptions?.minTokens ?? providerOptions?.minTokens ?? globalConfig.minTokens,
    }
  }
}
