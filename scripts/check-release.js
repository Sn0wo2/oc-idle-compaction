import { appendFileSync } from "node:fs"
import { main, requireEnv } from "./lib.js"

await main(async () => {
  requireEnv("GITHUB_REPOSITORY", "GH_TOKEN", "GITHUB_OUTPUT")

  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME
  if (!tag) throw new Error("Release tag is not set")

  const response = await fetch(
    `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!response.ok && response.status !== 404) throw new Error(`Release lookup failed: HTTP ${response.status}`)

  const release = response.ok ? await response.json() : null
  const skip = release !== null && release.draft === false
  appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\n`)
  console.log(skip ? `Release ${tag} is already published; skipping.` : `Release ${tag} is not published; continuing.`)
})
