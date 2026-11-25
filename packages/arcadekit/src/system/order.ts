import type { Adds, Watches, WatchesAdded, Writes } from "../Query";
import type { System, Trigger } from "../System";
import { frameStages } from "../System";

type FrameStage = (typeof frameStages)[number];

// --- the order of a list, as the compiler sees it ---------------------------

/** A system of any type. */
type Any = System<unknown, unknown>;

// A name the compiler only knows as `string` says nothing of which component
// it is, as in the requirements of a system typed as any system: left out.
type Named<C extends string> = string extends C ? never : C;
type WrittenBy<R> = R extends Writes<infer C> ? Named<C> : never;
type AddedBy<R> = R extends Adds<infer C> ? Named<C> : never;
/** What a system watches with `Query.changed`. */
type WatchedBy<R> = R extends Watches<infer C> ? Named<C> : never;
/** What a system watches with `Query.added`. */
type AwaitedBy<R> = R extends WatchesAdded<infer C> ? Named<C> : never;

// Distributive on purpose: one for each component of a union.
type Did<C, N extends string, How extends string> = C extends string
  ? readonly [C, N, How]
  : never;

/** Each component a system writes or adds, with its name and which it does. */
type Wrote<R, N extends string> =
  | Did<WrittenBy<R>, N, "writes">
  | Did<AddedBy<R>, N, "spawns or adds">;

/** What is said of a list that isn't written out as a tuple. */
type NotTuple =
  "List systems, handlers and plugins as a literal list, [a, b], so the compiler can read their names and order.";

/** The systems of a tuple, each name once: the first to be listed stays. */
type Once<
  T extends readonly Any[],
  Seen extends string = never,
  Out extends readonly Any[] = readonly [],
> = T extends readonly [
  infer H extends Any,
  ...infer Rest extends readonly Any[],
]
  ? string extends H["name"]
    ? Once<Rest, Seen, readonly [...Out, H]>
    : H["name"] extends Seen
      ? Once<Rest, Seen, Out>
      : Once<Rest, Seen | H["name"], readonly [...Out, H]>
  : Out;

/**
 * The systems of a tuple in the order a tick runs them: stage by stage, as
 * listed. A hook and a system of the frame or input stage run at another
 * moment and are left out, and `loose` holds those whose stage the compiler
 * doesn't know.
 */
type Staged<
  T extends readonly Any[],
  Pre extends readonly Any[] = readonly [],
  Upd extends readonly Any[] = readonly [],
  Post extends readonly Any[] = readonly [],
  Loose = never,
> = T extends readonly [
  infer H extends Any,
  ...infer Rest extends readonly Any[],
]
  ? [H["trigger"]] extends [Trigger]
    ? Staged<Rest, Pre, Upd, Post, Loose>
    : [H["stage"]] extends ["preUpdate"]
      ? Staged<Rest, readonly [...Pre, H], Upd, Post, Loose>
      : [H["stage"]] extends ["update"]
        ? Staged<Rest, Pre, readonly [...Upd, H], Post, Loose>
        : [H["stage"]] extends ["postUpdate"]
          ? Staged<Rest, Pre, Upd, readonly [...Post, H], Loose>
          : [H["stage"]] extends [FrameStage | "input"]
            ? Staged<Rest, Pre, Upd, Post, Loose>
            : Staged<Rest, Pre, Upd, Post, Loose | H>
  : {
      readonly order: readonly [...Pre, ...Upd, ...Post];
      readonly loose: Loose;
    };

/** What is said of a system that watches what a later one writes or adds. */
type Late<
  N extends string,
  C extends string,
  By extends string,
  With extends string,
  How extends string,
> = `"${N}" watches "${C}" with ${With}, and "${By}" ${How} it later in the tick, so "${N}" would react a tick late. List "${N}" after "${By}", or place it in a later stage.`;

// A component that is written or gained fires `Query.changed`, and one that is
// gained alone fires `Query.added`.
type Clash<N extends string, Watched, Awaited, Later> = Later extends readonly [
  infer C extends string,
  infer By extends string,
  infer How extends string,
]
  ? | (C extends Watched ? Late<N, C, By, "Query.changed", How> : never)
    | (How extends "spawns or adds"
        ? C extends Awaited
          ? Late<N, C, By, "Query.added", How>
          : never
        : never)
  : never;

/** From the last system to the first, with what those after it write and add. */
type Behind<
  T extends readonly Any[],
  Later = never,
  Found = never,
> = T extends readonly [
  ...infer Init extends readonly Any[],
  infer Last extends Any,
]
  ? Last extends System<unknown, infer R, infer N>
    ? Behind<
        Init,
        Later | Wrote<R, N>,
        Found | Clash<N, WatchedBy<R>, AwaitedBy<R>, Later>
      >
    : never
  : Found;

type SameName<A extends string, B extends string> = string extends A
  ? false
  : [A] extends [B]
    ? [B] extends [A]
      ? true
      : false
    : false;

/** What is said of two systems whose order the compiler doesn't know. */
type Unknown<
  N extends string,
  C extends string,
  By extends string,
> = `One of "${N}" and "${By}" watches "${C}" and the other writes, spawns or adds it, and the compiler cannot tell which runs first. Give System.inStage a stage it can read.`;

/** What one system watches that the other writes or adds. */
type Between<R, R2> =
  | Extract<WatchedBy<R>, WrittenBy<R2> | AddedBy<R2>>
  | Extract<AwaitedBy<R>, AddedBy<R2>>;

/** A system whose place isn't known, against every other. */
type Unplaced<U, All> =
  U extends System<unknown, infer R, infer N>
    ? All extends System<unknown, infer R2, infer N2>
      ? SameName<N, N2> extends true
        ? never
        : Between<R, R2> | Between<R2, R> extends infer C
          ? C extends string
            ? Unknown<N, C, N2>
            : never
          : never
      : never
    : never;

/**
 * What is wrong with the order of a list of systems, as a union of messages, or
 * `never` when nothing is. `App.define` and `Plugin.make` refuse a list with
 * these messages, so the mistake doesn't compile.
 *
 * A system that watches a component reacts a tick late when it is listed ahead
 * of a system that changes the component in the same tick. With
 * `Query.changed` it watches for writes, spawns and adds, and with
 * `Query.added` for spawns and adds.
 *
 * What a system writes, adds and watches is in its requirements, from what it
 * yields: a query, `World.writes` and `Commands.spawns`. Nothing is declared
 * beside them. Hooks and systems of the frame and input stages run at another
 * moment, and are not checked against the tick's.
 *
 * **Gotchas**
 *
 * - A list that isn't written out as a tuple is refused, whatever it holds,
 *   since the compiler can't read its order.
 * - The compiler can't read the place of a system whose type allows more than
 *   one stage. Such a system is refused when another system of the list
 *   writes what it watches, or watches what it writes.
 *
 * @category Type-level
 */
export type Misordered<S extends readonly Any[]> = number extends S["length"]
  ? NotTuple
  : Staged<Once<S>> extends {
        readonly order: infer O extends readonly Any[];
        readonly loose: infer Loose;
      }
    ? Behind<O> | Unplaced<Loose, O[number] | Loose>
    : never;

/**
 * Two lists of systems, one after the other, as `Misordered` takes them.
 *
 * @category Type-level
 */
export type Listing<
  A extends readonly Any[],
  B extends readonly Any[],
> = readonly [...A, ...B];

type Dup<
  T extends readonly { readonly name: string }[],
  What extends string,
  Seen extends string = never,
  Found = never,
> = T extends readonly [
  infer H extends { readonly name: string },
  ...infer Rest extends readonly { readonly name: string }[],
]
  ? string extends H["name"]
    ? Dup<Rest, What, Seen, Found>
    : H["name"] extends Seen
      ? Dup<
          Rest,
          What,
          Seen,
          | Found
          | (What extends "system"
              ? `Duplicate system name "${H["name"]}". A system's name is its place in events and in what changed, so two cannot share one.`
              : What extends "handler"
                ? `Duplicate handler for "${H["name"]}". Two handlers cannot apply one action.`
                : `Two different plugins are both named "${H["name"]}".`)
        >
      : Dup<Rest, What, Seen | H["name"], Found>
  : Found;

/**
 * The duplicate names in a list, as a union of messages, or `never` when every
 * name is its own. `App.define` and `Plugin.make` refuse a list of systems, of
 * handlers or of plugins with a duplicate name, so the mistake doesn't
 * compile. A name the compiler only knows as `string` is left out, and a list
 * that isn't a tuple is refused, since the compiler can't read its names.
 *
 * @typeParam What what the list holds, `"system"`, `"handler"` or
 *   `"plugin"`, which picks the message
 *
 * @category Type-level
 */
export type Duplicated<
  T extends readonly { readonly name: string }[],
  What extends string = "system",
> = number extends T["length"] ? NotTuple : Dup<T, What>;

/**
 * What `App.define` and `Plugin.make` add to their options: nothing for a list
 * whose order works and whose names are each their own, and otherwise a
 * property nobody can give, whose type is the message.
 *
 * @category Type-level
 */
export type Ordered<S extends readonly Any[], Extra = never> = [
  Misordered<S> | Extra,
] extends [never]
  ? unknown
  : { readonly order: Misordered<S> | Extra };
