import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isPlainObject } from "es-toolkit/predicate";
import { parse, type ParseError } from "jsonc-parser";
import type { Location } from "@opencode/plugin";

export function configPaths(
  location?: Pick<Location.Info, "directory" | "project">,
): string[] {
  const names = ["opencode.json", "opencode.jsonc"];
  const directories: string[] = [];
  if (location?.project?.directory && location?.directory) {
    const root = resolve(location.project.directory);
    let current = resolve(location.directory);
    while (true) {
      directories.unshift(current);
      if (
        process.platform === "win32"
          ? current.toLowerCase() === root.toLowerCase()
          : current === root
      )
        break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [
    ...names.map((name) =>
      join(
        process.env.OPENCODE_CONFIG_DIR?.trim() ||
          join(
            process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
            "opencode",
          ),
        name,
      ),
    ),
    ...directories.flatMap((directory) =>
      names.map((name) => join(directory, name)),
    ),
    ...directories.flatMap((directory) =>
      names.map((name) => join(directory, ".opencode", name)),
    ),
  ];
}

export function parseConfig(
  text: string,
  source: string,
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first)
    throw new SyntaxError(
      `${source}: JSONC syntax error near offset ${first.offset} (code ${first.error})`,
    );
  if (!isPlainObject(config))
    throw new TypeError(`${source} must be an object`);
  return config;
}
