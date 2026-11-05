import { appendFileSync } from "node:fs"
import { main, requireEnv, run, succeeds } from "./lib.js"

await main(() => {
  requireEnv("GITHUB_OUTPUT", "VERSION")

  const packageDir = process.env.PACKAGE_DIR ?? "."
  const manifest = packageDir === "." ? "package.json" : `${packageDir}/package.json`

  run(["npm", "pkg", "set", `version=${process.env.VERSION}`], { cwd: packageDir })
  run(["bun", "install"])

  const changed = !succeeds(["git", "diff", "--quiet", "--", manifest, "bun.lock"])
  if (changed) appendFileSync(process.env.GITHUB_OUTPUT, "changed=true\n")
  console.log(
    changed ? `Package version synced to ${process.env.VERSION}.` : `Package version already ${process.env.VERSION}.`,
  )
})
