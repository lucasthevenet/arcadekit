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
  Schema,
  Scope,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";

import * as Action from "./Action";
import * as Input from "./Input";
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
const unanswered = (error: HttpClientError.HttpClientError): string => {
  const cause = error.reason.cause;
  return cause instanceof Error && cause.message !== ""
    ? `${error.message}: ${cause.message}`
    : error.message;
};

/**
 * Effect's `HttpClient` over `fetch`, asking for the address `resolve` makes
 * of an asset's URL. A failure names the URL as the game wrote it.
 * @internal
 */
export const fetchingFrom = (
  resolve: (url: string) => string
): LoaderShape => ({
  bytes: (url) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(resolve(url));
      if (response.status < 200 || response.status >= 300) {
        return yield* new AssetFailed({
          url,
          message: `The server answered ${response.status}`,
        });
      }
      return new Uint8Array(yield* response.arrayBuffer);
    }).pipe(
      Effect.catchTag("HttpClientError", (error) =>
        Effect.fail(new AssetFailed({ url, message: unanswered(error) }))
      ),
      Effect.provide(FetchHttpClient.layer)
    ),
});

/**
 * What `Loader` is when nothing provides it. A path is read as `HttpClient`
 * reads it, from the page's address, or the process's in Node.
 * @internal
 */
export const fetching: LoaderShape = fetchingFrom((url) => url);

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
  const names = Object.keys(bundle.assets);
  const values = yield* Effect.forEach(
    names,
    (name) => {
      const asset = bundle.assets[name]!;
      return Effect.flatMap(loader.bytes(asset.url), (data) =>
        asset.decode(data)
      );
    },
    { concurrency: "unbounded" }
  );
  const loaded: Record<string, unknown> = {};
  for (let i = 0; i < names.length; i++) {
    loaded[names[i]!] = values[i];
  }
  return loaded;
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
   * Registers `holder` as using the bundle. The first holder starts loading it,
   * in a scope of its own.
   */
  readonly hold: (bundle: Bundle<Entries>, holder: string) => void;
  /**
   * Releases `holder`'s use of the bundle. When no holder remains, its scope
   * closes. Loaded assets are released, and pending loads are cancelled.
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
  readonly bundle: Bundle<Entries>;
  readonly holders: Set<string>;
  status: Status<unknown>;
  /** The scope the bundle is loaded in, while it is loading or loaded. */
  scope: Scope.Closeable | undefined;
  fiber: Fiber.Fiber<unknown, AssetFailed> | undefined;
}

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
    )(yield* Effect.context<never>()) as Context.Context<never>;
    const runFork = Effect.runForkWith(context);
    const held = new Map<Bundle<Entries>, Held>();

    const entryOf = (bundle: Bundle<Entries>): Held => {
      let entry = held.get(bundle);
      if (entry === undefined) {
        entry = {
          bundle,
          holders: new Set(),
          status: ABSENT,
          scope: undefined,
          fiber: undefined,
        };
        held.set(bundle, entry);
      }
      return entry;
    };

    const start = (entry: Held): void => {
      const scope = Scope.makeUnsafe();
      entry.scope = scope;
      entry.status = LOADING;
      const fiber = runFork(Scope.provide(load(entry.bundle), scope));
      entry.fiber = fiber;
      const ended = (exit: Exit.Exit<unknown, AssetFailed>): void => {
        // Let go while it was loading: nobody is waiting for this.
        if (entry.fiber !== fiber) {
          return;
        }
        if (Exit.isSuccess(exit)) {
          entry.status = { _tag: "Ready", assets: exit.value };
          return;
        }
        const error = Cause.squash(exit.cause);
        entry.status = {
          _tag: "Failed",
          error:
            error instanceof AssetFailed
              ? error
              : new AssetFailed({ url: "", message: describe(error) }),
        };
        // What did load is no use without the rest: it is let go now, and
        // not when the bundle is.
        runFork(
          Effect.andThen(
            Effect.logError(
              `The assets "${entry.bundle.name}" could not be loaded`,
              exit.cause
            ),
            Scope.close(scope, Exit.void)
          )
        );
      };
      const exit = fiber.pollUnsafe();
      if (exit === undefined) {
        fiber.addObserver(ended);
      } else {
        ended(exit);
      }
    };

    /** Cancels pending loads, and releases loaded assets. */
    const letGo = (entry: Held): Effect.Effect<void> =>
      Effect.suspend(() => {
        const { fiber, scope } = entry;
        entry.fiber = undefined;
        entry.scope = undefined;
        entry.status = ABSENT;
        if (scope === undefined) {
          return Effect.void;
        }
        return Effect.andThen(
          fiber === undefined ? Effect.void : Fiber.interrupt(fiber),
          Scope.close(scope, Exit.void)
        );
      });

    // Whatever is still loaded when the app is closed goes with it.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(held.values()), (entry) => letGo(entry), {
        discard: true,
      })
    );

    return {
      status<B extends Entries>(bundle: Bundle<B>) {
        return (held.get(bundle)?.status ?? ABSENT) as Status<Loaded<B>>;
      },
      hold(bundle, holder) {
        const entry = entryOf(bundle);
        if (entry.holders.has(holder)) {
          return;
        }
        entry.holders.add(holder);
        if (entry.holders.size === 1) {
          start(entry);
        }
      },
      drop(bundle, holder) {
        const entry = held.get(bundle);
        if (entry === undefined || !entry.holders.delete(holder)) {
          return;
        }
        if (entry.holders.size === 0) {
          runFork(letGo(entry));
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
  return System.raw(name, "preFrame", function* () {
    const store = yield* Store;
    if (yield* condition) {
      store.hold(bundle, name);
    } else {
      store.drop(bundle, name);
    }
  });
};
