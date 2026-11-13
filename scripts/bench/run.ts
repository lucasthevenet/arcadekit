// `pnpm bench`: bundles hot-paths.ts for Node with Vite, resolving the kit to its src/ files as
// the tests do, and runs the bundle with the flags its heap counts need:
//
// - `--expose-gc`, so each count starts from a collected heap;
// - `--max-semi-space-size`, a young generation large enough that no collection runs while a
//   count is taken: what the heap grew by is then what the hot path allocated;
// - `--single-threaded`, so the engine optimizes a function at the same point of every run, and
//   a hot path counts the same bytes each time. On background threads, an optimization that
//   lands during the count moved it by a hundred bytes or more.
//
// The baseline it is compared against is docs/perf-baseline.md.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import path from "node:path";

import { build } from "vite";

import { sourceCondition } from "../source-condition.ts";

const here = import.meta.dirname;
const out = mkdtempSync(path.join(tmpdir(), "arcadekit-bench-"));

try {
  await build({
    configFile: false,
    root: here,
    logLevel: "warn",
    plugins: [sourceCondition()],
    // Everything in one file, effect included, so nothing is resolved at run time.
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: path.join(here, "hot-paths.ts"),
      outDir: out,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { entryFileNames: "hot-paths.mjs" } },
    },
  });

  const [cpu] = cpus();
  console.log(
    `arcadekit bench: Node ${process.version}, ${process.platform} ${process.arch}, ${cpu?.model ?? "unknown CPU"} (${cpus().length} cores)\n`
  );
  execFileSync(
    process.execPath,
    [
      "--expose-gc",
      "--single-threaded",
      "--max-semi-space-size=256",
      path.join(out, "hot-paths.mjs"),
    ],
    { stdio: "inherit" }
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
