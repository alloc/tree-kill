# @alloc/tree-kill

## Purpose

`@alloc/tree-kill` kills a spawned process and its descendants across macOS,
Linux, and Windows.

It is a rewrite of the original
[`tree-kill`](https://www.npmjs.com/package/tree-kill) package that preserves
the same OS-specific traversal strategy but changes the public API to a
promise-based `ProcessLike` interface instead of a raw `pid` plus callback.

## Installation

```sh
pnpm add @alloc/tree-kill
```

## Quick Example

```ts
import { spawn } from "node:child_process"
import treeKill from "@alloc/tree-kill"

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
})

await treeKill(child, "SIGTERM")
```

## Documentation Map

- Conceptual behavior, platform notes, and rewrite boundaries:
  [docs/context.md](./docs/context.md)
- Runnable repository example: [examples/basic-usage.ts](./examples/basic-usage.ts)
- Exact exported signatures: run `pnpm build` and inspect `dist/index.d.mts`
