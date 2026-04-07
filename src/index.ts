import { exec, execFileSync, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

type KillSignal = number | NodeJS.Signals;
type ProcessTree = Record<number, number[]>;
type SyncProcessListResult = {
  status: number | null;
  stdout: Buffer | string;
};

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
  pid?: number;

  /**
   * Sends a signal to the root process.
   */
  kill: (signal?: KillSignal) => boolean;
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
  const pid = getProcessPid(proc);
  if (pid === undefined) {
    proc.kill(signal);
    return;
  }

  switch (process.platform) {
    case "win32":
      try {
        await execAsync(`taskkill /pid ${pid} /T /F`);
      } catch {
        proc.kill(signal);
      }
      break;
    case "darwin":
      await killTreeAsync(pid, signal, (parentPid) => spawn("pgrep", ["-P", String(parentPid)]));
      break;
    default: // Linux
      await killTreeAsync(pid, signal, (parentPid) =>
        spawn("ps", ["-o", "pid", "--no-headers", "--ppid", String(parentPid)]),
      );
      break;
  }

  // Ensure the top-level process itself gets killed if the OS-specific traversal didn't kill it
  proc.kill(signal);
}

/**
 * Synchronous counterpart to {@link treeKill} for shutdown paths where async
 * work cannot be awaited reliably, such as a Node.js `process.on("exit")`
 * handler.
 *
 * @param proc Process handle for the root process.
 * @param signal Signal to deliver. Leaving it undefined uses the platform
 * default, which is usually `SIGTERM`.
 * @throws Propagates non-`ESRCH` errors from `process.kill()` or from the
 * fallback `proc.kill()` call.
 */
export function treeKillSync(proc: ProcessLike, signal?: KillSignal): void {
  const pid = getProcessPid(proc);
  if (pid === undefined) {
    proc.kill(signal);
    return;
  }

  switch (process.platform) {
    case "win32":
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {
        proc.kill(signal);
      }
      break;
    case "darwin":
      killTreeSync(pid, signal, (parentPid) =>
        spawnSync("pgrep", ["-P", String(parentPid)], { encoding: "ascii" }),
      );
      break;
    default: // Linux
      killTreeSync(pid, signal, (parentPid) =>
        spawnSync("ps", ["-o", "pid", "--no-headers", "--ppid", String(parentPid)], {
          encoding: "ascii",
        }),
      );
      break;
  }

  proc.kill(signal);
}

function getProcessPid(proc: ProcessLike): number | undefined {
  return typeof proc.pid === "number" && !Number.isNaN(proc.pid) ? proc.pid : undefined;
}

function killTree(rootPid: number, tree: ProcessTree, signal?: KillSignal): void {
  const killed = new Set<number>();
  const visit = (pid: number): void => {
    for (const childPid of tree[pid] ?? []) {
      visit(childPid);
    }
    if (!killed.has(pid)) {
      killPid(pid, signal);
      killed.add(pid);
    }
  };

  visit(rootPid);
}

function killPid(pid: number | string, signal?: KillSignal): void {
  try {
    process.kill(typeof pid === "string" ? parseInt(pid, 10) : pid, signal);
  } catch (err: any) {
    if (err.code !== "ESRCH") throw err;
  }
}

async function killTreeAsync(
  rootPid: number,
  signal: KillSignal | undefined,
  spawnChildProcessesList: (pid: number) => ReturnType<typeof spawn>,
): Promise<void> {
  const tree = createTree(rootPid);
  await buildProcessTreeAsync(rootPid, tree, spawnChildProcessesList);
  killTree(rootPid, tree, signal);
}

function killTreeSync(
  rootPid: number,
  signal: KillSignal | undefined,
  spawnChildProcessesList: (pid: number) => SyncProcessListResult,
): void {
  const tree = createTree(rootPid);
  buildProcessTreeSync(rootPid, tree, spawnChildProcessesList);
  killTree(rootPid, tree, signal);
}

function createTree(rootPid: number): ProcessTree {
  return { [rootPid]: [] };
}

function parseProcessTreeOutput(output: Buffer | string | null | undefined): number[] {
  const matches = output?.toString().match(/\d+/g);
  return matches ? matches.map((pid) => parseInt(pid, 10)) : [];
}

function buildProcessTreeSync(
  parentPid: number,
  tree: ProcessTree,
  spawnChildProcessesList: (pid: number) => SyncProcessListResult,
): void {
  const ps = spawnChildProcessesList(parentPid);
  if (ps.status !== 0) {
    return;
  }

  for (const pid of parseProcessTreeOutput(ps.stdout)) {
    tree[parentPid].push(pid);
    tree[pid] = [];
    buildProcessTreeSync(pid, tree, spawnChildProcessesList);
  }
}

async function buildProcessTreeAsync(
  parentPid: number,
  tree: ProcessTree,
  spawnChildProcessesList: (pid: number) => ReturnType<typeof spawn>,
): Promise<void> {
  const output = await new Promise<{ code: number | null; data: string }>((resolve) => {
    const ps = spawnChildProcessesList(parentPid);
    let allData = "";
    ps.stdout?.on("data", (data: Buffer) => {
      allData += data.toString("ascii");
    });

    ps.on("close", (code) => resolve({ code, data: allData }));
  });

  if (output.code !== 0) {
    return;
  }

  await Promise.all(
    parseProcessTreeOutput(output.data).map(async (pid) => {
      tree[parentPid].push(pid);
      tree[pid] = [];
      await buildProcessTreeAsync(pid, tree, spawnChildProcessesList);
    }),
  );
}
