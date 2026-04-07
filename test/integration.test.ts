import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import treeKill, { treeKillSync } from "../src/index.js"

const rootFixturePath = fileURLToPath(new URL("./fixtures/process-tree/root.mjs", import.meta.url))

type TreeInfo = {
  root: ChildProcess
  childPid: number
  grandchildPid: number
}

const trackedPids = new Set<number>()

afterEach(async () => {
  for (const pid of trackedPids) {
    killPidBestEffort(pid)
    trackedPids.delete(pid)
  }
})

describe("real process-tree killing", () => {
  it("kills a live descendant tree with the async API", async () => {
    const tree = await spawnProcessTree()

    await treeKill(tree.root, "SIGTERM")

    await assertTreeExited(tree)
  })

  it("kills a live descendant tree with the sync API", async () => {
    const tree = await spawnProcessTree()

    treeKillSync(tree.root, "SIGTERM")

    await assertTreeExited(tree)
  })
})

async function spawnProcessTree(): Promise<TreeInfo> {
  const root = spawn(process.execPath, [rootFixturePath], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    windowsHide: true,
  })

  if (typeof root.pid === "number") {
    trackedPids.add(root.pid)
  }

  const ready = await waitForReadyMessage(root)
  const tree = {
    root,
    childPid: ready.childPid,
    grandchildPid: ready.grandchildPid,
  }

  trackedPids.add(tree.childPid)
  trackedPids.add(tree.grandchildPid)

  return tree
}

function waitForReadyMessage(
  root: ChildProcess,
  timeoutMs = 10_000,
): Promise<{ childPid: number; grandchildPid: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("timed out while waiting for process-tree fixture readiness"))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      root.off("message", onMessage)
      root.off("exit", onExit)
      root.off("error", onError)
    }

    const onMessage = (message: unknown) => {
      if (!isReadyMessage(message)) {
        cleanup()
        reject(new Error(`received invalid fixture message: ${JSON.stringify(message)}`))
        return
      }
      cleanup()
      resolve(message)
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`fixture root exited before readiness (code=${code}, signal=${signal})`))
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    root.on("message", onMessage)
    root.on("exit", onExit)
    root.on("error", onError)
  })
}

function isReadyMessage(message: unknown): message is { childPid: number; grandchildPid: number } {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { childPid?: unknown }).childPid === "number" &&
    typeof (message as { grandchildPid?: unknown }).grandchildPid === "number"
  )
}

async function assertTreeExited(tree: TreeInfo): Promise<void> {
  await waitForChildExit(tree.root)
  await Promise.all([
    waitForPidToExit(tree.root.pid!),
    waitForPidToExit(tree.childPid),
    waitForPidToExit(tree.grandchildPid),
  ])

  expect(isProcessAlive(tree.root.pid!)).toBe(false)
  expect(isProcessAlive(tree.childPid)).toBe(false)
  expect(isProcessAlive(tree.grandchildPid)).toBe(false)

  trackedPids.delete(tree.root.pid!)
  trackedPids.delete(tree.childPid)
  trackedPids.delete(tree.grandchildPid)
}

async function waitForChildExit(root: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (root.exitCode !== null || root.signalCode !== null) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("timed out while waiting for root process to exit"))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      root.off("exit", onExit)
      root.off("error", onError)
    }

    const onExit = () => {
      cleanup()
      resolve()
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    root.on("exit", onExit)
    root.on("error", onError)
  })
}

async function waitForPidToExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error(`timed out while waiting for pid ${pid} to exit`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") {
      return false
    }
    if (code === "EPERM") {
      return true
    }
    throw error
  }
}

function killPidBestEffort(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ESRCH") {
      throw error
    }
  }
}
