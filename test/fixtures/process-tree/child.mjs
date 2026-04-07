import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const fixtureDir = dirname(fileURLToPath(import.meta.url))

const grandchild = spawn(process.execPath, [resolve(fixtureDir, "grandchild.mjs")], {
  stdio: "ignore",
  windowsHide: true,
})

process.send?.({
  grandchildPid: grandchild.pid,
})

setInterval(() => {}, 1_000)
