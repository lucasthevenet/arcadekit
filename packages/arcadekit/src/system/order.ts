import type { Access, Adds, Watches, WatchesAdded, Writes } from "../Query";
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

/** The systems of a union that write or watch something. */
type Touching<U> =
  U extends System<unknown, infer R>
    ? [Extract<R, Access>] extends [never]
      ? never
      : U
    : never;

/** The systems of a union that the tick runs in the order of the list. */
type Ticking<U> = U extends Any
  ? [U["trigger"]] extends [Trigger]
    ? never
    : [U["stage"]] extends [FrameStage | "input"]
      ? never
      : U
  : never;

/**
 * A list whose order the compiler knows, or one that says nothing of order:
 * a list that isn't a tuple is left out when none of its systems writes or
 * watches anything, and is otherwise kept as it is, in no order.
 */
type Listed<S extends readonly Any[]> = number extends S["length"]
  ? [Touching<S[number]>] extends [never]
    ? readonly []
    : S
  : S;

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
> = `One of "${N}" and "${By}" watches "${C}" and the other writes, spawns or adds it, and the compiler cannot tell which runs first. Write the list of systems out where it is given, and give System.inStage a stage it can read.`;

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
 * What is wrong with the order of a list of systems, as a union of messages,
 * and `never` when nothing is: a system that watches a component with
 * `Query.changed` or `Query.added`, listed ahead of one that writes it, spawns
 * it or adds it in the same tick, sees that a tick late. `App.define` and `Plugin.make` refuse such a list
 * with this message, so the mistake doesn't compile.
 *
 * What a system writes, adds and watches is in its requirements, from what it
 * yields: a query, `World.writes` and `Commands.spawns`. Nothing is declared
 * beside them. Hooks and systems of the frame and input stages
 * run at another moment, and are not checked against the tick's.
 *
 * @category Type-level
 */
export type Misordered<S extends readonly Any[]> =
  Listed<S> extends infer L extends readonly Any[]
    ? number extends L["length"]
      ? Unplaced<Ticking<L[number]>, Ticking<L[number]>>
      : Staged<Once<L>> extends {
            readonly order: infer O extends readonly Any[];
            readonly loose: infer Loose;
          }
        ? Behind<O> | Unplaced<Loose, O[number] | Loose>
        : never
    : never;

/**
 * Two lists of systems, one after the other, as `Misordered` takes them: a
 * list that isn't a tuple and whose systems write and watch nothing is left
 * out.
 *
 * @internal
 */
export type Listing<
  A extends readonly Any[],
  B extends readonly Any[],
> = readonly [...Listed<A>, ...Listed<B>];

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
 * The duplicate names in a list, as a union of messages, and `never` when
 * every name is its own. A name the compiler only knows as `string` is left
 * out. `App.define` and `Plugin.make` refuse the list with `System.Ordered`.
 *
 * @category Type-level
 */
export type Duplicated<
  T extends readonly { readonly name: string }[],
  What extends string = "system",
> = number extends T["length"] ? never : Dup<T, What>;

/**
 * What `App.define` and `Plugin.make` add to their options: nothing for a list
 * whose order works and whose names are each their own, and otherwise a
 * property nobody can give, whose type is the message.
 *
 * @internal
 */
export type Ordered<S extends readonly Any[], Extra = never> = [
  Misordered<S> | Extra,
] extends [never]
  ? unknown
  : { readonly order: Misordered<S> | Extra };

/**
 * The level of the spans an app makes, as a program's
 * `Tracer.MinimumTraceLevel` sees them.
 * @internal
 */
