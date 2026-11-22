/**
 * Plugins bundle everything a feature needs into a single value.
 *
 *   const Physics = Plugin.make("Physics", {
 *     systems: [Movement, Collision],
 *     layer: SpatialIndexLive,            // services its systems use
 *     setup: spawnWalls                    // runs once when the app starts
 *   })
 *
 *   const Combat = Plugin.make("Combat", {
 *     plugins: [Physics],                  // dependencies come first
 *     systems: [Damage],
 *     handlers: [strike]
 *   })
 *
 *   const app = yield* App.make(App.define({ plugins: [Combat, Audio] }))
 *
 * A plugin that several others depend on is installed once: its systems are
 * registered once and its layer is built once.
 *
 * Components, events and actions are plain values, which a plugin's module
 * exports like anything else. A save finds its components and events by their
 * names, so a plugin doesn't list them. What it spawns when a game starts
 * fresh is its `setup`, which a load doesn't run, since the save already holds
 * what it spawned:
 *
 *   const Weather = Plugin.make("Weather", {
 *     setup: spawnTheFirstClouds
 *   })
 */
import type { Effect, Layer } from "effect";

import type * as Action from "./Action";
import type { BuiltIn } from "./Services";
import type * as System from "./System";

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
 * @param TickE    what the plugin's systems can fail with
 * @param Han      the plugin's action handlers (so `dispatch` can be typed)
 * @param Provided services its layer provides to the whole app
 * @param E        what building its layer or running its setup can fail with
 * @param RIn      what its layer requires that its dependencies don't provide
 * @param Needs    what its systems, handlers and setup require
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
> {
  readonly name: string;
  readonly systems: readonly AnySystem[];
  readonly handlers: readonly AnyHandler[];
  readonly layer: Layer.Layer<never, unknown, unknown> | undefined;
  readonly setup: Effect.Effect<void, unknown, unknown> | undefined;
  /** The plugins this one depends on. */
  readonly plugins: readonly Any[];
  /** Type-only. */
  readonly _types?: {
    readonly TickE: TickE;
    readonly Han: Han;
    readonly Provided: Provided;
    readonly E: E;
    readonly RIn: RIn;
    readonly Needs: Needs;
  };
}

/**
 * Any plugin, whatever its types.
 *
 * @category Type-level
 */
export type Any = Plugin<unknown, unknown, unknown, unknown, unknown, unknown>;

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
 * The services a plugin's layer provides, or a union's.
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
 * A plugin that two others depend on is installed once. Two different plugins
 * with the same name are refused when the app is created. If a layer or a setup
 * fails, `App.make` fails with that error.
 *
 * @category Constructors
 */
export const make = <
  S extends readonly AnySystem[] = readonly [],
  H extends readonly AnyHandler[] = readonly [],
  L extends Layer.Layer<never, unknown, unknown> = Layer.Layer<never>,
  SU extends Effect.Effect<void, unknown, unknown> = Effect.Effect<void>,
  P extends readonly Any[] = readonly [],
>(
  name: string,
  options: {
    /** The plugins this one depends on, installed first. */
    readonly plugins?: readonly [...P];
    readonly systems?: readonly [...S];
    readonly handlers?: readonly [...H];
    /**
     * Services for the whole app. While it builds, it can use the built-in
     * services and anything the plugins listed above provide. What it acquires
     * is released when the app's scope closes.
     */
    readonly layer?: L;
    /**
     * Runs once when a game starts fresh, after every plugin's layer is built,
     * to spawn the initial entities. It must not wait, nor leave a fiber running
     * when it ends: `App.make` dies if it does. It doesn't run when the
     * app is loaded from a save, which already holds those entities.
     */
    readonly setup?: SU;
  }
): Plugin<
  SystemError<S[number]> | TickErrorOf<P[number]>,
  H[number] | HandlerOf<P[number]>,
  LayerProvides<L> | ProvidedOf<P[number]>,
  LayerError<L> | EffectError<SU> | ErrorOf<P[number]>,
  | Exclude<LayerNeeds<L>, ProvidedOf<P[number]> | BuiltIn>
  | LayerNeedsOf<P[number]>,
  | SystemNeeds<S[number]>
  | HandlerNeeds<H[number]>
  | EffectNeeds<SU>
  | NeedsOf<P[number]>
> => ({
  name,
  systems: options.systems ?? [],
  handlers: options.handlers ?? [],
  layer: options.layer,
  setup: options.setup,
  plugins: options.plugins ?? [],
});

/**
 * Every plugin reachable from `plugins`, each once, dependencies before the
 * plugins that need them.
 * @internal
 */
export const flatten = (plugins: readonly Any[]): Any[] => {
  const out: Any[] = [];
  const seen = new Set<Any>();
  const names = new Map<string, Any>();
  const visit = (plugin: Any): void => {
    if (seen.has(plugin)) {
      return;
    }
    seen.add(plugin);
    const other = names.get(plugin.name);
    if (other !== undefined) {
      throw new Error(`Two different plugins are both named "${plugin.name}"`);
    }
    names.set(plugin.name, plugin);
    for (const dependency of plugin.plugins) {
      visit(dependency);
    }
    out.push(plugin);
  };
  for (const plugin of plugins) {
    visit(plugin);
  }
  return out;
};
