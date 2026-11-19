/**
 * Assets are the files a game loads to be drawn and heard. Loading is a scoped
 * resource: loaded assets are released when the scope they were loaded in
 * closes.
 *
 *   const Forest = Assets.bundle("game/Forest", {
 *     backdrop: Browser.image("/forest.png"),    // from "arcadekit/Browser"
 *     layout: Assets.json("/forest.json", Layout),
 *   })
 *
 * Anywhere there is a scope:
 *
 *   const { backdrop, layout } = yield* Assets.load(Forest)
 *
 * For a level, the scope is the level's. `Assets.during` loads a bundle while a
 * condition holds, typically a state of the game, and releases it when the
 * condition no longer holds:
 *
 *   const Game = Plugin.make("Game", {
 *     plugins: [Assets.plugin],
 *     systems: [Assets.during(State.is(Level, "forest"), Forest), Draw],
 *   })
 *
 *   const Draw = System.make("Draw", function*() {
 *     const forest = yield* Forest               // the bundle's current status
 *     if (forest._tag === "Ready") draw(forest.assets.backdrop)
 *   }).pipe(System.inStage("frame"))
 *
 * Loading takes real time, so it isn't part of the simulation: nothing in a
 * tick waits for an asset or can tell whether one is loaded. What the game
 * itself needs from a file, such as where the walls are, enters as an action,
 * issued by an input-stage system once the asset is ready, and is in the log
 * from then on.
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

import * as Action from "./Action";
import * as Input from "./Input";
import * as Plugin from "./Plugin";
import {
  Commands,
  Events,
  Frame,
  Random,
  Script,
  Time,
  World,
} from "./Services";
import * as System from "./System";

/**
 * An asset couldn't be loaded: it is missing, or it isn't what it claimed to
 * be.
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
  readonly url: string;
  /**
   * Decodes the asset from its bytes, in the scope it is loaded in: anything
   * that must be released is released when that scope closes.
   */
  readonly decode: (
    bytes: Uint8Array
  ) => Effect.Effect<A, AssetFailed, Scope.Scope>;
}

/**
 * Makes an asset of a custom type. `decode` builds it from its bytes; use
 * `Effect.acquireRelease` if what it builds must be released.
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
 * Makes an asset of a JSON file that a schema describes. It comes from outside
 * the program, so it is validated: a file that doesn't match fails to load.
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
 * Fetches an asset's bytes. In a page it uses `fetch`; a test provides one that
 * reads from memory.
 *
 * @category Services
 */
export interface LoaderShape {
  /** Returns the bytes at a URL. Interrupting it cancels the request. */
  readonly bytes: (url: string) => Effect.Effect<Uint8Array, AssetFailed>;
}

const fetching: LoaderShape = {
  bytes: (url) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          throw new Error(
            `The server answered ${response.status} ${response.statusText}`.trim()
          );
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      catch: (error) => new AssetFailed({ url, message: describe(error) }),
    }),
};

/**
 * Where asset bytes come from. Nothing has to provide it: the default is
 * `fetch`, available in pages and Node alike. A test provides its own files
 * with `Assets.layerMemory`.
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

// `any`: an asset is of whatever its `decode` makes, and a bundle holds
// assets of several kinds.
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
  /** No one has requested it. */
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly assets: A }
  /**
   * It couldn't be loaded, which is logged once. Nothing that did load is kept,
   * and it is retried the next time it is requested afresh.
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
 * app's log and names the system that loads it, so prefix it with the feature
 * it belongs to.
 *
 * @category Constructors
 */
export const bundle = <B extends Entries>(name: string, assets: B): Bundle<B> =>
  new Bundle(name, assets);

/**
 * Loads a bundle into the scope it runs in: every asset in parallel, all
 * released when that scope closes. It fails with the first asset that fails,
 * cancelling the rest.
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
 * Don't use it in a system or a script, though nothing prevents it: a script
 * that loads resumes in whatever tick the file arrives in, and a replay fetches
 * the file again.
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
 * ticks, the frame and input stages: during the tick each throws, since what is
 * loaded, and when, isn't part of the game.
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
   * closes: loaded assets are released, and pending loads are cancelled.
   */
  readonly drop: (bundle: Bundle<Entries>, holder: string) => void;
}

/**
 * The bundles an app has loaded. `Assets.plugin` provides it, `Assets.during`
 * drives it, and `yield*` on a bundle reads it. Your own frame-stage or
 * input-stage system can hold a bundle too: it stays loaded while anyone holds
 * it.
 *
 *   const store = yield* Assets.Store
 *   store.hold(Forest, "game/Map")    // starts loading, if nobody held it
 *   store.drop(Forest, "game/Map")    // released, if nobody else holds it
 *
 * A load receives the services provided to the app from outside, but none of
 * the app's own, so nothing it does affects the game: the random numbers a
 * loader draws, to back off before retrying, don't come from the world.
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
      Script,
      Events,
      Random,
      Action.Actions,
      Input.Devices,
      EffectRandom.Random
    )(yield* Effect.context<never>()) as Context.Context<never>;
    const runFork = Effect.runForkWith(context);
    const held = new Map<Bundle<Entries>, Held>();
    // Between ticks an app's world is frozen: that is how the stages that
    // may know about assets are told from the tick.
    const world = yield* World;
    const betweenTicks = (bundle: Bundle<Entries>, what: string): void => {
      if (!world.frozen) {
        throw new Error(
          `The assets "${bundle.name}" were ${what} in the tick. Whether an asset has been loaded depends on real time, which a simulation must not: a replay loads nothing. Do it from a system of the frame stage, System.inStage("frame"), which draws with them, or of the input stage, which can issue an action once they are there.`
        );
      }
    };

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

    // Whatever is still loaded when the app's scope closes goes with it.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(held.values()), (entry) => letGo(entry), {
        discard: true,
      })
    );

    return {
      status<B extends Entries>(bundle: Bundle<B>) {
        betweenTicks(bundle, "asked for");
        return (held.get(bundle)?.status ?? ABSENT) as Status<Loaded<B>>;
      },
      hold(bundle, holder) {
        betweenTicks(bundle, "held");
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
        betweenTicks(bundle, "let go of");
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
 * Anything still loaded when the app's scope closes is released with it.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Assets", { layer: storeLayer });

/**
 * Makes a system that keeps a bundle loaded while a condition holds:
 *
 *   Assets.during(State.is(Level, "forest"), Forest)
 *
 * The condition is the same as `System.runIf`'s: an Effect that returns a
 * boolean. From the frame after it starts holding, the bundle loads in a scope
 * of its own. From the frame after it stops, that scope closes: loaded assets
 * are released, and pending loads are cancelled. A level's assets therefore
 * last as long as the level, and leaving it frees them.
 *
 * It is a frame system, since assets serve what draws the game: a replay or a
 * server, which run no frames, load nothing. It runs in the first of a frame's
 * three stages, `"preFrame"`, so every system that draws with the bundle sees
 * the same status within a frame, whatever order they are listed in. Use one
 * per bundle; to keep a bundle loaded across several states, give a condition
 * that holds in each.
 *
 * @category Systems
 */
export const during = <E, R, B extends Entries>(
  condition: Effect.Effect<boolean, E, R>,
  bundle: Bundle<B>
): System.System<E, R | Store> => {
  const name = `Assets.during(${bundle.name})`;
  return System.make(name, function* () {
    const store = yield* Store;
    if (yield* condition) {
      store.hold(bundle, name);
    } else {
      store.drop(bundle, name);
    }
  }).pipe(System.inStage("preFrame"));
};
