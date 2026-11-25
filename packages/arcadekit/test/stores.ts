import { SnapshotError } from "../src/ecs/index.ts";
import type { Store } from "../src/ecs/store.ts";

/**
 * A store for the tests: text in order, each saved as `{ said }`, and one
 * text, "unsayable", that it can't save.
 */
export class Shouts implements Store<readonly string[]> {
  readonly name: string;
  readonly betweenTicks: boolean;
  values: string[] = [];
  private txLength = 0;

  constructor(name: string, betweenTicks = false) {
    this.name = name;
    this.betweenTicks = betweenTicks;
  }

  save(): unknown {
    return this.values.length === 0
      ? undefined
      : this.values.map((value) => {
          if (value === "unsayable") {
            throw new SnapshotError(
              "cannot be saved",
              "Can't save the shouts: that is not said"
            );
          }
          return { said: value };
        });
  }

  load(data: unknown): void {
    for (const one of data as { said: unknown }[]) {
      if (typeof one.said !== "string") {
        throw new SnapshotError(
          "store changed",
          "Can't load the shouts: a shout is a string"
        );
      }
      this.values.push(one.said);
    }
  }

  hashed(): unknown {
    return this.values.length === 0
      ? undefined
      : this.values.map((value) => (value === "unsayable" ? null : value));
  }

  capture(): readonly string[] {
    return this.values.slice();
  }

  rewind(moment: readonly string[]): void {
    this.values = moment.slice();
  }

  clear(): void {
    this.values = [];
  }

  begin(): void {
    this.txLength = this.values.length;
  }

  rollback(): void {
    this.values.length = this.txLength;
  }

  commit(): void {}

  contents(): unknown {
    return this.values.length === 0 ? undefined : [...this.values];
  }
}
