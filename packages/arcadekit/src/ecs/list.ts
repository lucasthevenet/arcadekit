/**
 * Lists a world keeps beside its components: values in the order they were
 * added, which the world snapshots, loads, restores and hashes as it does a
 * `ref` field, each value through the list's codec. An app keeps the actions
 * queued for the next tick in one, and the events waiting to be read in one
 * per event.
 *
 * No Effect dependency.
 */
import type { RefCodec } from "./component";

/**
 * A kind of list, defined once by name: what `World._list` keeps, and what
 * `World.load` finds by the name a snapshot holds.
 *
 * @internal
 */
export interface ListDef<T = unknown> {
  /** Its identity in a world and in a snapshot. Unique among lists. */
  readonly name: string;
  /**
   * Converts each value to plain data and back, as a `ref` field's codec does.
   * Its `encode` may throw for a value it can't save, with a message that says
   * why.
   */
  readonly codec: RefCodec<T>;
  /**
   * What it holds, to a person reading a message that begins "Can't save":
   * `the "Hit" events waiting to be read`.
   */
  readonly label: string;
  /**
   * Whether the stages between ticks may add to it, as they issue the actions
   * for the next tick. `World._frameHash` leaves such a list out.
   */
  readonly betweenTicks: boolean;
}

// Every list this program has defined, by name, so that a world can load a
// snapshot that holds one it hasn't met yet. Of two definitions with one name,
// as a module that is loaded again under hot reload makes, it is the newer.
const defined = new Map<string, ListDef>();

/**
 * Defines a kind of list.
 *
 * @internal
 */
export const defineList = <T>(
  name: string,
  codec: RefCodec<T>,
  options: { readonly label: string; readonly betweenTicks?: boolean }
): ListDef<T> => {
  const def: ListDef<T> = {
    name,
    codec,
    label: options.label,
    betweenTicks: options.betweenTicks === true,
  };
  defined.set(name, def as ListDef);
  return def;
};

/**
 * Returns the list this program defined last with this name, or undefined if
 * it defined none.
 *
 * @internal
 */
export const definedList = (name: string): ListDef | undefined =>
  defined.get(name);
