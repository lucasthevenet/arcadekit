/**
 * What would running a system's loop on workers over shared memory buy?
 *
 * Not the package: a measurement to decide by, of the smallest thing that
 * could be called parallel systems. Columns in shared memory, a loop that
 * is a plain function every thread has imported, the rows of a table
 * shared out between the workers and the main thread, and the main thread
 * waiting for all of them before it goes on, so that a tick is still one
 * synchronous step.
 *
 *   pnpm --filter arcadekit bench:parallel
 *
 * Each line is the best of three processes, the median pass of each. A
 * line is run on its own as
 *
 *   node --import tsx bench/parallel/run.ts <kernel> <entities> <workers> <wait|spin> [plain]
 *
 * `wait` has the threads sleep until they are needed and `spin` has them
 * turn in place, which is what a page's main thread has to do in any case:
 * it may not sleep. `plain` gives the columns ordinary memory, with no
 * workers, to see what shared memory costs a loop on one thread.
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import { DONE, INTEGERS, JOB, KERNEL, kernels, RANGES, SPIN } from "./kernels";

const DT = 1 / 60;

/** Median milliseconds of a pass, and a sum of what it left, to compare. */
const run = async (
  kernel: string,
  count: number,
  workers: number,
  mode: string,
  backing: string
): Promise<{ readonly ms: number; readonly sum: number }> => {
  const columns = Array.from({ length: 4 }, () =>
    backing === "plain"
      ? new ArrayBuffer(count * 4)
      : new SharedArrayBuffer(count * 4)
  );

  const [px, py, vx, vy] = columns.map((buffer) => new Float32Array(buffer));

  for (let i = 0; i < count; i += 1) {
    px![i] = (i * 7919) % 1000;
    py![i] = (i * 104_729) % 1000;
    vx![i] = 1;
    vy![i] = 2;
  }

  const control = new SharedArrayBuffer(INTEGERS * 4 + 8 * 8);
  const signals = new Int32Array(control, 0, INTEGERS);
  const numbers = new Float64Array(control, INTEGERS * 4, 8);
  numbers[0] = DT;
  numbers[1] = count;
  signals[KERNEL] = Object.keys(kernels).indexOf(kernel);
  signals[SPIN] = mode === "spin" ? 1 : 0;

  const pool = Array.from(
    { length: workers },
    (_, id) =>
      new Worker(new URL("worker.ts", import.meta.url), {
        execArgv: ["--import", "tsx"],
        workerData: { columns, control, id },
      })
  );

  // Until they are up and waiting.
  await sleep(400);
  const loop = kernels[kernel]!;

  const pass =
    workers === 0
      ? (): void => loop(0, count, px!, py!, vx!, vy!, DT, count)
      : (): void => {
          // The table cut into as many runs of rows as there are threads.
          // The main thread takes the last, and then waits for the rest.
          const share = Math.ceil(count / (workers + 1));

          for (let id = 0; id < workers; id += 1) {
            signals[RANGES + id * 2] = id * share;
            signals[RANGES + id * 2 + 1] = Math.min(count, (id + 1) * share);
          }

          Atomics.store(signals, DONE, 0);
          Atomics.add(signals, JOB, 1);
          Atomics.notify(signals, JOB);
          loop(workers * share, count, px!, py!, vx!, vy!, DT, count);

          if (mode === "spin") {
            while (Atomics.load(signals, DONE) < workers) {
              // Spinning.
            }
          } else {
            for (
              let done = Atomics.load(signals, DONE);
              done < workers;
              done = Atomics.load(signals, DONE)
            ) {
              Atomics.wait(signals, DONE, done);
            }
          }
        };

  for (let i = 0; i < 80; i += 1) {
    pass();
  }

  const samples: number[] = [];

  for (let i = 0; i < 300; i += 1) {
    const start = performance.now();
    pass();
    samples.push(performance.now() - start);
  }

  samples.sort((a, b) => a - b);
  let sum = 0;

  for (let i = 0; i < count; i += 1) {
    sum += px![i]! + vx![i]!;
  }

  Atomics.store(signals, JOB, -1);
  Atomics.notify(signals, JOB);
  await Promise.all(pool.map((worker) => worker.terminate()));

  return { ms: samples[samples.length >> 1]!, sum: Math.fround(sum) };
};

const [kernel, count, workers, mode, backing] = process.argv.slice(2);

if (kernel === undefined) {
  const self = import.meta.filename;
  const lines: (readonly [string, number, number, string, string?])[] = [];

  for (const [name, size] of [
    ["move", 1000],
    ["move", 100_000],
    ["flock", 10_000],
    ["flock", 100_000],
    ["flock", 400_000],
  ] as const) {
    lines.push([name, size, 0, "wait", "plain"], [name, size, 0, "wait"]);

    for (const threads of [1, 3]) {
      lines.push([name, size, threads, "wait"], [name, size, threads, "spin"]);
    }
  }

  const sums = new Map<string, number>();

  for (const [name, size, threads, how, memory] of lines) {
    let ms = Infinity;
    let sum = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const out = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            self,
            name,
            String(size),
            String(threads),
            how,
            ...(memory === undefined ? [] : [memory]),
          ],
          { encoding: "utf-8" }
        )
          .trim()
          .split("\n")
          .pop()!
      ) as { readonly ms: number; readonly sum: number };

      ms = Math.min(ms, out.ms);
      ({ sum } = out);
    }

    // However the rows were shared out, what is left is what one thread leaves.
    const key = `${name} ${size}`;
    const same = sums.get(key) ?? sum;
    sums.set(key, same);

    const what =
      threads === 0
        ? `one thread, ${memory === "plain" ? "ordinary" : "shared"} memory`
        : `${threads} worker${threads === 1 ? "" : "s"} and the main thread, ${how === "spin" ? "spinning" : "asleep between"}`;

    console.log(
      `${name.padEnd(5)} ${String(size).padStart(7)} entities, ${what.padEnd(46)} ${(ms * 1000).toFixed(1).padStart(9)} µs${sum === same ? "" : "   NOT THE SAME RESULT"}`
    );
  }
} else {
  console.log(
    JSON.stringify(
      await run(
        kernel,
        Number(count),
        Number(workers),
        mode ?? "wait",
        backing ?? "shared"
      )
    )
  );
}
