import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  exec: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => childProcess);

import treeKill, { treeKillSync, type ProcessLike } from "./index.js";

const originalPlatform = process.platform;

type KillApi = {
  name: "async" | "sync";
  run: (proc: ProcessLike, signal?: NodeJS.Signals) => Promise<void>;
};

const killApis: KillApi[] = [
  {
    name: "async",
    run: (proc, signal) => treeKill(proc, signal),
  },
  {
    name: "sync",
    run: (proc, signal) => Promise.resolve().then(() => treeKillSync(proc, signal)),
  },
];

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function createProc(pid?: number): ProcessLike & { kill: ReturnType<typeof vi.fn> } {
  return {
    pid,
    kill: vi.fn(() => true),
  };
}

function createSpawnChild(stdout: string, code = 0): EventEmitter & { stdout: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
  child.stdout = new EventEmitter();

  queueMicrotask(() => {
    if (stdout.length > 0) {
      child.stdout.emit("data", Buffer.from(stdout, "ascii"));
    }
    child.emit("close", code);
  });

  return child;
}

describe("@alloc/tree-kill", () => {
  beforeEach(() => {
    childProcess.exec.mockReset();
    childProcess.execFileSync.mockReset();
    childProcess.spawn.mockReset();
    childProcess.spawnSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setPlatform(originalPlatform);
  });

  it.each(killApis)("$name falls back to proc.kill when pid is missing", async ({ run }) => {
    const proc = createProc(Number.NaN);

    await run(proc, "SIGTERM");

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(childProcess.exec).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it("uses pgrep traversal for the async API on macOS", async () => {
    setPlatform("darwin");

    const proc = createProc(100);
    const killOrder: number[] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      killOrder.push(pid);
      return true;
    }) as typeof process.kill);

    childProcess.spawn.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe("pgrep");
      expect(args[0]).toBe("-P");

      const pid = Number(args[1]);
      if (pid === 100) return createSpawnChild("200\n300\n");
      if (pid === 200) return createSpawnChild("400\n");
      return createSpawnChild("", 1);
    });

    await treeKill(proc, "SIGTERM");

    expect(childProcess.spawn.mock.calls).toEqual([
      ["pgrep", ["-P", "100"]],
      ["pgrep", ["-P", "200"]],
      ["pgrep", ["-P", "300"]],
      ["pgrep", ["-P", "400"]],
    ]);
    expect(killOrder).toEqual([400, 200, 300, 100]);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses pgrep traversal for the sync API on macOS", () => {
    setPlatform("darwin");

    const proc = createProc(100);
    const killOrder: number[] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      killOrder.push(pid);
      return true;
    }) as typeof process.kill);

    childProcess.spawnSync.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe("pgrep");
      expect(args[0]).toBe("-P");

      const pid = Number(args[1]);
      if (pid === 100) return { status: 0, stdout: "200\n300\n" };
      if (pid === 200) return { status: 0, stdout: "400\n" };
      return { status: 1, stdout: "" };
    });

    treeKillSync(proc, "SIGTERM");

    expect(childProcess.spawnSync.mock.calls).toEqual([
      ["pgrep", ["-P", "100"], { encoding: "ascii" }],
      ["pgrep", ["-P", "200"], { encoding: "ascii" }],
      ["pgrep", ["-P", "400"], { encoding: "ascii" }],
      ["pgrep", ["-P", "300"], { encoding: "ascii" }],
    ]);
    expect(killOrder).toEqual([400, 200, 300, 100]);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each(killApis)("$name ignores ESRCH for Linux descendants", async ({ name, run }) => {
    setPlatform("linux");

    const proc = createProc(100);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
      if (pid === 200) {
        const error = new Error("missing child") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      expect(signal).toBe("SIGTERM");
      return true;
    }) as typeof process.kill);

    if (name === "async") {
      childProcess.spawn.mockImplementation((command: string, args: string[]) => {
        expect(command).toBe("ps");
        const pid = Number(args[4]);
        expect(args).toEqual(["-o", "pid", "--no-headers", "--ppid", String(pid)]);
        return createSpawnChild(pid === 100 ? "200\n" : "", pid === 100 ? 0 : 1);
      });
    } else {
      childProcess.spawnSync.mockImplementation((command: string, args: string[]) => {
        expect(command).toBe("ps");
        const pid = Number(args[4]);
        expect(args).toEqual(["-o", "pid", "--no-headers", "--ppid", String(pid)]);
        return { status: pid === 100 ? 0 : 1, stdout: pid === 100 ? "200\n" : "" };
      });
    }

    await run(proc, "SIGTERM");

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each(killApis)("$name rethrows non-ESRCH descendant kill failures", async ({ name, run }) => {
    setPlatform("linux");

    const proc = createProc(100);
    vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === 200) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return true;
    }) as typeof process.kill);

    if (name === "async") {
      childProcess.spawn.mockImplementation((command: string, args: string[]) => {
        expect(command).toBe("ps");
        const pid = Number(args[4]);
        return createSpawnChild(pid === 100 ? "200\n" : "", pid === 100 ? 0 : 1);
      });
    } else {
      childProcess.spawnSync.mockImplementation((command: string, args: string[]) => {
        expect(command).toBe("ps");
        const pid = Number(args[4]);
        return { status: pid === 100 ? 0 : 1, stdout: pid === 100 ? "200\n" : "" };
      });
    }

    await expect(run(proc, "SIGTERM")).rejects.toThrow("permission denied");
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("uses taskkill for the async API on Windows", async () => {
    setPlatform("win32");

    const proc = createProc(100);
    childProcess.exec.mockImplementation((_command: string, callback: (error: null) => void) => {
      callback(null);
      return {} as never;
    });

    await treeKill(proc, "SIGTERM");

    expect(childProcess.exec).toHaveBeenCalledWith("taskkill /pid 100 /T /F", expect.any(Function));
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses taskkill for the sync API on Windows", () => {
    setPlatform("win32");

    const proc = createProc(100);

    treeKillSync(proc, "SIGTERM");

    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "100", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each(killApis)(
    "$name falls back to proc.kill when Windows taskkill fails",
    async ({ name, run }) => {
      setPlatform("win32");

      const proc = createProc(100);

      if (name === "async") {
        childProcess.exec.mockImplementation(
          (_command: string, callback: (error: Error) => void) => {
            callback(new Error("taskkill failed"));
            return {} as never;
          },
        );
      } else {
        childProcess.execFileSync.mockImplementation(() => {
          throw new Error("taskkill failed");
        });
      }

      await run(proc, "SIGTERM");

      expect(proc.kill).toHaveBeenCalledTimes(2);
      expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGTERM");
    },
  );
});
