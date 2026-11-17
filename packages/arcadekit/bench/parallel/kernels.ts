/**
 * The loops of `bench/parallel/run.ts`: plain functions over columns and a
 * range of rows, in a module that the main thread and every worker import.
 * A worker has no closure of the main thread's to run, so what runs on one
 * is a function it has imported itself, given nothing but arrays and
 * numbers.
 */
type Floats = Float32Array;

export type Kernel = (
  start: number,
  end: number,
  px: Floats,
  py: Floats,
  vx: Floats,
  vy: Floats,
  dt: number,
  count: number
) => void;

export const kernels: Record<string, Kernel> = {
  // What the package's benchmark does: pos += vel * dt.
  move(start, end, px, py, vx, vy, dt) {
    for (let i = start; i < end; i++) {
      px[i]! += vx[i]! * dt;
      py[i]! += vy[i]! * dt;
    }
  },

  // A flock. Each looks at the eight beside it in the table, steers
  // towards their middle and away from the nearest, and is slowed. It
  // reads positions and writes velocities, so two threads given different
  // rows write nothing the other reads, and the result is the same however
  // the rows are shared out.
  flock(start, end, px, py, vx, vy, dt, count) {
    for (let i = start; i < end; i++) {
      let cx = 0;
      let cy = 0;
      let ax = 0;
      let ay = 0;
      let near = 1e30;
      const x = px[i]!;
      const y = py[i]!;
      for (let k = -4; k <= 4; k++) {
        if (k === 0) {
          continue;
        }
        let j = i + k;
        if (j < 0) {
          j += count;
        } else if (j >= count) {
          j -= count;
        }
        const dx = px[j]! - x;
        const dy = py[j]! - y;
        cx += dx;
        cy += dy;
        const d = dx * dx + dy * dy;
        if (d < near) {
          near = d;
          ax = -dx;
          ay = -dy;
        }
      }
      const inv = 1 / Math.sqrt(near + 1e-6);
      let nvx = vx[i]! + (cx * 0.125 * 0.5 + ax * inv) * dt;
      let nvy = vy[i]! + (cy * 0.125 * 0.5 + ay * inv) * dt;
      const speed = Math.sqrt(nvx * nvx + nvy * nvy);
      if (speed > 4) {
        nvx *= 4 / speed;
        nvy *= 4 / speed;
      }
      vx[i] = nvx * 0.999;
      vy[i] = nvy * 0.999;
    }
  },
};

/** Where the threads tell each other what to do, in a shared array of 32-bit integers. */
export const JOB = 0;
export const DONE = 1;
export const KERNEL = 2;
export const SPIN = 3;
/** Each worker's range of rows starts here: its start, then its end. */
export const RANGES = 8;
/** How many integers there are, ahead of the numbers the kernels are given. */
export const INTEGERS = 64;
