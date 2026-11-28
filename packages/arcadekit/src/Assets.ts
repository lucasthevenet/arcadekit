/**
 * Assets are the files a game loads to be drawn and heard. Loading is scoped,
 * and loaded assets are released when the scope they were loaded in closes.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     backdrop: Browser.image("/forest.png"),    // from "arcadekit/browser"
 *     layout: Assets.json("/forest.json", Layout),
 *   })
 *
 * Anywhere there is a scope:
 *
 *   const { backdrop, layout } = yield* Assets.load(Forest)
 *
 * For a level, the scope is the level's. `Assets.during` loads a bundle while a
 * condition holds, such as a state of the game, and releases it when the
 * condition no longer holds:
 *
 *   const Game = Plugin.make("Game", {
 *     plugins: [Assets.plugin],
 *     systems: [Assets.during(Forest).pipe(System.runIf(State.is(Level, "forest"))), Draw],
 *   })
 *
 *   const Draw = System.frame("Draw", function*() {
 *     const forest = yield* Assets.Status(Forest)               // the bundle's current status
 *     if (forest._tag === "Ready") draw(forest.assets.backdrop)
 *   })
 *
 * Loading takes real time, so it isn't part of the simulation. Nothing in a
 * tick waits for an asset or can tell whether one is loaded. What the game
 * itself needs from a file, such as where the walls are, enters as an action.
 * `Assets.onReady` issues it once the bundle is loaded, the world records
 * what it was handed, and the log holds it from then on. A game whose levels are files gives them a
 * bundle each with `Assets.family`.
 */
import {
  Cause,
  Context,
  Data,
  Effect,
  Random as EffectRandom,
  Exit,
  Fiber,
  Layer,
  RcMap,
  Schedule,
  Schema,
  Scope,
} from "effect";

import * as Action from "./Action.ts";
import * as Event from "./Event.ts";
import * as Field from "./Field.ts";
import * as Input from "./Input.ts";
import { fetching } from "./internal/fetching.ts";
import { lookup, service } from "./internal/lookup.ts";
import type { Given } from "./internal/lookup.ts";
import { make as makeSystem } from "./internal/system.ts";
import * as Plugin from "./Plugin.ts";
import {
  Commands,
  Events,
  Frame,
  Random,
  Sim,
  Time,
  World,
} from "./Services.ts";
import * as Singleton from "./Singleton.ts";
import * as System from "./System.ts";

/**
 * An asset couldn't be loaded, because it is missing or isn't what it claimed
 * to be.
 *
 * @category Errors
 */
export class Failed extends Data.TaggedError("AssetsFailed")<{
  /** The URL the asset was loaded from. */
  readonly url: string;
  /** What went wrong. */
  readonly message: string;
  /**
   * Fetching it again may succeed: the request got no answer, its download
   * was cut off, or the server answered with an error of its own, a status of
   * 500 or more.
   */
  readonly transient?: boolean;
}> {}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

// --- one asset ---------------------------------------------------------------

/**
 * Something to load: where its bytes are, and how to decode them.
 *
 * @category Models
 */
export interface Asset<out A> {
  /** Where its bytes are. */
  readonly url: string;
  /**
   * Decodes the asset from its bytes, in the scope it is loaded in. Anything
   * that must be released is released when that scope closes.
   */
  readonly decode: (bytes: Uint8Array) => Effect.Effect<A, Failed, Scope.Scope>;
}

/**
 * Makes an asset of a custom type. `decode` builds it from its bytes. Use
 * `Effect.acquireRelease` when what it builds must be released.
 *
 *   const sound = (url: string) => Assets.make(url, (bytes, at) =>
 *     Effect.acquireRelease(decodeAudio(bytes, at), (buffer) => free(buffer))
 *   )
 *
 * @category Constructors
 */
export const make = <A>(
  url: string,
  decode: (
    bytes: Uint8Array,
    url: string
  ) => Effect.Effect<A, Failed, Scope.Scope>
): Asset<A> => ({ url, decode: (bytes) => decode(bytes, url) });

/**
 * Makes an asset of a file's raw bytes.
 *
 * @category Constructors
 */
export const bytes = (url: string): Asset<Uint8Array> =>
  make(url, (data) => Effect.succeed(data));

/**
 * Makes an asset of a UTF-8 text file.
 *
 * @category Constructors
 */
export const text = (url: string): Asset<string> =>
  make(url, (data, at) =>
    Effect.suspend(() => {
      try {
        return Effect.succeed(
          new TextDecoder("utf-8", { fatal: true }).decode(data)
        );
      } catch (error) {
        return Effect.fail(
          new Failed({
            url: at,
            message: `It is not text: ${describe(error)}`,
          })
        );
      }
    })
  );

/**
 * Makes an asset of a JSON file that a schema describes. The file comes from
 * outside the program, so it is validated, and a file that doesn't match
 * fails to load with `Assets.Failed`.
 *
 * @category Constructors
 */
export const json = <S extends Schema.Codec<unknown, unknown>>(
  url: string,
  schema: S
): Asset<S["Type"]> => {
  const decode = Schema.decodeUnknownExit(Schema.toCodecJson(schema));
  return make(url, (data, at) =>
    Effect.suspend(() => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(data));
      } catch (error) {
        return Effect.fail(
          new Failed({
            url: at,
            message: `It is not JSON: ${describe(error)}`,
          })
        );
      }
      const exit = decode(parsed);
      return Exit.isSuccess(exit)
        ? Effect.succeed(exit.value as S["Type"])
        : Effect.fail(
            new Failed({
              url: at,
              message: describe(Cause.squash(exit.cause)),
            })
          );
    })
  );
};

// --- where bytes come from ---------------------------------------------------------

/**
 * Fetches an asset's bytes. In a page it uses Effect's `HttpClient`, over
 * `fetch`. A test provides one that reads from memory.
 *
 * @category Services
 */
export interface LoaderShape {
  /** Returns the bytes at a URL. Interrupting it cancels the request. */
  readonly bytes: (url: string) => Effect.Effect<Uint8Array, Failed>;
}

/**
 * Where asset bytes come from. Nothing has to provide it. The default is
 * Effect's `HttpClient` over `fetch`, available in pages and Node alike, which
 * reads a path against the page's address. `Browser.layer` reads a path
 * against the document's base instead, as `fetch` does. A test provides its
 * own files with `Assets.layer(Assets.makeMemory(files))`.
 *
 * @category Services
 */
export const Loader: Context.Reference<LoaderShape> =
  Context.Reference<LoaderShape>("arcadekit/Assets.Loader", {
    defaultValue: () => fetching,
  });

/**
 * Returns a layer that provides a loader, such as `Assets.makeMemory(files)`
 * in a test, as `Assets.Loader`.
 *
 * @category Layers
 */
export const layer = (loader: LoaderShape): Layer.Layer<never> =>
  Layer.succeed(Loader, loader);

/**
 * Makes a loader of in-memory files by URL, for a test or a tool. A file given
 * as text is encoded as UTF-8. A URL not in the list fails.
 *
 *   Effect.provide(Assets.layer(Assets.makeMemory({ "/level.json": "{}" })))
 *
 * @category Testing
 */
export const makeMemory = (
  files: Readonly<Record<string, Uint8Array | string>>
): LoaderShape => ({
  bytes: (url) =>
    Effect.suspend(() => {
      const file = Object.hasOwn(files, url) ? files[url] : undefined;
      if (file === undefined) {
        return Effect.fail(
          new Failed({ url, message: "There is no such file." })
        );
      }
      return Effect.succeed(
        typeof file === "string" ? new TextEncoder().encode(file) : file
      );
    }),
});

// --- a bundle: what is loaded, and let go, together -----------------------------------

// An asset is of whatever its `decode` makes, and a bundle holds assets of
// several kinds.
type Entries = Readonly<Record<string, Asset<unknown>>>;

/**
 * A loaded bundle: each asset under its name.
 *
 * @category Type-level
 */
export type Loaded<B extends Entries> = {
  readonly [K in keyof B]: B[K] extends Asset<infer A> ? A : never;
};

/**
 * A bundle's current status in an app.
 *
 * @category Models
 */
export type Status<A> = Data.TaggedEnum<{
  /** No one holds it. */
  Absent: {};
  /** It is loading. */
  Loading: {};
  /** It is loaded, and `assets` holds each asset under its name. */
  Ready: { readonly assets: A };
  /**
   * It couldn't be loaded, which is logged once. Nothing that did load is
   * kept. It is loaded again when it is next held after every holder has
   * dropped it.
   */
  Failed: { readonly error: Failed };
}>;

interface StatusOf extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Status<this["A"]>;
}

const Statuses = Data.taggedEnum<StatusOf>();

/**
 * What `Assets.match` does with each status of a bundle: a function for each
 * `_tag`, given the status of that tag.
 *
 * @category Type-level
 */
export type StatusCases<A, R> = {
  readonly [K in Status<A>["_tag"]]: (
    status: Extract<Status<A>, { readonly _tag: K }>
  ) => R;
};

/**
 * Returns what the case of a bundle's status returns, one function for each
 * of the four:
 *
 *   const label = Assets.match(yield* Assets.Status(Forest), {
 *     Absent: () => "",
 *     Loading: () => "Loading",
 *     Ready: ({ assets }) => assets.title.text,
 *     Failed: ({ error }) => error.message,
 *   })
 *
 * A status that a later version adds is a case that doesn't compile until it
 * is given.
 *
 * @category Utilities
 */
export const match: {
  <A, R>(cases: StatusCases<A, R>): (status: Status<A>) => R;
  <A, R>(status: Status<A>, cases: StatusCases<A, R>): R;
} = Statuses.$match;

const ABSENT = Statuses.Absent();
const LOADING = Statuses.Loading();

/**
 * Assets that are loaded and released together, such as a level's or a menu's.
 * In a frame-stage or input-stage system, `yield* Assets.Status(bundle)`
 * returns its current status in the app.
 *
 * @category Models
 */
export class Bundle<B extends Entries> {
  constructor(
    readonly name: string,
    readonly assets: B
  ) {}
}

const statusOf = <B extends Entries>(
  given: Given,
  bundle: Bundle<B>
): Status<Loaded<B>> => service(given, Store).status(bundle);

/**
 * Asks for a bundle's current status in the app. A frame-stage or an
 * input-stage system can ask.
 *
 *   const label = Assets.match(yield* Assets.Status(Forest), { ... })
 *
 * @category Capabilities
 */
export const Status = <B extends Entries>(
  bundle: Bundle<B>
): Effect.Effect<Status<Loaded<B>>, never, Store> => lookup(statusOf, bundle);

/**
 * Groups assets that belong together. The name identifies the bundle in the
 * error logged when it fails to load, and names the system that
 * `Assets.during` makes for it, so prefix it with the feature it belongs to.
 *
 * @category Constructors
 */
export const bundle = <B extends Entries>(name: string, assets: B): Bundle<B> =>
  new Bundle(name, assets);

/**
 * What names one bundle of a family: a level's number, or its name.
 *
 * @category Models
 */
export type Key = string | number;

/**
 * A bundle for each key, such as a level's files for each level's number.
 * `Assets.family` makes one.
 *
 * @typeParam K the keys, such as `number`
 * @typeParam B the assets of each bundle, under their names
 *
 * @category Models
 */
export interface Family<K extends Key, B extends Entries> {
  /** Its name, which each bundle's name starts with: `"game/Level(3)"` for key 3. */
  readonly name: string;
  /** Returns the bundle of a key, the same bundle each time it is given the same key. */
  of(key: K): Bundle<B>;
  /** The bundles it has made so far, by key. */
  readonly made: ReadonlyMap<K, Bundle<B>>;
}

/**
 * Makes a family of bundles: for each key, the bundle of what `assets` names
 * for it.
 *
 *   const Levels = Assets.family("game/Level", (level: number) => ({
 *     layout: Assets.json(`/levels/${level}.json`, Layout),
 *   }))
 *
 *   Levels.of(3)        // the bundle of /levels/3.json, named "game/Level(3)"
 *
 * **When to use**
 *
 * Use for levels that are data: a game adds a level by adding its files,
 * with no bundle of its own to write. `Assets.during(family, key)` keeps the
 * bundle of the key the game is at loaded, and `Assets.onReady` hands each
 * loaded bundle to the rules. For one set of files, use `Assets.bundle`.
 *
 * @category Constructors
 */
export const family = <K extends Key, B extends Entries>(
  name: string,
  assets: (key: K) => B
): Family<K, B> => {
  const made = new Map<K, Bundle<B>>();
  return {
    name,
    made,
    of: (key) => {
      let one = made.get(key);
      if (one === undefined) {
        one = bundle(`${name}(${key})`, assets(key));
        made.set(key, one);
      }
      return one;
    },
  };
};

// Loads each asset of a bundle with `get`, in parallel, under its name.
const loadEach = (
  bundle: Bundle<Entries>,
  get: (asset: Asset<unknown>) => Effect.Effect<unknown, Failed, Scope.Scope>
): Effect.Effect<Record<string, unknown>, Failed, Scope.Scope> => {
  const names = Object.keys(bundle.assets);
  return Effect.map(
    Effect.forEach(names, (name) => get(bundle.assets[name]!), {
      concurrency: "unbounded",
    }),
    (values) => {
      const loaded: Record<string, unknown> = {};
      for (let i = 0; i < names.length; i++) {
        loaded[names[i]!] = values[i];
      }
      return loaded;
    }
  );
};

/**
 * Loads a bundle into the scope it runs in. It loads every asset in parallel,
 * and releases them all when that scope closes. It fails with the first asset
 * that fails, and cancels the rest.
 *
 *   const level = Effect.scoped(Effect.gen(function*() {
 *     const { layout } = yield* Assets.load(Forest)
 *     ...
 *   }))                                   // released here
 *
 * It waits in real time, so use it in the entry point or in a plugin's `layer`,
 * which is built before the game starts and holds what it loads for the app's
 * lifetime:
 *
 *   Layer.effect(Fonts, Assets.load(Common))
 *
 * **Gotchas**
 *
 * - A system that yields it doesn't compile, in any stage. A system has no
 *   scope to load into but the app's, which would keep what each frame loads
 *   until the app ends. A system holds a bundle with `Assets.during` or
 *   `Assets.Store`.
 *
 * @category Running
 */
export const load: <B extends Entries>(
  bundle: Bundle<B>
) => Effect.Effect<Loaded<B>, Failed, Scope.Scope> = Effect.fn("Assets.load")(
  function* (bundle: Bundle<Entries>) {
    const loader = yield* Loader;
    return yield* loadEach(bundle, (asset) =>
      Effect.flatMap(loader.bytes(asset.url), asset.decode)
    );
  }
) as <B extends Entries>(
  bundle: Bundle<B>
) => Effect.Effect<Loaded<B>, Failed, Scope.Scope>;

// --- an app's assets -----------------------------------------------------------------

/**
 * An app's store of bundles. All three operations are for the stages between
 * ticks, the frame and input stages. A system of the tick can't require
 * `Assets.Store`, since what is loaded, and when, isn't part of the game.
 *
 * @category Services
 */
export interface StoreShape {
  /** Returns a bundle's current status in the app. */
  readonly status: <B extends Entries>(bundle: Bundle<B>) => Status<Loaded<B>>;
  /**
   * Registers `holder` as using the bundle. The first holder starts loading
   * it. A file is fetched once for every held bundle that names it, and an
   * asset is decoded once for every held bundle that has it. A fetch that
   * failed with `transient` is tried again up to three times, after 200, 400
   * and 800 milliseconds.
   */
  readonly hold: (bundle: Bundle<Entries>, holder: string) => void;
  /**
   * Releases `holder`'s use of the bundle. When no holder remains, its pending
   * loads are cancelled, and each of its assets that no other held bundle has
   * is released.
   */
  readonly drop: (bundle: Bundle<Entries>, holder: string) => void;
}

/**
 * The bundles an app has loaded. `Assets.plugin` provides it, `Assets.during`
 * holds and drops bundles in it, and `Assets.Status` reads it. Your own
 * frame-stage or input-stage system can hold a bundle too. A bundle stays
 * loaded while anyone holds it.
 *
 *   const store = yield* Assets.Store
 *   store.hold(Forest, "game/Map")    // starts loading, if nobody held it
 *   store.drop(Forest, "game/Map")    // released, if nobody else holds it
 *
 * A load receives the services provided to the app from outside, and none of
 * the app's own, so nothing it does changes the game. The random numbers a
 * loader draws, such as to back off before retrying, don't come from the
 * world.
 *
 * @category Services
 */
export class Store extends Context.Service<Store, StoreShape>()(
  "arcadekit/Assets.Store"
) {}

interface Held {
  status: Status<unknown>;
  /**
   * Each holder's load, which keeps what it loaded until it is interrupted.
   * A holder that came while the bundle had failed has none.
   */
  readonly holders: Map<string, Fiber.Fiber<void> | undefined>;
}

const retries = Schedule.exponential("200 millis").pipe(
  Schedule.upTo({ times: 3 })
);

const storeLayer = Layer.effect(
  Store,
  Effect.gen(function* () {
    // Loading runs on its own, in real time: with what the app was given
    // from outside, and not on the scheduler its ticks own. It is given
    // none of the app's own services. They are the game's, and a load
    // that reached them would change it: Effect's Random inside an app is
    // the world's generator, and one draw from it by a loader is a game
    // no replay repeats.
    const context = Context.omit(
      World,
      Time,
      Frame,
      Commands,
      Events,
      Random,
      Action.Actions,
      Input.Devices,
      EffectRandom.Random
    )(yield* Effect.context<Scope.Scope>());
    const runFork = Effect.runForkWith(context);
    const scope = yield* Effect.scope;
    const loader = yield* Loader;
    // A file is fetched once for every asset that names it, and kept while
    // any of them is loaded.
    const files = yield* RcMap.make({
      lookup: (url: string) =>
        Effect.retry(loader.bytes(url), {
          schedule: retries,
          while: (error) => error.transient === true,
        }),
    }).pipe(Effect.updateContext<never, Scope.Scope>(() => context));
    // An asset is decoded once for every bundle that has it, in a scope that
    // closes when the last of them is let go.
    const values = yield* RcMap.make({
      lookup: (asset: Asset<unknown>) =>
        Effect.flatMap(RcMap.get(files, asset.url), asset.decode),
    }).pipe(Effect.updateContext<never, Scope.Scope>(() => context));
    const held = new Map<Bundle<Entries>, Held>();

    const holding = (
      bundle: Bundle<Entries>,
      entry: Held
    ): Effect.Effect<void> =>
      Effect.scoped(
        Effect.flatMap(
          loadEach(bundle, (asset) => RcMap.get(values, asset)),
          (assets) => {
            entry.status = Statuses.Ready({ assets });
            return Effect.never;
          }
        )
      ).pipe(
        // What did load is no use without the rest: the scope has let it go.
        Effect.catchCause((cause) => {
          if (entry.status._tag === "Failed") {
            return Effect.void;
          }
          const error = Cause.squash(cause);
          entry.status = Statuses.Failed({
            error:
              error instanceof Failed
                ? error
                : new Failed({ url: "", message: describe(error) }),
          });
          return Effect.logError(
            `The assets "${bundle.name}" could not be loaded`,
            cause
          );
        })
      );

    return {
      status<B extends Entries>(bundle: Bundle<B>) {
        return (held.get(bundle)?.status ?? ABSENT) as Status<Loaded<B>>;
      },
      hold(bundle, holder) {
        let entry = held.get(bundle);
        if (entry === undefined) {
          entry = { status: LOADING, holders: new Map() };
          held.set(bundle, entry);
        }
        if (entry.holders.has(holder)) {
          return;
        }
        // Whatever is still loaded when the app is closed goes with it.
        entry.holders.set(
          holder,
          entry.status._tag === "Failed"
            ? undefined
            : Fiber.runIn(runFork(holding(bundle, entry)), scope)
        );
      },
      drop(bundle, holder) {
        const entry = held.get(bundle);
        if (entry === undefined || !entry.holders.has(holder)) {
          return;
        }
        entry.holders.get(holder)?.interruptUnsafe();
        entry.holders.delete(holder);
        if (entry.holders.size === 0) {
          held.delete(bundle);
        }
      },
    };
  })
);

/**
 * Gives an app a store for the bundles it loads. A plugin whose systems use
 * `Assets.during`, or read a bundle, lists it in `plugins`.
 *
 * Anything still loaded when the app is closed is released with it.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Assets", { layer: storeLayer });

/**
 * Makes a system that keeps a bundle loaded, piped through `System.runIf` to
 * keep it loaded while a condition holds, as every system is:
 *
 *   Assets.during(Forest).pipe(System.runIf(State.is(Level, "forest")))
 *
 * From the frame after the condition starts to hold, the bundle loads in a
 * scope of its own. From the frame after it stops, that scope closes. Loaded
 * assets are released, and pending loads are cancelled. A level's assets
 * therefore last as long as the level, and leaving it frees them. With no
 * condition, the bundle stays loaded until the app is closed.
 *
 * It is a frame system, since assets serve what draws the game. A replay or a
 * server runs no frames, and loads nothing. It runs in the first of a frame's
 * three stages, `"preFrame"`, so every system that draws with the bundle sees
 * the same status within a frame, whatever order they are listed in. It is
 * named after the bundle, `Assets.during(game/Forest)`, so a second one for
 * the same bundle is refused as a second system of that name. To keep a
 * bundle loaded across several states, give a condition that holds in each.
 *
 * Given a family and a key, it keeps the bundle of that key loaded, such as
 * the files of the level the game is at:
 *
 *   Assets.during(Levels, Effect.map(Progress, ({ level }) => level))
 *
 * When the key changes, it lets go of the bundle of the key before and holds
 * the new one, from the next frame. A key of `undefined` holds none.
 *
 * @category Systems
 */
export function during<B extends Entries>(
  bundle: Bundle<B>
): System.System<never, Store, string, "preFrame">;
export function during<E, R, K extends Key, B extends Entries>(
  family: Family<K, B>,
  key: System.FrameOk<K | undefined, E, R>
): System.System<E, R | Store, string, "preFrame">;
export function during<E, R>(
  held: Bundle<Entries> | Family<Key, Entries>,
  key?: Effect.Effect<Key | undefined, E, R>
): System.System<E, R | Store, string, "preFrame"> {
  const name = `Assets.during(${held.name})`;
  if (held instanceof Bundle) {
    return makeSystem(name, "preFrame", function* () {
      (yield* Store).hold(held, name);
    }).pipe(
      System.otherwise(
        Effect.map(Effect.service(Store), (store) => {
          store.drop(held, name);
        })
      )
    );
  }
  if (key === undefined) {
    throw new Error(
      `Assets.during was given the family "${held.name}" and no key. Give it the key of the bundle to keep loaded: Assets.during(${held.name}, key), with an Effect that returns it.`
    );
  }
  // The bundle each app's store holds for this system, by store.
  const holding = new WeakMap<StoreShape, Bundle<Entries>>();
  return makeSystem(name, "preFrame", function* () {
    const store = yield* Store;
    const now = yield* key;
    const next = now === undefined ? undefined : held.of(now);
    const before = holding.get(store);
    if (before === next) {
      return;
    }
    if (before !== undefined) {
      store.drop(before, name);
      holding.delete(store);
    }
    if (next !== undefined) {
      store.hold(next, name);
      holding.set(store, next);
    }
  });
}

// --- handing a loaded file to the rules -------------------------------------------

/**
 * What the world was last handed of each source of `Assets.onReady`, by the
 * source's name: the key of a family's bundle, or `null` for a bundle alone.
 * It is the world's, so a save, a rewind and the hash hold it, and a handover
 * is applied once however many peers issue it.
 */
const Handed = Singleton.define(
  "arcadekit/Assets.Handed",
  { by: Field.json<Readonly<Record<string, Key | null>>>({}) },
  { by: {} }
);

/**
 * The payload of a handover: which key's bundle, and what the rules are
 * handed of it.
 *
 * @category Models
 */
export interface Handover<P> {
  readonly key: Key | null;
  readonly payload: P;
}

/**
 * The plugin `Assets.onReady` makes: an input-stage system that issues a
 * handover, and the handler that applies it once.
 *
 * @typeParam P what the rules are handed
 * @typeParam A what the game's handler returns
 * @typeParam E what the game's handler refuses with
 * @typeParam R what the game's handler requires
 *
 * @category Type-level
 */
export type OnReady<P, A, E, R> = ReturnType<typeof handing<P, A, E, R>>;

/** What `Sim` stands for, which a handler provides for itself. */
const simulation = { "~arcadekit/Sim": true } as const;

/** The rules' handler, run once for each key the world is handed. */
const handover = <P, A, E, R>(
  name: string,
  rules: Action.Handler<string, P, A, E, R>
) => {
  const action = Action.define(`arcadekit/Assets.onReady(${name})`, {
    payload: Schema.Struct({
      key: Schema.NullOr(Schema.Union([Schema.Number, Schema.String])),
      payload: rules.action.codec,
    }),
  });
  const handler: Action.Handler<
    `arcadekit/Assets.onReady(${string})`,
    Handover<P>,
    A | undefined,
    E,
    R | World
  > = {
    // Refused as the rules' own action is, and in the same words.
    action: {
      ...action,
      error: rules.action.error,
      rejected: Event.define(
        `Action.Rejected(${action.name})`,
        Schema.Struct({
          payload: action.codec,
          error: rules.action.error,
          from: Schema.UndefinedOr(Schema.String),
        })
      ),
    },
    handle: ({ key, payload }, origin) =>
      Effect.provideService(
        Effect.flatMap(Singleton.Write(Handed), (handed) => {
          // Handed already, by another peer or before a save was made.
          if (Object.hasOwn(handed.by, name) && handed.by[name] === key) {
            return Effect.succeed(undefined);
          }
          handed.by = { ...handed.by, [name]: key };
          return rules.handle(payload, origin);
        }),
        Sim,
        simulation
      ),
  };
  return handler;
};

/** For each load in an app, whether its handover was issued or the world has it. */
type Seen = "issued" | "handed";

const handing = <P, A, E, R, K extends Key | null = Key | null>(
  name: string,
  rules: Action.Handler<string, P, A, E, R>,
  key: Effect.Effect<K | undefined, never, World>,
  bundleOf: (key: K) => Bundle<Entries>,
  payload: (assets: Loaded<Entries>, key: K) => P
) => {
  const handler = handover(name, rules);
  // Each load's ready status is an object of its own app's store.
  const seen = new WeakMap<object, Seen>();
  const issue = makeSystem(`Assets.onReady(${name})`, "input", function* () {
    const at = yield* key;
    if (at === undefined) {
      return;
    }
    const status = (yield* Store).status(bundleOf(at));
    if (status._tag !== "Ready") {
      return;
    }
    const { by } = yield* Singleton.Read(Handed);
    if (Object.hasOwn(by, name) && by[name] === at) {
      seen.set(status, "handed");
      return;
    }
    // Issued and not applied yet: once it is, the world has it.
    if (seen.get(status) === "issued") {
      return;
    }
    seen.set(status, "issued");
    (yield* Action.Actions).enqueue(handler.action, {
      key: at,
      payload: payload(status.assets, at),
    });
  });
  return Plugin.make(`arcadekit/Assets.onReady(${name})`, {
    plugins: [plugin],
    systems: [issue],
    handlers: [handler],
  });
};

/**
 * Makes a plugin that hands a bundle's assets to the rules once it is loaded:
 * an input-stage system issues an action whose payload is made from the
 * assets, and `rules`, a handler of the game's, applies it. The moment a
 * level's file is loaded becomes one action of the log.
 *
 *   const Build = Action.define("game/Build", { payload: Layout })
 *   const build = Action.handler(Build, function* (layout) { ... })
 *
 *   const LevelReady = Assets.onReady(Levels, level, build, ({ layout }) => layout)
 *   const Game = Plugin.make("game/Game", { plugins: [LevelReady], ... })
 *
 * Given a family, it takes the key the game is at, an Effect that reads the
 * world, such as `Effect.map(Progress, ({ level }) => level)`, the same as
 * `Assets.during` keeps loaded, and hands over that key's bundle, with the
 * key.
 *
 * **When to use**
 *
 * Use when the rules need what a file holds, such as where a level's walls
 * are. The action is in the log, so a replay or a server has the file's
 * contents without loading it. List the plugin in the game's `plugins`, and
 * `rules` nowhere else.
 *
 * **Details**
 *
 * - The world records what it was handed: for a family, the key, and for a
 *   bundle alone, that it was. `rules` runs once for each key the world is
 *   handed, and a handover of what the world has already is applied and does
 *   nothing. So a level whose file spawns nothing is handed over once, an
 *   app made from a save doesn't hand its level over again, and going from
 *   level 1 to level 2 and back hands each over when the game comes to it.
 * - A save, the hash and a rewind hold the record. A rewind to before a
 *   handover hands it over again, once.
 * - In a session, every peer whose bundle loads issues the handover, and the
 *   first one applied is the one that counts, on every peer. A peer whose
 *   bundle fails to load issues nothing and holds nobody up, and its bundle
 *   is `Failed`, as any bundle that fails.
 * - `Assets.forget` makes the world forget a handover, so that the bundle is
 *   handed over again, such as when a new run starts at a level the game was
 *   handed before.
 *
 * @category Plugins
 */
export function onReady<N extends string, P, A, E, R, B extends Entries>(
  bundle: Bundle<B>,
  rules: Action.Handler<N, P, A, E, R>,
  payload: (assets: Loaded<B>) => P
): OnReady<P, A, E, R>;
export function onReady<
  N extends string,
  P,
  A,
  E,
  R,
  K extends Key,
  B extends Entries,
>(
  family: Family<K, B>,
  key: Effect.Effect<K | undefined, never, World>,
  rules: Action.Handler<N, P, A, E, R>,
  payload: (assets: Loaded<B>, key: K) => P
): OnReady<P, A, E, R>;
export function onReady<P, A, E, R>(
  source: Bundle<Entries> | Family<Key, Entries>,
  ...rest:
    | readonly [
        Action.Handler<string, P, A, E, R>,
        (assets: Loaded<Entries>) => P,
      ]
    | readonly [
        Effect.Effect<Key | undefined, never, World>,
        Action.Handler<string, P, A, E, R>,
        (assets: Loaded<Entries>, key: Key) => P,
      ]
): OnReady<P, A, E, R> {
  if (rest.length === 2) {
    if (!(source instanceof Bundle)) {
      throw new Error(
        `Assets.onReady was given the family "${source.name}" and no key. A family's bundle is the one of the key the game is at: Assets.onReady(family, key, rules, payload).`
      );
    }
    const [rules, payload] = rest;
    return handing<P, A, E, R, null>(
      source.name,
      rules,
      Effect.succeed(null),
      () => source,
      (assets) => payload(assets)
    );
  }
  if (source instanceof Bundle) {
    throw new Error(
      `Assets.onReady was given the bundle "${source.name}" and a key. A bundle alone has no key: Assets.onReady(bundle, rules, payload).`
    );
  }
  const [key, rules, payload] = rest;
  return handing<P, A, E, R, Key>(
    source.name,
    rules,
    key,
    (at) => source.of(at),
    payload
  );
}

/**
 * Makes the world forget what `Assets.onReady` handed it of a bundle or a
 * family, so that it is handed over again once the bundle is ready. It is code
 * of the tick, for an action's handler or a hook.
 *
 *   Action.handler(NewRun, function* () {
 *     yield* Assets.forget(Level)    // the level's file is handed over again
 *   })
 *
 * @category Utilities
 */
export const forget = (
  source: Bundle<Entries> | Family<Key, Entries>
): Effect.Effect<void, never, World | Sim> =>
  Effect.map(Singleton.Write(Handed), (handed) => {
    if (Object.hasOwn(handed.by, source.name)) {
      const { [source.name]: _gone, ...rest } = handed.by;
      handed.by = rest;
    }
  });
