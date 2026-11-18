/**
 * Assets: what a game loads to be drawn and heard. Loading is a scoped
 * resource: what was loaded is let go when the scope it was loaded in
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
 * For a level, the scope is the level's. `Assets.during` loads a bundle
 * while a condition holds, a state of the game as a rule, and lets it go
 * when it holds no longer:
 *
 *   const Game = Plugin.make("Game", {
 *     plugins: [Assets.plugin],
 *     systems: [Assets.during(State.is(Level, "forest"), Forest), Draw],
 *   })
 *
 *   const Draw = System.make("Draw", function*() {
 *     const forest = yield* Forest               // what is loaded of it now
 *     if (forest._tag === "Ready") draw(forest.assets.backdrop)
 *   }).pipe(System.inStage("frame"))
 *
 * Loading takes real time, so it is no part of the simulation: nothing in
 * a tick waits for an asset or can tell whether one is there. What the
 * game itself needs from a file (where the walls are) comes in as an
 * action, issued by a system of the input stage once the asset is ready,
 * and is in the log from then on.
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
 * An asset could not be loaded: it is not there, or it is not what it was said to be.
 *
 * @category Errors
 */
export class AssetFailed extends Data.TaggedError("AssetFailed")<{
  /** Where the asset was to come from. */
  readonly url: string;
  /** What went wrong. */
  readonly message: string;
}> {}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

// --- one asset ---------------------------------------------------------------

/**
 * Something to load: where its bytes are, and what is made of them.
 *
 * @category Models
 */
export interface Asset<out A> {
  readonly url: string;
  /**
   * Makes the asset of its bytes, in the scope it is loaded in: what has
   * to be let go is let go when that scope closes.
   */
  readonly decode: (
    bytes: Uint8Array
  ) => Effect.Effect<A, AssetFailed, Scope.Scope>;
}

/**
 * An asset of a kind of your own. `decode` makes it of its bytes; give it
 * `Effect.acquireRelease` if what it makes has to be let go.
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
 * A file as it is.
 *
 * @category Constructors
 */
export const bytes = (url: string): Asset<Uint8Array> =>
  make(url, (data) => Effect.succeed(data));

/**
 * A file of text, which has to be UTF-8.
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
 * A file of JSON that a schema describes. It comes from outside the
 * program, so it is checked: one that does not fit fails to load.
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
 * What fetches an asset's bytes. In a page it is `fetch`; a test provides
 * one that reads from memory.
 *
 * @category Services
 */
export interface LoaderShape {
  /** The bytes at a URL. Interrupting it gives up the request. */
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
 * Where the bytes of an asset come from. Nothing has to provide it: the
 * default is `fetch`, which a page and Node both have. A test provides
 * files of its own with `Assets.layerMemory`.
 *
 * @category Services
 */
export const Loader: Context.Reference<LoaderShape> =
  Context.Reference<LoaderShape>("arcadekit/Assets.Loader", {
    defaultValue: () => fetching,
  });

/**
 * A loader of files held in memory, by URL, for a test or a tool. A file
 * given as text is its UTF-8 bytes. A URL that is not among them fails.
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
type Entries = Readonly<Record<string, Asset<any>>>;

/**
 * What a bundle is once loaded: each asset under its name.
 *
 * @category Type-level
 */
export type Loaded<B extends Entries> = {
  readonly [K in keyof B]: B[K] extends Asset<infer A> ? A : never;
};

/**
 * What an app holds of a bundle at the moment.
 *
 * @category Models
 */
export type Status<A> =
  /** Nobody has asked for it. */
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly assets: A }
  /**
   * It could not be loaded, which is logged once. Nothing is kept of what
   * did load, and it is tried again when it is next asked for afresh.
   */
  | { readonly _tag: "Failed"; readonly error: AssetFailed };

const ABSENT: Status<never> = { _tag: "Absent" };
const LOADING: Status<never> = { _tag: "Loading" };

/**
 * Assets that are loaded together and let go together: a level's, a
 * menu's. It is an Effect, so in a system of the frame stage or the input
 * stage `yield*` gives what the app holds of it now.
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
 * Names assets that belong together. The name is what the app calls the
 * bundle in its log, and what the system that loads it is named after, so
 * prefix it with the feature it belongs to.
 *
 * @category Constructors
 */
export const bundle = <B extends Entries>(name: string, assets: B): Bundle<B> =>
  new Bundle(name, assets);

/**
 * Loads a bundle into the scope it is run in: every asset at once, and all
 * of them let go when that scope closes. It fails with the first asset
 * that does, giving up the rest.
 *
 *   const level = Effect.scoped(Effect.gen(function*() {
 *     const { layout } = yield* Assets.load(Forest)
 *     ...
 *   }))                                   // let go here
 *
 * It waits in real time, so it is for the entry point and for a plugin's
 * `layer`, which is built before the game starts and holds what it loads
 * for as long as the app:
 *
 *   Layer.effect(Fonts, Assets.load(Common))
 *
 * **Gotchas**
 *
 * It is not for a system or a script, and nothing refuses it there: a
 * script that loads resumes in whatever tick the file arrives in, and a
 * replay of it fetches the file again.
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
 * An app's store of bundles. All three are for the stages between ticks,
 * the frame stage and the input stage: in the tick each throws, since what
 * is loaded, and when, is no part of the game.
 *
 * @category Services
 */
export interface StoreShape {
  /** What the app holds of a bundle now. */
  readonly status: <B extends Entries>(bundle: Bundle<B>) => Status<Loaded<B>>;
  /**
   * `holder` wants the bundle. The first to want it starts it loading, in
   * a scope of its own.
   */
  readonly hold: (bundle: Bundle<Entries>, holder: string) => void;
  /**
   * `holder` no longer wants it. When nobody does, its scope closes: what
   * was loaded is let go, and what was still loading is given up.
   */
  readonly drop: (bundle: Bundle<Entries>, holder: string) => void;
}

/**
 * The bundles an app has loaded. `Assets.plugin` provides it,
 * `Assets.during` works it, and `yield*` on a bundle reads it. A system of
 * the game's own, in the frame stage or the input stage, keeps a bundle
 * with it too: the bundle stays loaded while anyone holds it.
 *
 *   const store = yield* Assets.Store
 *   store.hold(Forest, "game/Map")    // loading from now, if nobody held it
 *   store.drop(Forest, "game/Map")    // let go, if nobody else holds it
 *
 * A load is given what the app was given from outside and none of the
 * app's own services, so nothing it does is the game's doing: the random
 * numbers a loader draws, to wait a while before it tries again, are not
 * the world's.
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
      const scope = Effect.runSync(Scope.make());
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

    /** Gives up what is loading, and lets go of what was loaded. */
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
 * Gives an app a store for the bundles it loads. A plugin whose systems
 * use `Assets.during`, or read a bundle, lists it in `plugins`.
 *
 * Whatever is still loaded when the app's scope closes is let go with it.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Assets", { layer: storeLayer });

/**
 * A system that keeps a bundle loaded while a condition holds:
 *
 *   Assets.during(State.is(Level, "forest"), Forest)
 *
 * The condition is one of `System.runIf`'s: an Effect that gives a
 * boolean. From the frame after it starts to hold, the bundle is loading,
 * in a scope of its own. From the frame after it stops, that scope is
 * closed: what was loaded is let go, and what was still loading is given
 * up. So a level's assets are there for as long as the level, and leaving
 * it frees them.
 *
 * It is a system of a frame, since assets are for what draws the game: a
 * replay or a server, which run no frame, load nothing. Of a frame's three
 * stages it is in the first, `"preFrame"`, so every system that draws with
 * the bundle finds it as it is in that frame, wherever the two are listed.
 * One per bundle; to keep a bundle for several states, give a condition
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
