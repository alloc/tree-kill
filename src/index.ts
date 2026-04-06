import { exec, spawn } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

type KillSignal = number | NodeJS.Signals

/**
 * Minimal process handle that {@link treeKill} can operate on.
 *
 * A numeric {@link ProcessLike.pid | pid} enables descendant traversal.
 * When it is missing or not numeric, {@link treeKill} falls back to a direct
 * call to {@link ProcessLike.kill | kill()}.
 */
export interface ProcessLike {
  /**
   * Operating system pid for the root process.
   */
  pid?: number

  /**
   * Sends a signal to the root process.
   */
  kill: (signal?: KillSignal) => boolean
}

/**
 * Kills a process and, when possible, every descendant in its process tree.
 *
 * @param proc Process handle for the root process.
 * @param signal Signal to deliver. Leaving it undefined uses the platform
 * default, which is usually `SIGTERM`.
 * @returns A promise that resolves after the tree traversal and kill attempts
 * complete.
 * @remarks This rewrite differs from the original `tree-kill` package by
 * accepting a `ChildProcess`-like object and returning a promise instead of
 * using a pid-first callback API.
 * @throws Propagates non-`ESRCH` errors from `process.kill()` or from the
 * fallback `proc.kill()` call.
 * @example
 * ```ts
 * import { spawn } from "node:child_process"
 * import treeKill from "@alloc/tree-kill"
 *
 * const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
 * await treeKill(child, "SIGTERM")
 * ```
 */
export default async function treeKill(proc: ProcessLike, signal?: KillSignal): Promise<void> {
  if (typeof proc.pid !== "number" || Number.isNaN(proc.pid)) {
    proc.kill(signal)
    return
  }
  const pid = proc.pid

  const tree: Record<number, number[]> = {}
  const pidsToProcess: Record<number, number> = {}
  tree[pid] = []
  pidsToProcess[pid] = 1

  switch (process.platform) {
    case "win32":
      try {
        await execAsync(`taskkill /pid ${pid} /T /F`)
      } catch {
        proc.kill(signal)
      }
      break
    case "darwin":
      await buildProcessTree(pid, tree, pidsToProcess, (parentPid) =>
        spawn("pgrep", ["-P", String(parentPid)]),
      )
      killAll(tree, signal)
      break
    default: // Linux
      await buildProcessTree(pid, tree, pidsToProcess, (parentPid) =>
        spawn("ps", ["-o", "pid", "--no-headers", "--ppid", String(parentPid)]),
      )
      killAll(tree, signal)
      break
  }

  // Ensure the top-level process itself gets killed if the OS-specific traversal didn't kill it
  proc.kill(signal)
}

function killAll(tree: Record<number, number[]>, signal?: string | number): void {
  const killed: Record<number, number> = {}
  Object.keys(tree).forEach((pidStr) => {
    const pid = parseInt(pidStr, 10)
    tree[pid].forEach((pidpid) => {
      if (!killed[pidpid]) {
        killPid(pidpid, signal)
        killed[pidpid] = 1
      }
    })
    if (!killed[pid]) {
      killPid(pid, signal)
      killed[pid] = 1
    }
  })
}

function killPid(pid: number | string, signal?: string | number): void {
  try {
    process.kill(typeof pid === "string" ? parseInt(pid, 10) : pid, signal)
  } catch (err: any) {
    if (err.code !== "ESRCH") throw err
  }
}

async function buildProcessTree(
  parentPid: number,
  tree: Record<number, number[]>,
  pidsToProcess: Record<number, number>,
  spawnChildProcessesList: (pid: number) => ReturnType<typeof spawn>,
): Promise<void> {
  return new Promise((resolve) => {
    const ps = spawnChildProcessesList(parentPid)
    let allData = ""
    ps.stdout?.on("data", (data: Buffer) => {
      allData += data.toString("ascii")
    })

    const onClose = async (code: number | null) => {
      delete pidsToProcess[parentPid]

      if (code !== 0) {
        // Command failed or found no children
        resolve()
        return
      }

      const matches = allData.match(/\d+/g)
      if (matches) {
        const promises: Promise<void>[] = []
        matches.forEach((pidStr) => {
          const pid = parseInt(pidStr, 10)
          tree[parentPid].push(pid)
          tree[pid] = []
          pidsToProcess[pid] = 1
          promises.push(buildProcessTree(pid, tree, pidsToProcess, spawnChildProcessesList))
        })
        await Promise.all(promises)
        resolve()
      } else {
        resolve()
      }
    }

    ps.on("close", onClose)
  })
}
