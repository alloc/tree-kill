import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const fixtureDir = dirname(fileURLToPath(import.meta.url))

const child = spawn(process.execPath, [resolve(fixtureDir, "child.mjs")], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
  windowsHide: true,
})

child.on("message", (message) => {
  process.send?.({
    childPid: child.pid,
    grandchildPid: message?.grandchildPid,
  })
})

setInterval(() => {}, 1_000)
