/**
 * A worker of `bench/parallel/run.ts`: it waits for a job, runs the kernel
 * it is told over the rows it is told, on columns it shares with the main
 * thread, and says when it is done.
 */
import { workerData } from "node:worker_threads";

import { DONE, INTEGERS, JOB, KERNEL, kernels, RANGES, SPIN } from "./kernels";

const { columns, control, id } = workerData as {
  readonly columns: readonly SharedArrayBuffer[];
  readonly control: SharedArrayBuffer;
  readonly id: number;
};

const signals = new Int32Array(control, 0, INTEGERS);
const numbers = new Float64Array(control, INTEGERS * 4, 8);
const [px, py, vx, vy] = columns.map((buffer) => new Float32Array(buffer));
const names = Object.keys(kernels);

let seen = 0;

for (;;) {
  // Asleep until the next job, or spinning for it a while first: a thread
  // that sleeps takes longer to wake than a short loop takes to run.
  if (Atomics.load(signals, SPIN) === 1) {
    let spins = 0;

    while (Atomics.load(signals, JOB) === seen && spins++ < 20_000) {
      // Spinning.
    }
  }

  Atomics.wait(signals, JOB, seen);
  seen = Atomics.load(signals, JOB);

  if (seen < 0) {
    break;
  }

  kernels[names[signals[KERNEL]!]!]!(
    signals[RANGES + id * 2]!,
    signals[RANGES + id * 2 + 1]!,
    px!,
    py!,
    vx!,
    vy!,
    numbers[0]!,
    numbers[1]!
  );
  Atomics.add(signals, DONE, 1);
  Atomics.notify(signals, DONE);
}
