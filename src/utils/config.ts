import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Location } from "@opencode/plugin"

export function configPaths(location?: Pick<Location.Info, "directory" | "project">) {
  const names = ["opencode.json", "opencode.jsonc"]
  const directories = []
  if (location?.project?.directory && location?.directory) {
    const root = resolve(location.project.directory)
    let current = resolve(location.directory)
    while (true) {
      directories.unshift(current)
      if (process.platform === "win32" ? current.toLowerCase() === root.toLowerCase() : current === root) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return [
    ...names.map((name) =>
      join(
        process.env["OPENCODE_CONFIG_DIR"]?.trim() ||
          join(process.env["XDG_CONFIG_HOME"]?.trim() || join(homedir(), ".config"), "opencode"),
        name,
      ),
    ),
    ...directories.flatMap((directory) => names.map((name) => join(directory, name))),
    ...directories.flatMap((directory) => names.map((name) => join(directory, ".opencode", name))),
  ]
}

export function parseNumber(name: string, value: unknown, fallback: number) {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} option must be a non-negative number`)
  }
  return value
}
