import { appendFileSync } from "node:fs"
import { main, requireEnv } from "./lib.js"

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

await main(() => {
  requireEnv("GITHUB_OUTPUT", "GITHUB_ENV")

  const raw = process.argv[2] ?? process.env.GITHUB_REF_NAME
  if (!raw) throw new Error("Release version is not set")

  const version = raw.startsWith("v") ? raw.slice(1) : raw
  if (!semverPattern.test(version)) throw new Error(`Invalid semantic version: ${raw}`)

  const prerelease = version.split("+")[0].includes("-")
  const distTag = prerelease ? "next" : "latest"
  appendFileSync(process.env.GITHUB_ENV, `VERSION=${version}\n`)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ndist-tag=${distTag}\n`)
  console.log(`Release version ${version} (dist-tag ${distTag})`)
})
