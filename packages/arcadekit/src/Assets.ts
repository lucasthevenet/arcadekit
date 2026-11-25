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
 *     systems: [Assets.during(State.is(Level, "forest"), Forest), Draw],
 *   })
 *
 *   const Draw = System.frame("Draw", function*() {
 *     const forest = yield* Forest               // the bundle's current status
 *     if (forest._tag === "Ready") draw(forest.assets.backdrop)
 *   })
 *
 * Loading takes real time, so it isn't part of the simulation. Nothing in a
 * tick waits for an asset or can tell whether one is loaded. What the game
 * itself needs from a file, such as where the walls are, enters as an action.
 * An input-stage system issues the action once the asset is ready, and the
 * log holds it from then on.
 */
import {
  Cause,
  Context,
  Data,
  Effect,
  Random as EffectRandom,
  Effectable,
  Exit,
  Fiber,
  Layer,
  RcMap,
  Schedule,
  Schema,
  Scope,
} from "effect";

import * as Action from "./Action";
import * as Input from "./Input";
import { fetching } from "./internal/assets";
import { raw } from "./internal/system";
import * as Plugin from "./Plugin";
import { Commands, Events, Frame, Random, Time, World } from "./Services";
import * as System from "./System";

/**
 * An asset couldn't be loaded, because it is missing or isn't what it claimed
 * to be.
 *
 * @category Errors
 */
export class AssetFailed extends Data.TaggedError("AssetFailed")<{
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
  readonly decode: (
    bytes: Uint8Array
  ) => Effect.Effect<A, AssetFailed, Scope.Scope>;
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
  ) => Effect.Effect<A, AssetFailed, Scope.Scope>
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
          new AssetFailed({
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
 * fails to load with `AssetFailed`.
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
          new AssetFailed({
            url: at,
            message: `It is not JSON: ${describe(error)}`,
          })
        );
      }
      const exit = decode(parsed);
      return Exit.isSuccess(exit)
        ? Effect.succeed(exit.value as S["Type"])
        : Effect.fail(
            new AssetFailed({
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
  readonly bytes: (url: string) => Effect.Effect<Uint8Array, AssetFailed>;
}

// What a request that got no answer says: what was asked, and why.
/**
 * Where asset bytes come from. Nothing has to provide it. The default is
 * Effect's `HttpClient` over `fetch`, available in pages and Node alike, which
 * reads a path against the page's address. `Browser.layer` reads a path
 * against the document's base instead, as `fetch` does. A test provides its
 * own files with `Assets.layerMemory`.
 *
 * @category Services
 */
export const Loader: Context.Reference<LoaderShape> =
  Context.Reference<LoaderShape>("arcadekit/Assets.Loader", {
    defaultValue: () => fetching,
  });

/**
 * A loader of in-memory files by URL, for a test or a tool. A file given as
 * text is encoded as UTF-8. A URL not in the list fails.
 *
 * @category Testing
 */
export const layerMemory = (
  files: Readonly<Record<string, Uint8Array | string>>
): Layer.Layer<never> =>
  Layer.succeed(Loader, {
    bytes: (url) =>
      Effect.suspend(() => {
        const file = Object.hasOwn(files, url) ? files[url] : undefined;
        if (file === undefined) {
          return Effect.fail(
            new AssetFailed({ url, message: "There is no such file." })
          );
        }
        return Effect.succeed(
          typeof file === "string" ? new TextEncoder().encode(file) : file
        );
      }),
  }) as Layer.Layer<never>;

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
export type Status<A> =
  /** No one holds it. */
  | { readonly _tag: "Absent" }
  /** It is loading. */
  | { readonly _tag: "Loading" }
  /** It is loaded, and `assets` holds each asset under its name. */
  | { readonly _tag: "Ready"; readonly assets: A }
  /**
   * It couldn't be loaded, which is logged once. Nothing that did load is
   * kept. It is loaded again when it is next held after every holder has
   * dropped it.
   */
  | { readonly _tag: "Failed"; readonly error: AssetFailed };

const ABSENT: Status<never> = { _tag: "Absent" };
const LOADING: Status<never> = { _tag: "Loading" };

/**
 * Assets that are loaded and released together, such as a level's or a menu's.
 * It is an Effect, so in a frame-stage or input-stage system `yield*` returns
 * its current status in the app.
 *
 * @category Models
 */
export class Bundle<B extends Entries> extends Effectable.Class<
  Status<Loaded<B>>,
  never,
  Store
> {
  private effect: Effect.Effect<Status<Loaded<B>>, never, Store> | undefined;

  constructor(
    readonly name: string,
    readonly assets: B
  ) {
    super();
  }

  asEffect(): Effect.Effect<Status<Loaded<B>>, never, Store> {
    return (this.effect ??= Effect.map(Effect.service(Store), (store) =>
      store.status(this)
    ));
  }
}

/**
 * Groups assets that belong together. The name identifies the bundle in the
 * error logged when it fails to load, and names the system that
 * `Assets.during` makes for it, so prefix it with the feature it belongs to.
 *
 * @category Constructors
 */
export const bundle = <B extends Entries>(name: string, assets: B): Bundle<B> =>
  new Bundle(name, assets);

// Loads each asset of a bundle with `get`, in parallel, under its name.
const loadEach = (
  bundle: Bundle<Entries>,
  get: (
    asset: Asset<unknown>
  ) => Effect.Effect<unknown, AssetFailed, Scope.Scope>
): Effect.Effect<Record<string, unknown>, AssetFailed, Scope.Scope> => {
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
) => Effect.Effect<Loaded<B>, AssetFailed, Scope.Scope> = Effect.fn(
  "Assets.load"
)(function* (bundle: Bundle<Entries>) {
  const loader = yield* Loader;
  return yield* loadEach(bundle, (asset) =>
    Effect.flatMap(loader.bytes(asset.url), asset.decode)
  );
}) as <B extends Entries>(
  bundle: Bundle<B>
) => Effect.Effect<Loaded<B>, AssetFailed, Scope.Scope>;

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
 * holds and drops bundles in it, and `yield*` on a bundle reads it. Your own
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
            entry.status = { _tag: "Ready", assets };
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
          entry.status = {
            _tag: "Failed",
            error:
              error instanceof AssetFailed
                ? error
                : new AssetFailed({ url: "", message: describe(error) }),
          };
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
 * Makes a system that keeps a bundle loaded while a condition holds:
 *
 *   Assets.during(State.is(Level, "forest"), Forest)
 *
 * The condition is the same as `System.runIf`'s, an Effect that returns a
 * boolean. From the frame after it starts holding, the bundle loads in a scope
 * of its own. From the frame after it stops, that scope closes. Loaded assets
 * are released, and pending loads are cancelled. A level's assets therefore
 * last as long as the level, and leaving it frees them.
 *
 * It is a frame system, since assets serve what draws the game. A replay or a
 * server runs no frames, and loads nothing. It runs in the first of a frame's
 * three stages, `"preFrame"`, so every system that draws with the bundle sees
 * the same status within a frame, whatever order they are listed in. Use one
 * per bundle. To keep a bundle loaded across several states, give a condition
 * that holds in each.
 *
 * @category Systems
 */
export const during = <E, R, B extends Entries>(
  condition: System.FrameOk<boolean, E, R>,
  bundle: Bundle<B>
): System.System<E, R | Store, string, "preFrame"> => {
  const name = `Assets.during(${bundle.name})`;
  return raw(name, "preFrame", function* () {
    const store = yield* Store;
    if (yield* condition) {
      store.hold(bundle, name);
    } else {
      store.drop(bundle, name);
    }
  });
};
