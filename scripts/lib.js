import { spawnSync } from "node:child_process"

export async function main(fn) {
  try {
    await fn()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

export function requireEnv(...names) {
  for (const name of names) {
    if (!process.env[name]) throw new Error(`${name} is not set`)
  }
}

export function spawn(command) {
  return spawnSync(command[0], command.slice(1), { encoding: "utf8" })
}

export function run(command, options = {}) {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", ...options })
  if (result.status !== 0) {
    throw new Error(`\`${command.join(" ")}\` failed: ${result.stderr?.trim() || result.stdout?.trim()}`)
  }
  return result.stdout?.trim()
}

export function succeeds(command) {
  return spawn(command).status === 0
}
