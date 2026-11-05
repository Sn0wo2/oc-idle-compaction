import { appendFileSync } from "node:fs"
import { main, requireEnv, run, spawn, succeeds } from "./lib.js"

await main(() => {
  requireEnv("GITHUB_OUTPUT", "VERSION", "GH_TOKEN", "DEFAULT_BRANCH")

  const version = process.env.VERSION
  const tag = `v${version}`
  const defaultBranch = process.env.DEFAULT_BRANCH
  const packageDir = process.env.PACKAGE_DIR ?? "."
  const manifest = packageDir === "." ? "package.json" : `${packageDir}/package.json`
  const push = (...command) => run(["git", "-c", "credential.helper=!gh auth git-credential", "push", ...command])

  run(["git", "config", "user.name", "github-actions[bot]"])
  run(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"])
  run(["git", "add", "-u", "--", manifest, "bun.lock"])

  const tagExists = succeeds(["git", "show-ref", "--verify", "--quiet", `refs/tags/${tag}`])
  const staged = !succeeds(["git", "diff", "--cached", "--quiet"])
  if (!staged && tagExists) {
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${run(["git", "rev-parse", "HEAD"])}\n`)
    console.log(`Tag ${tag} already points at the checked version; nothing to commit.`)
    return
  }

  if (staged) run(["git", "commit", "-m", `chore(release): bump version to ${version}`])
  const releaseSha = run(["git", "rev-parse", "HEAD"])

  if (tagExists) {
    run(["git", "fetch", "origin", defaultBranch])
    run(["git", "checkout", "--detach", "FETCH_HEAD"])
    const picked = spawn(["git", "cherry-pick", releaseSha])
    if (picked.status !== 0) {
      if (!succeeds(["git", "diff", "--cached", "--quiet"])) {
        throw new Error(`\`git cherry-pick ${releaseSha}\` failed: ${picked.stderr?.trim() || picked.stdout?.trim()}`)
      }
      run(["git", "cherry-pick", "--skip"])
      console.log(`Version bump for ${tag} is already on ${defaultBranch}; nothing to cherry-pick.`)
    } else {
      push("origin", `HEAD:refs/heads/${defaultBranch}`)
      console.log(`Cherry-picked the version bump for ${tag} onto ${defaultBranch}.`)
    }
  } else {
    run(["git", "tag", tag])
    push("--atomic", "origin", `HEAD:refs/heads/${defaultBranch}`, `refs/tags/${tag}`)
    console.log(`Tagged ${tag} and pushed it with ${defaultBranch}.`)
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `sha=${releaseSha}\n`)
})
