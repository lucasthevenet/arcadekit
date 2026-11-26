/**
 * Plugins bundle everything a feature needs into a single value: its systems,
 * its action handlers, the services it provides, and what it spawns when a
 * game starts.
 *
 *   const Physics = Plugin.make("physics/Physics", {
 *     systems: [Movement, Collision, Draw],
 *     layer: RendererLive,                // services its frame systems use
 *     setup: spawnWalls                    // runs when a game starts fresh
 *   })
 *
 *   const Combat = Plugin.make("combat/Combat", {
 *     plugins: [Physics],                  // dependencies come first
 *     systems: [Damage],
 *     handlers: [strike]
 *   })
 *
 *   const app = yield* App.make(App.define({ plugins: [Combat, Audio] }))
 *
 * A plugin that several others depend on is installed once. Its systems are
 * registered once, and its layer is built once.
 *
 * Components, events and actions are plain values, which a plugin's module
 * exports like anything else. A save finds its components and events by
 * their names, so a plugin doesn't list them. What a plugin spawns when a
 * game starts fresh is its `setup`. Loading a save doesn't run it, since the
 * save already holds what it spawned.
 */
import type { Effect, Layer } from "effect";

import type * as Action from "./Action.ts";
import type { BuiltIn, Sim } from "./Services.ts";
import type * as System from "./System.ts";

/**
 * Any system, whatever its error and requirements.
 *
 * @category Type-level
 */
export type AnySystem = System.System<unknown, unknown>;
/**
 * Any action handler, whatever its action, result and requirements.
 *
 * @category Type-level
 */
export type AnyHandler = Action.AnyHandler;

/**
 * A plugin, as `Plugin.make` returns it and `App.make` installs it.
 *
 * @typeParam TickE    what the plugin's systems can fail with
 * @typeParam Han      the plugin's action handlers, from which `dispatch` is typed
 * @typeParam Provided services its layer provides to the whole app, and its
 *   `Plugin.Installed`
 * @typeParam E        what building its layer or running its setup can fail with
 * @typeParam RIn      what its layer requires that its dependencies don't provide
 * @typeParam Needs    what its systems, handlers and setup require
 * @typeParam Sys      its systems, dependencies first, in the order a tick runs them
 * @typeParam Id       its name
 * @typeParam Deps     the plugins it depends on
 * @typeParam Own      its own systems, not its dependencies'
 * @typeParam Hands    its own handlers
 *
 * @category Models
 */
export interface Plugin<
  out TickE = never,
  out Han = never,
  out Provided = never,
  out E = never,
  out RIn = never,
  out Needs = never,
  out Sys extends readonly AnySystem[] = readonly AnySystem[],
  out Id extends string = string,
  out Deps extends readonly Any[] = readonly Any[],
  out Own extends readonly AnySystem[] = readonly AnySystem[],
  out Hands extends readonly AnyHandler[] = readonly AnyHandler[],
> {
  readonly name: Id;
  readonly systems: readonly AnySystem[];
  readonly handlers: readonly AnyHandler[];
  readonly layer: Layer.Layer<never, unknown, unknown> | undefined;
  readonly setup: Effect.Effect<void, unknown, unknown> | undefined;
  /** The plugins this one depends on. */
  readonly plugins: readonly Any[];
  /** Holds no value. It carries the plugin's types. */
  readonly _types?: {
    readonly TickE: TickE;
    readonly Han: Han;
    readonly Provided: Provided;
    readonly E: E;
    readonly RIn: RIn;
    readonly Needs: Needs;
    readonly Sys: Sys;
    readonly Id: Id;
    readonly Deps: Deps;
    readonly Own: Own;
    readonly Hands: Hands;
  };
}

/**
 * Any plugin, whatever its types.
 *
 * @category Type-level
 */
export type Any = Plugin<unknown, unknown, unknown, unknown, unknown, unknown>;

/**
 * What a game requires where its code uses what only the plugin named `Id`
 * acts on: that the plugin is among the game's plugins. Every plugin
 * provides its own, by the name `Plugin.make` was given, so a game that
 * leaves the plugin out doesn't compile: `App.make` requires it from
 * outside, as `Installed<"arcadekit/Timer">`. It stands for nothing at run
 * time.
 *
 * @category Type-level
 */
export interface Installed<out Id extends string> {
  readonly "~arcadekit/Plugin.Installed": Id;
}

/**
 * The mark of a component that only the plugin named `Id` acts on, as
 * `Timer.Lifetime` is one that only `Timer.plugin` counts down. Naming the
 * component in `Commands.spawns` requires `Plugin.Installed<Id>`, so a game
 * that spawns or adds it and leaves the plugin out doesn't compile.
 *
 *   const Def = Component.define("physics/Velocity", { x: Field.f32 })
 *   export const Velocity: typeof Def & Plugin.KeptBy<"physics/Physics"> = Def
 *
 * **Gotchas**
 *
 * - A component that `requires` a marked one is not marked itself: a game
 *   that spawns it alone compiles without the plugin.
 *
 * @category Type-level
 */
export interface KeptBy<out Id extends string> {
  /** Holds no value. It carries the plugin's name. */
  readonly "~arcadekit/Plugin.KeptBy"?: readonly [Id];
}

// Distributive, so they work on a union of plugins and give `never` for none.
/**
 * The error a plugin's systems can fail with, or a union's.
 *
 * @category Type-level
 */
export type TickErrorOf<T> =
  T extends Plugin<infer X, unknown, unknown, unknown, unknown, unknown>
    ? X
    : never;
/**
 * A plugin's action handlers, or a union's.
 *
 * @category Type-level
 */
export type HandlerOf<T> =
  T extends Plugin<unknown, infer X, unknown, unknown, unknown, unknown>
    ? X
    : never;
/**
 * The services a plugin's layer provides and its `Plugin.Installed`, or a
 * union's.
 *
 * @category Type-level
 */
export type ProvidedOf<T> =
  T extends Plugin<unknown, unknown, infer X, unknown, unknown, unknown>
    ? X
    : never;
/**
 * The error that building a plugin's layer or running its setup can fail with.
 *
 * @category Type-level
 */
export type ErrorOf<T> =
  T extends Plugin<unknown, unknown, unknown, infer X, unknown, unknown>
    ? X
    : never;
/**
 * What a plugin's layer requires that its dependencies don't provide.
 *
 * @category Type-level
 */
export type LayerNeedsOf<T> =
  T extends Plugin<unknown, unknown, unknown, unknown, infer X, unknown>
    ? X
    : never;
/**
 * What a plugin's systems, handlers and setup require.
 *
 * @category Type-level
 */
export type NeedsOf<T> =
  T extends Plugin<unknown, unknown, unknown, unknown, unknown, infer X>
    ? X
    : never;

/**
 * The systems of a list of plugins, in the order an app runs them, with each
 * plugin's dependencies ahead of its own, as far as the compiler knows them.
 * `System.Misordered` checks this list.
 *
 * @category Type-level
 */
export type SystemsOf<
  P extends readonly Any[],
  Out extends readonly AnySystem[] = readonly [],
> = P extends readonly [
  infer H extends Any,
  ...infer Rest extends readonly Any[],
]
  ? SystemsOf<Rest, System.Listing<Out, Sys<H>>>
  : Out;

type Sys<T> =
  T extends Plugin<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    infer X extends readonly AnySystem[]
  >
    ? X
    : never;

type SystemError<T> = T extends System.System<infer E, unknown> ? E : never;
type SystemNeeds<T> = T extends System.System<unknown, infer R> ? R : never;
type HandlerNeeds<T> =
  T extends Action.Handler<string, infer _P, unknown, unknown, infer R>
    ? R
    : never;
type LayerProvides<L> =
  L extends Layer.Layer<infer ROut, unknown, unknown> ? ROut : never;
type LayerError<L> = L extends Layer.Layer<never, infer E, unknown> ? E : never;
type LayerNeeds<L> =
  L extends Layer.Layer<never, unknown, infer RIn> ? RIn : never;
type EffectError<T> =
  T extends Effect.Effect<unknown, infer E, unknown> ? E : never;
type EffectNeeds<T> =
  T extends Effect.Effect<unknown, unknown, infer R> ? R : never;

type NameOf<T> = T extends { readonly name: infer N extends string }
  ? N
  : string;
type InstalledIfLiteral<Id extends string> = string extends Id
  ? never
  : Installed<Id>;
type OwnOf<T> =
  T extends Plugin<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    readonly AnySystem[],
    string,
    readonly Any[],
    infer Own extends readonly AnySystem[]
  >
    ? Own
    : readonly [];
type DepsOf<T> =
  T extends Plugin<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    readonly AnySystem[],
    string,
    infer Deps extends readonly Any[]
  >
    ? Deps
    : readonly [];
type HandsOf<T> =
  T extends Plugin<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    readonly AnySystem[],
    string,
    readonly Any[],
    readonly AnySystem[],
    infer Hands extends readonly AnyHandler[]
  >
    ? Hands
    : readonly [];

type Walk<
  P extends readonly Any[],
  Seen extends string,
  Out extends readonly AnySystem[],
> = P extends readonly [infer H, ...infer Rest extends readonly Any[]]
  ? string extends NameOf<H>
    ? Walk<Rest, Seen, readonly [...Out, ...OwnOf<H>]>
    : NameOf<H> extends Seen
      ? Walk<Rest, Seen, Out>
      : Walk<Rest, Seen | NameOf<H>, readonly [...Out, ...OwnOf<H>]>
  : readonly [Seen, Out];

type WalkHands<
  P extends readonly Any[],
  Seen extends string,
  Out extends readonly AnyHandler[],
> = P extends readonly [infer H, ...infer Rest extends readonly Any[]]
  ? string extends NameOf<H>
    ? WalkHands<Rest, Seen, readonly [...Out, ...HandsOf<H>]>
    : NameOf<H> extends Seen
      ? WalkHands<Rest, Seen, Out>
      : WalkHands<Rest, Seen | NameOf<H>, readonly [...Out, ...HandsOf<H>]>
  : readonly [Seen, Out];

type NamedOf<H extends readonly AnyHandler[]> = {
  readonly [K in keyof H]: {
    readonly name: H[K] extends {
      readonly action: { readonly name: infer N extends string };
    }
      ? N
      : string;
  };
};

type PluginNames<P extends readonly Any[]> = {
  readonly [K in keyof P]: { readonly name: NameOf<P[K]> };
};

/** Duplicate names of plugins in one list, and in each dependency list. */
type PluginClashes<P extends readonly Any[]> =
  | System.Duplicated<PluginNames<P>, "plugin">
  | (P extends readonly [infer H, ...infer Rest extends readonly Any[]]
      ? PluginClashes<DepsOf<H>> | PluginClashes<Rest>
      : never);

type Gathered<P extends readonly Any[]> = Walk<P, never, readonly []>[1];
type GatheredHands<P extends readonly Any[]> = WalkHands<
  P,
  never,
  readonly []
>[1];

/** Whether one of a list is typed `any`. */
type AnyIn<P extends readonly unknown[]> = true extends {
  [K in keyof P]: 0 extends 1 & P[K] ? true : false;
}[number]
  ? true
  : false;

/**
 * What `App.define` and `Plugin.make` ask of their list of plugins: nothing,
 * unless one of them is typed `any`, as a plugin whose import failed is. The
 * compiler can read nothing of such a plugin, its systems' order, its names
 * or what it needs, so the list doesn't compile, and the error says which.
 *
 * @category Type-level
 */
export type Typed<P extends readonly unknown[]> =
  AnyIn<P> extends true
    ? {
        readonly "A plugin of this list is typed any, as a plugin whose import failed is, so the compiler can check nothing of it: fix its import, or give it its type": P;
      }
    : unknown;

/**
 * What `App.define` and `Plugin.make` check of a list of systems: their order
 * and their names, unless a plugin is typed `any`, which `Plugin.Typed` says
 * alone, since nothing else of the list can be read.
 *
 * @category Type-level
 */
export type Checked<
  P extends readonly Any[],
  S extends readonly AnySystem[],
  H extends readonly AnyHandler[],
> =
  AnyIn<P> extends true
    ? unknown
    : System.Ordered<System.Listing<SystemsOf<P>, S>, Clashes<P, H, S>>;

/**
 * Duplicate system, handler and plugin names reachable from `plugins`, plus
 * the caller's own systems and handlers. A shared dependency is counted once.
 *
 * @category Type-level
 */
export type Clashes<
  P extends readonly Any[],
  H extends readonly AnyHandler[],
  S extends readonly AnySystem[],
> =
  | PluginClashes<P>
  | System.Duplicated<readonly [...Gathered<P>, ...S]>
  | System.Duplicated<NamedOf<readonly [...GatheredHands<P>, ...H]>, "handler">;

/**
 * Makes a plugin: a feature of a game, with the plugins it depends on, its
 * systems and action handlers, the services its layer provides, and what it
 * does at startup.
 *
 *   const Combat = Plugin.make("game/Combat", {
 *     plugins: [Physics],
 *     systems: [ApplyDamage, Die],
 *     handlers: [Attack],
 *   })
 *
 * **Details**
 *
 * - A plugin that two others depend on is installed once. Two different
 *   plugins with the same name are refused when the app is made.
 * - If a layer or a setup fails, `App.make` fails with that error.
 * - Its systems run in the order they are listed, after those of the plugins
 *   it depends on. A list in which a system watches a component ahead of one
 *   that writes it doesn't compile. See `System.Misordered`.
 *
 * @category Constructors
 */
export const make = <
  const Id extends string,
  S extends readonly AnySystem[] = readonly [],
  H extends readonly AnyHandler[] = readonly [],
  L extends Layer.Layer<never, unknown, unknown> = Layer.Layer<never>,
  SU extends Effect.Effect<void, unknown, unknown> = Effect.Effect<void>,
  P extends readonly Any[] = readonly [],
>(
  name: Id,
  options: {
    /** The plugins this one depends on, installed first. */
    readonly plugins?: readonly [...P] & Typed<P>;
    readonly systems?: readonly [...S];
    readonly handlers?: readonly [...H];
    /**
     * Services for the whole app, which its frame and input systems require.
     * The code of the tick requires only the built-in services and
     * resources, since what a service keeps is no part of the world. While
     * the layer builds, it can read the built-in services and use whatever
     * the plugins in `plugins` provide. It is built again when a save is
     * loaded, so commands, `World.writes` and a query that writes don't
     * compile here: spawn in `setup`. What it acquires is released when the
     * app is closed.
     */
    readonly layer?: System.LayerGated<L>;
    /**
     * Runs once when a game starts fresh, after every plugin's layer is
     * built, to spawn the initial entities. It must not wait or leave a fiber
     * running when it ends, or `App.make` dies. It doesn't run when the app
     * is loaded from a save, which already holds those entities. It runs as a
     * system of the tick does, so real time, `Frame`, sound, a view and the
     * devices don't compile here.
     */
    readonly setup?: System.TickEffect<SU>;
  } & Checked<P, S, H>
): Plugin<
  SystemError<S[number]> | TickErrorOf<P[number]>,
  H[number] | HandlerOf<P[number]>,
  LayerProvides<L> | ProvidedOf<P[number]> | InstalledIfLiteral<Id>,
  LayerError<L> | EffectError<SU> | ErrorOf<P[number]>,
  | Exclude<LayerNeeds<L>, ProvidedOf<P[number]> | BuiltIn>
  | LayerNeedsOf<P[number]>,
  | SystemNeeds<S[number]>
  | HandlerNeeds<H[number]>
  | Exclude<EffectNeeds<SU>, Sim>
  | NeedsOf<P[number]>,
  System.Listing<SystemsOf<P>, S>,
  Id,
  P,
  S,
  H
> => ({
  name,
  systems: options.systems ?? [],
  handlers: options.handlers ?? [],
  layer: options.layer,
  setup: options.setup as Effect.Effect<void, unknown, unknown> | undefined,
  plugins: options.plugins ?? [],
});
