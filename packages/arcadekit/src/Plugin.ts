/**
 * Plugins: one value that bundles everything a feature needs.
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
 *   const app = yield* App.make({ plugins: [Combat, Audio] })
 *
 * A plugin that several others depend on is installed once: its systems are
 * registered once and its layer is built once.
 *
 * Actions are plain values, so a plugin does not list them: it exports them
 * from its module like anything else. It does list what loading a saved
 * game needs:
 *
 *   const Weather = Plugin.make("Weather", {
 *     components: [Cloud, Wind],          // so a save that names them can be read
 *     events: [Thundered],                // so one that was waiting can be read back
 *     scripts: [Storms],                  // started with the app, and again after a load
 *     setup: spawnTheFirstClouds          // a fresh start only: a load has them already
 *   })
 */
import type { Effect, Layer } from "effect";

import type * as Action from "./Action";
import type { ComponentDef } from "./ecs/component";
import type { EventDef } from "./Event";
import type { BuiltIn } from "./Services";
import type * as System from "./System";

export type AnySystem = System.System<any, any>;
export type AnyHandler = Action.Handler<any, any, any, any, any>;

/**
 * @param TickE    what the plugin's systems can fail with
 * @param Han      the plugin's action handlers (so `dispatch` can be typed)
 * @param Provided services its layer provides to the whole app
 * @param E        what building its layer or running its setup can fail with
 * @param RIn      what its layer needs that its declared dependencies do not provide
 * @param Needs    what its systems, handlers and setup need
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
  readonly layer: Layer.Layer<never, any, any> | undefined;
  readonly setup: Effect.Effect<void, any, any> | undefined;
  readonly components: readonly ComponentDef<any>[];
  readonly events: readonly EventDef<any>[];
  readonly scripts: readonly Effect.Effect<unknown, any, any>[];
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

export type Any = Plugin<any, any, any, any, any, any>;

// Distributive, so they work on a union of plugins and give `never` for none.
export type TickErrorOf<T> =
  T extends Plugin<infer X, any, any, any, any, any> ? X : never;
export type HandlerOf<T> =
  T extends Plugin<any, infer X, any, any, any, any> ? X : never;
export type ProvidedOf<T> =
  T extends Plugin<any, any, infer X, any, any, any> ? X : never;
export type ErrorOf<T> =
  T extends Plugin<any, any, any, infer X, any, any> ? X : never;
export type LayerNeedsOf<T> =
  T extends Plugin<any, any, any, any, infer X, any> ? X : never;
export type NeedsOf<T> =
  T extends Plugin<any, any, any, any, any, infer X> ? X : never;

type SystemError<T> = T extends System.System<infer E, any> ? E : never;
type SystemNeeds<T> = T extends System.System<any, infer R> ? R : never;
type HandlerNeeds<T> =
  T extends Action.Handler<any, any, any, any, infer R> ? R : never;
type LayerProvides<L> =
  L extends Layer.Layer<infer ROut, any, any> ? ROut : never;
type LayerError<L> = L extends Layer.Layer<any, infer E, any> ? E : never;
type LayerNeeds<L> = L extends Layer.Layer<any, any, infer RIn> ? RIn : never;
type EffectError<T> = T extends Effect.Effect<any, infer E, any> ? E : never;
type EffectNeeds<T> = T extends Effect.Effect<any, any, infer R> ? R : never;

export const make = <
  S extends readonly AnySystem[] = readonly [],
  H extends readonly AnyHandler[] = readonly [],
  L extends Layer.Layer<never, any, any> = Layer.Layer<never>,
  SU extends Effect.Effect<void, any, any> = Effect.Effect<void>,
  P extends readonly Any[] = readonly [],
  SC extends readonly Effect.Effect<unknown, any, any>[] = readonly [],
>(
  name: string,
  options: {
    /** Plugins this one depends on. They are installed first. */
    readonly plugins?: readonly [...P];
    readonly systems?: readonly [...S];
    readonly handlers?: readonly [...H];
    /**
     * Services for the whole app. While it builds it can use the built-in
     * services and anything the plugins listed above provide.
     */
    readonly layer?: L;
    /**
     * Runs once when a game starts afresh, after every plugin's layer is
     * built. For spawning the initial entities. Must not wait. It does not
     * run when the app is loaded from a save, which holds those entities.
     */
    readonly setup?: SU;
    /**
     * The components this plugin's feature stores. A world knows a component
     * by its name, so loading a save needs every component the save names
     * to be listed by some plugin, or by the app.
     */
    readonly components?: readonly ComponentDef<any>[];
    /**
     * The events this plugin's feature emits. An app knows an event by its
     * name, so a game can only be saved while one is waiting to be read,
     * and that save loaded, if the event is listed by some plugin, or by
     * the app. Listed events also keep their order from one run to the
     * next: scripts waiting on them are woken in the order they are listed.
     */
    readonly events?: readonly EventDef<any>[];
    /**
     * Long-running scripts, started when the app starts: after `setup` on a
     * fresh start, and again from their beginning when the app is loaded
     * from a save. A save cannot hold a script in mid-flight, so a script
     * listed here keeps what it must not lose in the world, and picks up
     * from what it finds there.
     */
    readonly scripts?: readonly [...SC];
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
  | EffectNeeds<SC[number]>
  | NeedsOf<P[number]>
> => ({
  name,
  systems: options.systems ?? [],
  handlers: options.handlers ?? [],
  layer: options.layer,
  setup: options.setup,
  components: options.components ?? [],
  events: options.events ?? [],
  scripts: options.scripts ?? [],
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
