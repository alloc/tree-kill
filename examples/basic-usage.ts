import { spawn } from "node:child_process"

import treeKill from "../src/index.js"

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
})

await treeKill(child, "SIGTERM")
