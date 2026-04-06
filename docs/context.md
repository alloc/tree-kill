# Overview

`@alloc/tree-kill` kills a root process and, when a numeric pid is available,
walks the process tree so descendants are signaled before the parent.

This package is a rewrite of the original
[`tree-kill`](https://www.npmjs.com/package/tree-kill). It keeps the upstream
platform strategy of using `pgrep` on macOS, `ps` on Linux, and `taskkill` on
Windows, but its public API is intentionally different: `treeKill(proc,
signal?)` accepts a `ChildProcess`-like object and returns a `Promise<void>`.

# When to Use

- You already have a `ChildProcess` or equivalent handle and want to terminate
  the whole tree from application code.
- You want one small helper that works across macOS, Linux, and Windows.
- You want the root process signaled even when descendant enumeration finds no
  children.

# When Not to Use

- You only have a raw pid and need drop-in compatibility with upstream
  `tree-kill`.
- You need a callback-based API or a CLI.
- You need signal-specific behavior on Windows; Windows always uses
  `taskkill /T /F` first.

# Core Abstractions

- `ProcessLike`: any object with a `kill(signal?)` method and an optional
  numeric `pid`.
- `treeKill(proc, signal?)`: the promise-based entrypoint for killing the root
  process and, when possible, its descendants.
- Numeric `pid`: the capability that enables tree traversal. Without it,
  `treeKill` degrades to a direct `kill()` call on the provided object.

# Data Flow / Lifecycle

1. If `proc.pid` is missing or not numeric, call `proc.kill(signal)` directly
   and stop.
2. On Windows, run `taskkill /pid <pid> /T /F`; if that fails, fall back to
   `proc.kill(signal)`.
3. On macOS, recurse through child processes with `pgrep -P <pid>`.
4. On Linux, recurse through child processes with
   `ps -o pid --no-headers --ppid <pid>`.
5. Kill descendants before parents, ignore `ESRCH` for already-exited child
   processes, then call `proc.kill(signal)` once more so the root process is
   still signaled if traversal did not finish it off.

# Common Tasks -> Recommended APIs

- Kill a spawned child tree with the default signal: `await treeKill(child)`
- Use a stronger Unix-like signal:
  `await treeKill(child, "SIGKILL")`
- Support a custom process wrapper without a pid:
  `await treeKill(proc)` and let the wrapper's own `kill()` implementation
  decide what to do

# Invariants and Constraints

- `proc.kill` is required; there is no pid-only overload.
- Descendant traversal only happens when `proc.pid` is a valid number.
- macOS and Linux rely on `pgrep` and `ps` being available in the runtime
  environment.
- Windows does not preserve POSIX signal semantics because `taskkill /F` is the
  primary kill mechanism.
- The promise resolves with `void`; success is defined by the absence of a
  thrown error, not by the boolean returned from `proc.kill()`.

# Error Model

- `ESRCH` from `process.kill()` is ignored for descendants that already exited.
- Other `process.kill()` failures are thrown.
- On Windows, `taskkill` failures are swallowed so the fallback `proc.kill()`
  call can still run.
- A missing or non-numeric `pid` is not an error if the provided object
  implements `kill()`.

# Terminology

- Root process: the process referenced by `proc`.
- Descendant: any child, grandchild, or deeper process spawned under the root.
- Process tree: the root plus all descendants that can be discovered from the
  root pid.
- ProcessLike: the minimal interface this package needs in order to signal the
  root process.

# Non-Goals

- Providing a CLI like the original `tree-kill` package.
- Preserving upstream's pid-first callback signature.
- Acting as a supervisor, restart loop, or timeout manager.
