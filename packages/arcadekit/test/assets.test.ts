import {
  Cause,
  Context,
  Effect,
  Random as EffectRandom,
  Exit,
  Layer,
  Logger,
  Option,
  Schema,
  Scope,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Action,
  App,
  Assets,
  Commands,
  Component,
  Driver,
  Events,
  Field,
  Frame,
  Input,
  Plugin,
  Query,
  Random,
  Save,
  Script,
  Singleton,
  State,
  System,
  Time,
  World,
} from "../src/index";

const Layout = Schema.Struct({
  walls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: Schema.String,
});

/** No logger: a test that makes a load fail on purpose says nothing. */
const quiet = Logger.layer([]);

/** Lets what is waiting on a promise or a timer run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** An asset that says when it is made and when it is let go. */
const tracked = (url: string, log: string[]) =>
  Assets.make(url, (bytes, at) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        log.push(`open ${at}`);
        return { at, size: bytes.length };
      }),
      (made) => Effect.sync(() => log.push(`close ${made.at}`))
    )
  );

/** An asset failed, at this URL and for this reason. */
const expectFailed = (error: unknown, url: string, message: string): void => {
  expect(error).toBeInstanceOf(Assets.AssetFailed);
  expect(error).toEqual(new Assets.AssetFailed({ url, message }));
};

const files = {
  "/forest.png": new Uint8Array([1, 2, 3]),
  "/forest.json": '{"walls":3,"name":"Forest"}',
  "/cave.png": new Uint8Array([4, 5]),
  "/notes.txt": "héllo",
};

/** A loader whose files arrive when the test says so. */
const makeSlowLoader = () => {
  const waiting = new Map<
    string,
    {
      readonly arrive: (bytes: Uint8Array) => void;
      readonly fail: (message: string) => void;
    }
  >();
  const asked: string[] = [];
  const givenUp: string[] = [];
  const loader: Assets.LoaderShape = {
    bytes: (url) =>
      Effect.callback<Uint8Array, Assets.AssetFailed>((resume) => {
        asked.push(url);
        waiting.set(url, {
          arrive: (bytes) => resume(Effect.succeed(bytes)),
          fail: (message) =>
            resume(Effect.fail(new Assets.AssetFailed({ url, message }))),
        });
        return Effect.sync(() => {
          givenUp.push(url);
        });
      }),
  };
  return { asked, givenUp, loader, waiting };
};

/** A game of levels, each with assets of its own. */
const makeGame = () => {
  const log: string[] = [];
  const Level = State.define("as/Level", ["menu", "forest", "cave"]);
  const Forest = Assets.bundle("as/Forest", {
    backdrop: tracked("/forest.png", log),
    layout: Assets.json("/forest.json", Layout),
  });
  const Cave = Assets.bundle("as/Cave", {
    backdrop: tracked("/cave.png", log),
  });
  const Go = Action.define(
    "as/Go",
    Schema.Struct({ to: Schema.Literals(["menu", "forest", "cave"]) })
  );
  const go = Action.handler(Go, function* ({ to }) {
    (yield* Level).set(to);
  });
  const drawn: string[] = [];
  const Draw = System.make("Draw", function* () {
    const forest = yield* Forest;
    const cave = yield* Cave;
    drawn.push(
      `${(yield* Level).value}: forest ${forest._tag}${forest._tag === "Ready" ? ` (${forest.assets.layout.name}, ${forest.assets.backdrop.size} bytes)` : ""}, cave ${cave._tag}`
    );
  }).pipe(System.inStage("frame"));
  const Game = Plugin.make("Game", {
    plugins: [Assets.plugin],
    components: [Level],
    handlers: [go],
    systems: [
      Assets.during(State.is(Level, "forest"), Forest),
      Assets.during(State.is(Level, "cave"), Cave),
      Draw,
    ],
  });
  return { Cave, Forest, Game, Go, Level, drawn, log };
};

describe("a failure, in these tests", () => {
  it("is not equal to one that differs only in its reason, which toEqual alone would not see", () => {
    // scripts/vitest-setup.ts sees to it: without it the first of these
    // passes whatever the two messages are.
    const failed = (url: string, message: string) =>
      new Assets.AssetFailed({ url, message });
    expect(failed("/a", "It is not there.")).not.toEqual(
      failed("/a", "It is not JSON.")
    );
    expect(failed("/a", "It is not there.")).not.toEqual(
      failed("/b", "It is not there.")
    );
    expect(failed("/a", "It is not there.")).toEqual(
      failed("/a", "It is not there.")
    );
    expect({ error: failed("/a", "one") }).not.toEqual({
      error: failed("/a", "two"),
    });
    // An error that is not one of Effect's, the same.
    expect(new Error("one")).not.toEqual(new Error("two"));
    expect(new Error("one")).toEqual(new Error("one"));
  });
});

describe("an asset", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is loaded into a scope, and let go when the scope closes", async () => {
    const log: string[] = [];
    const Forest = Assets.bundle("as/Forest", {
      backdrop: tracked("/forest.png", log),
      layout: Assets.json("/forest.json", Layout),
      notes: Assets.text("/notes.txt"),
      raw: Assets.bytes("/cave.png"),
    });
    const scope = Effect.runSync(Scope.make());
    const loaded = await Effect.runPromise(
      Assets.load(Forest).pipe(
        Scope.provide(scope),
        Effect.provide(Assets.layerMemory(files))
      )
    );
    expect(loaded).toEqual({
      backdrop: { at: "/forest.png", size: 3 },
      layout: { walls: 3, name: "Forest" },
      notes: "héllo",
      raw: new Uint8Array([4, 5]),
    });
    // The compiler knows what each is.
    const walls: number = loaded.layout.walls;
    const notes: string = loaded.notes;
    void [walls, notes];
    expect(log).toEqual(["open /forest.png"]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(log).toEqual(["open /forest.png", "close /forest.png"]);

    // With Effect.scoped, the scope is the block.
    log.length = 0;
    const size = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { backdrop } = yield* Assets.load(Forest);
          expect(log).toEqual(["open /forest.png"]);
          return backdrop.size;
        })
      ).pipe(Effect.provide(Assets.layerMemory(files)))
    );
    expect(size).toBe(3);
    expect(log).toEqual(["open /forest.png", "close /forest.png"]);
  });

  it("fails with the asset that could not be loaded, and what the others made is let go with the scope", async () => {
    const log: string[] = [];
    const Broken = Assets.bundle("as/Broken", {
      backdrop: tracked("/forest.png", log),
      missing: tracked("/nowhere.png", log),
    });
    const exit = await Effect.runPromise(
      Effect.exit(Effect.scoped(Assets.load(Broken))).pipe(
        Effect.provide(Assets.layerMemory(files))
      )
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Cause.squash((exit as Exit.Failure<never, unknown>).cause);
    expectFailed(error, "/nowhere.png", "There is no such file.");
    // Nothing that was made is left.
    expect(log.filter((line) => line.startsWith("open")).length).toBe(
      log.filter((line) => line.startsWith("close")).length
    );
    expect(log.includes("open /nowhere.png")).toBe(false);
    // A file is one that was given, not a word every object knows.
    const inherited = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Assets.load(
            Assets.bundle("as/Odd", { file: Assets.bytes("toString") })
          )
        )
      ).pipe(Effect.provide(Assets.layerMemory(files)))
    );
    expectFailed(
      Cause.squash((inherited as Exit.Failure<never, unknown>).cause),
      "toString",
      "There is no such file."
    );
  });

  it("is checked against its schema, since it comes from outside", async () => {
    const tryLoad = (file: string | Uint8Array) =>
      Effect.runPromise(
        Effect.exit(
          Effect.scoped(
            Assets.load(
              Assets.bundle("as/One", {
                layout: Assets.json("/layout.json", Layout),
              })
            )
          )
        ).pipe(Effect.provide(Assets.layerMemory({ "/layout.json": file })))
      );
    const failure = async (file: string | Uint8Array) => {
      const exit = await tryLoad(file);
      expect(Exit.isFailure(exit)).toBe(true);
      return Cause.squash(
        (exit as Exit.Failure<never, unknown>).cause
      ) as Assets.AssetFailed;
    };
    expect(await tryLoad('{"walls":2,"name":"Ok"}')).toEqual(
      Exit.succeed({ layout: { walls: 2, name: "Ok" } })
    );
    const notJson = await failure("<html>");
    expect(notJson).toBeInstanceOf(Assets.AssetFailed);
    expect(notJson.url).toBe("/layout.json");
    expect(notJson.message).toMatch(/^It is not JSON/);
    const wrongShape = await failure('{"walls":-1,"name":"Bad"}');
    expect(wrongShape).toBeInstanceOf(Assets.AssetFailed);
    expect(wrongShape.url).toBe("/layout.json");
    expect(wrongShape.message).not.toMatch(/^It is not JSON/);
    expect((await failure('{"walls":2}')).url).toBe("/layout.json");
    // Text has to be text.
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Assets.load(
            Assets.bundle("as/Text", { notes: Assets.text("/notes.txt") })
          )
        )
      ).pipe(
        Effect.provide(
          Assets.layerMemory({ "/notes.txt": new Uint8Array([0xff, 0xfe]) })
        )
      )
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      (
        Cause.squash(
          (exit as Exit.Failure<never, unknown>).cause
        ) as Assets.AssetFailed
      ).message
    ).toMatch(/^It is not text/);
  });

  it("comes by fetch unless told otherwise, and an interrupted load gives the request up", async () => {
    const requests: { url: string; signal: AbortSignal }[] = [];
    const answers = new Map<string, () => Response>([
      ["/notes.txt", () => new Response("fetched")],
      [
        "/gone.txt",
        () => new Response("no", { status: 404, statusText: "Not Found" }),
      ],
    ]);
    vi.stubGlobal("fetch", (url: string, init: { signal: AbortSignal }) => {
      requests.push({ url, signal: init.signal });
      const answer = answers.get(url);
      return answer === undefined
        ? new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new Error("aborted"))
            );
          })
        : Promise.resolve(answer());
    });
    const one = (url: string) =>
      Effect.scoped(
        Assets.load(Assets.bundle("as/Fetched", { file: Assets.text(url) }))
      );
    expect(await Effect.runPromise(one("/notes.txt"))).toEqual({
      file: "fetched",
    });
    const gone = await Effect.runPromise(Effect.exit(one("/gone.txt")));
    expectFailed(
      Cause.squash((gone as Exit.Failure<never, unknown>).cause),
      "/gone.txt",
      "The server answered 404 Not Found"
    );
    // A request that never answers, and a load that is interrupted.
    const fiber = Effect.runFork(one("/slow.txt"));
    await settle();
    expect(requests.at(-1)!.url).toBe("/slow.txt");
    expect(requests.at(-1)!.signal.aborted).toBe(false);
    fiber.interruptUnsafe();
    await settle();
    expect(requests.at(-1)!.signal.aborted).toBe(true);
  });
});

describe("a level's assets", () => {
  it("are loaded when the level starts, and freed when the game leaves it", async () => {
    const { Game, Go, drawn, log } = makeGame();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({ plugins: [Game] });
          const frame = (): string => {
            app.frame(0);
            return drawn.at(-1)!;
          };
          app.tick(1);
          expect(frame()).toBe("menu: forest Absent, cave Absent");
          expect(log).toEqual([]);

          // The game enters the forest: its assets are loaded.
          app.dispatch(Go, { to: "forest" });
          expect(frame()).toBe("menu: forest Absent, cave Absent");
          app.tick(1);
          expect(frame()).toBe(
            "forest: forest Ready (Forest, 3 bytes), cave Absent"
          );
          expect(log).toEqual(["open /forest.png"]);
          // They stay for as long as it does, loaded once.
          app.tick(1);
          frame();
          frame();
          expect(log).toEqual(["open /forest.png"]);

          // It leaves for the cave: the forest's are freed, the cave's loaded.
          app.dispatch(Go, { to: "cave" });
          app.tick(1);
          expect(frame()).toBe("cave: forest Absent, cave Ready");
          expect(log).toEqual([
            "open /forest.png",
            "close /forest.png",
            "open /cave.png",
          ]);

          // Back to the menu: nothing is left loaded.
          app.dispatch(Go, { to: "menu" });
          app.tick(1);
          expect(frame()).toBe("menu: forest Absent, cave Absent");
          expect(log).toEqual([
            "open /forest.png",
            "close /forest.png",
            "open /cave.png",
            "close /cave.png",
          ]);

          // And a level entered again is loaded again.
          app.dispatch(Go, { to: "forest" });
          app.tick(1);
          expect(frame()).toBe(
            "forest: forest Ready (Forest, 3 bytes), cave Absent"
          );
          expect(log.at(-1)).toBe("open /forest.png");
        })
      ).pipe(Effect.provide(Assets.layerMemory(files)))
    );
    // The app's scope has closed: what was still loaded went with it.
    expect(log.at(-1)).toBe("close /forest.png");
    expect(log.filter((line) => line.startsWith("open")).length).toBe(
      log.filter((line) => line.startsWith("close")).length
    );
  });

  it("are there, or gone, for every system of the frame they come or go in, wherever the system that keeps them is listed", async () => {
    const log: string[] = [];
    const Level = State.define("as/Order", ["menu", "forest"]);
    const Forest = Assets.bundle("as/Ordered", {
      backdrop: tracked("/forest.png", log),
    });
    const seen: string[] = [];
    const Draw = System.make("Draw", function* () {
      seen.push((yield* Forest)._tag);
    }).pipe(System.inStage("frame"));
    const Keep = Assets.during(State.is(Level, "forest"), Forest);
    // It is of the stage before a frame's own.
    expect(Keep.stage).toBe("preFrame");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({
            components: [Level],
            plugins: [Assets.plugin],
            // Listed after what draws with the bundle.
            systems: [Draw, Keep],
          });
          expect(app.frameOrder).toEqual(["Assets.during(as/Ordered)", "Draw"]);
          const go = (to: "menu" | "forest"): void => {
            app.spawnScript(Effect.map(Level, (level) => level.set(to)));
            app.tick(1);
            app.frame(0);
          };
          app.frame(0);
          go("forest");
          go("menu");
          expect(seen).toEqual(["Absent", "Ready", "Absent"]);
          expect(log).toEqual(["open /forest.png", "close /forest.png"]);
        })
      ).pipe(Effect.provide(Assets.layerMemory(files)))
    );
  });

  it("take the time they take, and are given up if the game leaves first", async () => {
    const { Game, Go, drawn, log } = makeGame();
    const slow = makeSlowLoader();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({ plugins: [Game] });
          const frame = (): string => {
            app.frame(0);
            return drawn.at(-1)!;
          };
          app.dispatch(Go, { to: "forest" });
          app.tick(1);
          expect(frame()).toBe("forest: forest Loading, cave Absent");
          expect(slow.asked.toSorted()).toEqual([
            "/forest.json",
            "/forest.png",
          ]);
          // The game goes on while they load.
          app.tick(1);
          app.tick(1);
          expect(frame()).toBe("forest: forest Loading, cave Absent");
          slow.waiting.get("/forest.png")!.arrive(new Uint8Array(7));
          yield* Effect.promise(settle);
          expect(frame()).toBe("forest: forest Loading, cave Absent");
          slow.waiting
            .get("/forest.json")!
            .arrive(new TextEncoder().encode('{"walls":1,"name":"Slow"}'));
          yield* Effect.promise(settle);
          expect(frame()).toBe(
            "forest: forest Ready (Slow, 7 bytes), cave Absent"
          );
          expect(slow.asked.length).toBe(2);

          // The cave starts loading, and the game leaves before it has.
          app.dispatch(Go, { to: "cave" });
          app.tick(1);
          expect(frame()).toBe("cave: forest Absent, cave Loading");
          app.dispatch(Go, { to: "menu" });
          app.tick(1);
          expect(frame()).toBe("menu: forest Absent, cave Absent");
          yield* Effect.promise(settle);
          expect(slow.givenUp).toEqual(["/cave.png"]);
          // Arriving late, it is nobody's.
          slow.waiting.get("/cave.png")!.arrive(new Uint8Array(1));
          yield* Effect.promise(settle);
          expect(frame()).toBe("menu: forest Absent, cave Absent");
          expect(log).toEqual(["open /forest.png", "close /forest.png"]);
        })
      ).pipe(Effect.provideService(Assets.Loader, slow.loader))
    );
  });

  it("say so when they cannot be loaded, keep nothing of what did load, and are tried again", async () => {
    const { Forest, Game, Go, drawn, log } = makeGame();
    const slow = makeSlowLoader();
    const logged: unknown[] = [];
    const errors: Assets.AssetFailed[] = [];
    const Peek = System.make("Peek", function* () {
      const forest = yield* Forest;
      if (forest._tag === "Failed") {
        errors.push(forest.error);
      }
    }).pipe(System.inStage("frame"));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({ plugins: [Game], systems: [Peek] });
          const frame = (): string => {
            app.frame(0);
            return drawn.at(-1)!;
          };
          app.dispatch(Go, { to: "forest" });
          app.tick(1);
          frame();
          slow.waiting.get("/forest.png")!.arrive(new Uint8Array(2));
          yield* Effect.promise(settle);
          expect(log).toEqual(["open /forest.png"]);
          slow.waiting.get("/forest.json")!.fail("The disk is full.");
          yield* Effect.promise(settle);
          expect(frame()).toBe("forest: forest Failed, cave Absent");
          expectFailed(errors.at(-1), "/forest.json", "The disk is full.");
          // The picture that did load is let go at once.
          expect(log).toEqual(["open /forest.png", "close /forest.png"]);
          // It is said once, through the app's loggers.
          expect(logged.length).toBe(1);
          expect(String(logged[0])).toMatch(
            /The assets "as\/Forest" could not be loaded/
          );
          // It stays failed, and is not asked for again while the level lasts.
          frame();
          frame();
          expect(slow.asked.length).toBe(2);
          // Left and entered again, it is tried again.
          app.dispatch(Go, { to: "menu" });
          app.tick(1);
          expect(frame()).toBe("menu: forest Absent, cave Absent");
          app.dispatch(Go, { to: "forest" });
          app.tick(1);
          expect(frame()).toBe("forest: forest Loading, cave Absent");
          expect(slow.asked.length).toBe(4);
        })
      ).pipe(
        Effect.provideService(Assets.Loader, slow.loader),
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              logged.push(options.message);
            }),
          ])
        )
      )
    );
  });

  it("go with the app's scope, loaded or still loading", async () => {
    const { Game, Go, log } = makeGame();
    const slow = makeSlowLoader();
    const scope = Effect.runSync(Scope.make());
    const app = await Effect.runPromise(
      App.make({ plugins: [Game] }).pipe(
        Scope.provide(scope),
        Effect.provideService(Assets.Loader, slow.loader)
      )
    );
    app.dispatch(Go, { to: "forest" });
    app.tick(1);
    app.frame(0);
    slow.waiting.get("/forest.png")!.arrive(new Uint8Array(2));
    await settle();
    expect(log).toEqual(["open /forest.png"]);
    expect(slow.givenUp).toEqual([]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    // The file that had not arrived is given up, and the one that had is let go.
    expect(slow.givenUp).toEqual(["/forest.json"]);
    expect(log).toEqual(["open /forest.png", "close /forest.png"]);
  });

  it("are no part of the simulation: a game that never draws loads nothing and is the same game", async () => {
    const drawnGame = makeGame();
    const bare = makeGame();
    let asked = 0;
    const counting: Assets.LoaderShape = {
      bytes: () => {
        asked++;
        return Effect.succeed(new Uint8Array(1));
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seen = yield* App.make({
            plugins: [drawnGame.Game],
            checkpointEvery: 1,
          }).pipe(Effect.provide(Assets.layerMemory(files)));
          const unseen = yield* App.make({
            plugins: [bare.Game],
            checkpointEvery: 1,
          }).pipe(Effect.provideService(Assets.Loader, counting));
          for (const to of ["forest", "cave", "menu"] as const) {
            seen.dispatch(drawnGame.Go, { to });
            unseen.dispatch(bare.Go, { to });
            seen.tick(1);
            seen.frame(0);
            unseen.tick(1);
            expect(seen.world.hash()).toBe(unseen.world.hash());
          }
          expect(asked).toBe(0);
          expect(bare.log).toEqual([]);
          expect(drawnGame.log.length).toBe(4);
          // The log of one replays in the other, which has no files.
          const again = yield* App.make({
            plugins: [bare.Game],
            checkpointEvery: 1,
          }).pipe(Effect.provideService(Assets.Loader, counting));
          App.replay(again, seen.actionLog, { delta: 1, ticks: 3 });
          expect(again.world.hash()).toBe(seen.world.hash());
          expect(asked).toBe(0);
        })
      )
    );
  });

  it("are loaded with none of the game's own services: nothing a loader draws or reaches is the world's", async () => {
    const drawnGame = makeGame();
    const bare = makeGame();
    const reached: string[] = [];
    const services = {
      World,
      Time,
      Frame,
      Commands,
      Script,
      Events,
      Random,
      Actions: Action.Actions,
      Devices: Input.Devices,
    };
    // A loader that draws random numbers, as one that waits a random while
    // before it tries again does, and looks for what the app provides.
    const loader: Assets.LoaderShape = {
      bytes: () =>
        Effect.gen(function* () {
          yield* EffectRandom.next;
          for (const [name, key] of Object.entries(services)) {
            const found = yield* Effect.serviceOption(
              key as Context.Key<unknown, unknown>
            );
            if (Option.isSome(found)) {
              reached.push(name);
            }
          }
          yield* Effect.promise(settle);
          yield* EffectRandom.next;
          return new TextEncoder().encode('{"walls":1,"name":"Drawn"}');
        }),
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const seen = yield* App.make({ plugins: [drawnGame.Game], seed: 3 });
          const unseen = yield* App.make({ plugins: [bare.Game], seed: 3 });
          for (const app of [seen, unseen]) {
            app.dispatch(app === seen ? drawnGame.Go : bare.Go, {
              to: "forest",
            });
            app.tick(1);
          }
          // The loader draws at once, while the frame stage is running:
          // not from the world, which is frozen and would say so.
          seen.frame(0);
          yield* Effect.promise(settle);
          yield* Effect.promise(settle);
          seen.frame(0);
          expect(drawnGame.drawn.at(-1)).toBe(
            "forest: forest Ready (Drawn, 26 bytes), cave Absent"
          );
          expect(reached).toEqual([]);
          // The game that loaded is the game that did not.
          expect(Array.from(seen.world.random.state)).toEqual(
            Array.from(unseen.world.random.state)
          );
          seen.tick(1);
          unseen.tick(1);
          expect(seen.world.hash()).toBe(unseen.world.hash());
        })
      ).pipe(Effect.provideService(Assets.Loader, loader))
    );
  });

  it("cannot be asked for in the tick, where a replay would have nothing to say", () => {
    const { Forest, Game } = makeGame();
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const Cheat = System.make("Cheat", function* () {
            yield* Forest;
          });
          const app = yield* App.make({ plugins: [Game], systems: [Cheat] });
          expect(() => app.tick(1)).toThrow(
            /The assets "as\/Forest" were asked for in the tick/
          );
          // A script is the simulation too.
          const other = yield* App.make({ plugins: [Game] }).pipe(
            Effect.provide(quiet)
          );
          const fiber = other.spawnScript(Forest.asEffect());
          const exit = fiber.pollUnsafe();
          expect(exit !== undefined && Exit.isFailure(exit)).toBe(true);
          // The store that keeps them is no way round: it says the same of
          // being asked, and of being told to load or to let go.
          const calls: Record<string, (store: Assets.StoreShape) => unknown> = {
            "asked for": (store) => store.status(Forest),
            held: (store) => store.hold(Forest, "Sneak"),
            "let go of": (store) => store.drop(Forest, "Sneak"),
          };
          let asked = 0;
          for (const [what, call] of Object.entries(calls)) {
            const Sneak = System.make("Sneak", function* () {
              call(yield* Assets.Store);
            });
            const sneaking = yield* App.make({
              plugins: [Game],
              systems: [Sneak],
            }).pipe(
              Effect.provideService(Assets.Loader, {
                bytes: () => {
                  asked++;
                  return Effect.succeed(new Uint8Array(1));
                },
              })
            );
            expect(() => sneaking.tick(1), what).toThrow(
              new RegExp(`The assets "as/Forest" were ${what} in the tick`, "u")
            );
          }
          // Nothing was loaded on the way to being refused.
          expect(asked).toBe(0);
          // The input stage may ask, as the frame stage may.
          let status = "";
          const Ask = System.make("Ask", function* () {
            status = (yield* Forest)._tag;
          }).pipe(System.inStage("input"));
          const asking = yield* App.make({ plugins: [Game], systems: [Ask] });
          asking.input();
          expect(status).toBe("Absent");
        })
      ).pipe(Effect.provide(Assets.layerMemory(files)))
    );
  });

  it("reach the game as an action, issued once they are there, which a replay has without the file", async () => {
    const Wall = Component.define("as/Wall", { at: Field.i32 });
    const Built = Singleton.define(
      "as/Built",
      { level: Field.json<string>() },
      { level: "" }
    );
    const Level = State.define("as/Stage", ["menu", "forest"]);
    const Forest = Assets.bundle("as/ForestLayout", {
      layout: Assets.json("/forest.json", Layout),
    });
    const Enter = Action.define("as/Enter", Schema.Struct({}));
    const Build = Action.define("as/Build", Layout);
    const handlers = [
      Action.handler(Enter, function* () {
        (yield* Level).set("forest");
      }),
      Action.handler(Build, function* ({ name, walls }) {
        const commands = yield* Commands;
        for (let at = 0; at < walls; at++) {
          commands.spawn(Wall.of({ at }));
        }
        (yield* Built).level = name;
      }),
    ] as const;
    // What comes from a file comes in as an action, once the file is there.
    const Begin = System.make("Begin", function* () {
      const forest = yield* Forest;
      if (forest._tag === "Ready" && (yield* Built).level === "") {
        (yield* Action.Actions).enqueue(Build, forest.assets.layout);
      }
    }).pipe(System.inStage("input"));
    const Rules = Plugin.make("Rules", {
      components: [Wall, Built, Level],
      handlers,
    });
    const Shown = Plugin.make("Shown", {
      plugins: [Rules, Assets.plugin],
      systems: [Assets.during(State.is(Level, "forest"), Forest), Begin],
    });
    const slow = makeSlowLoader();
    const { hash, log, ticks } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({ plugins: [Shown], checkpointEvery: 1 });
          const step = Driver.fixedStep(app, { hz: 10 });
          step(0.1);
          app.dispatch(Enter, {});
          step(0.1);
          step(0.1);
          expect(app.world.view(Query.all(Wall)).count()).toBe(0);
          slow.waiting
            .get("/forest.json")!
            .arrive(new TextEncoder().encode('{"walls":4,"name":"Forest"}'));
          yield* Effect.promise(settle);
          step(0.1);
          expect(app.world.view(Query.all(Wall)).count()).toBe(4);
          step(0.1);
          step(0.1);
          // Issued once.
          expect(
            app.actionLog.filter(
              (entry) =>
                !Action.isCheckpoint(entry) && entry.name === "as/Build"
            )
          ).toEqual([
            {
              tick: 3,
              name: "as/Build",
              payload: { walls: 4, name: "Forest" },
              queued: true,
            },
          ]);
          return {
            hash: app.world.hash(),
            log: app.actionLog,
            ticks: app.time.tick,
          };
        })
      ).pipe(Effect.provideService(Assets.Loader, slow.loader))
    );
    // The replay has the rules and nothing that loads or draws.
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const again = yield* App.make({
            plugins: [Rules],
            checkpointEvery: 1,
          });
          App.replay(again, log, { delta: 0.1, ticks });
          expect(again.world.hash()).toBe(hash);
          expect(again.world.view(Query.all(Wall)).count()).toBe(4);
        })
      )
    );
  });

  it("are there again in a game that is loaded from a save", async () => {
    const { Game, Go, drawn, log } = makeGame();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({ plugins: [Game] });
          app.dispatch(Go, { to: "forest" });
          app.tick(1);
          app.frame(0);
          const save = app.save();
          expect(Exit.isSuccess(save)).toBe(true);
          const loaded = yield* App.load(
            (save as Exit.Success<Save.Save>).value,
            { plugins: [Game] }
          );
          drawn.length = 0;
          loaded.frame(0);
          expect(drawn).toEqual([
            "forest: forest Ready (Forest, 3 bytes), cave Absent",
          ]);
          // Each app holds its own.
          expect(log).toEqual(["open /forest.png", "open /forest.png"]);
        })
      ).pipe(Effect.provide(Assets.layerMemory(files)))
    );
  });

  it("are kept by one system per bundle, whose condition may hold in several states", async () => {
    const { Forest, Game, Go, Level } = makeGame();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // A second system for the same bundle is refused by its name.
          const twice = yield* Effect.exit(
            App.make({
              plugins: [Game],
              systems: [Assets.during(State.is(Level, "menu"), Forest)],
            })
          );
          expect(Exit.isFailure(twice)).toBe(true);
          expect(
            (Cause.squash((twice as Exit.Failure<never, never>).cause) as Error)
              .message
          ).toMatch(/Duplicate system name "Assets\.during\(as\/Forest\)"/);
          // Kept for two states by one condition that holds in both.
          const log: string[] = [];
          const Shared = Assets.bundle("as/Shared", {
            font: tracked("/cave.png", log),
          });
          const app = yield* App.make({
            plugins: [Game],
            systems: [Assets.during(State.is(Level, "forest", "cave"), Shared)],
          });
          for (const to of ["forest", "cave", "forest"] as const) {
            app.dispatch(Go, { to });
            app.tick(1);
            app.frame(0);
          }
          expect(log).toEqual(["open /cave.png"]);
          app.dispatch(Go, { to: "menu" });
          app.tick(1);
          app.frame(0);
          expect(log).toEqual(["open /cave.png", "close /cave.png"]);
        })
      ).pipe(Effect.provide(Assets.layerMemory(files)))
    );
  });

  it("stay while anyone holds them: a system of the game's own can keep a bundle the level has left", async () => {
    const { Forest, Game, Go, drawn, log } = makeGame();
    let keep = false;
    // Holds the forest while it is told to, whatever the level.
    const Keep = System.make("Keep", function* () {
      const store = yield* Assets.Store;
      if (keep) {
        store.hold(Forest, "Keep");
      } else {
        store.drop(Forest, "Keep");
      }
    }).pipe(System.inStage("frame"));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({ plugins: [Game], systems: [Keep] });
          const frame = (): string => {
            app.frame(0);
            return drawn.at(-1)!;
          };
          // Nobody holds it, and dropping what is not held does nothing.
          frame();
          frame();
          expect(log).toEqual([]);
          app.dispatch(Go, { to: "forest" });
          app.tick(1);
          frame();
          keep = true;
          frame();
          // Held twice, loaded once.
          expect(log).toEqual(["open /forest.png"]);
          app.dispatch(Go, { to: "menu" });
          app.tick(1);
          frame();
          frame();
          // The level has left it, and it is still held.
          expect(frame()).toBe(
            "menu: forest Ready (Forest, 3 bytes), cave Absent"
          );
          expect(log).toEqual(["open /forest.png"]);
          keep = false;
          // The frame that drops it has it still; it is gone by the next.
          frame();
          expect(frame()).toBe("menu: forest Absent, cave Absent");
          expect(log).toEqual(["open /forest.png", "close /forest.png"]);
        })
      ).pipe(Effect.provide(Assets.layerMemory(files)))
    );
  });

  it("fail as assets that could not be loaded when what makes them dies", async () => {
    const Level = State.define("as/Mode", ["on"]);
    const Cursed = Assets.bundle("as/Cursed", {
      one: Assets.make("/forest.png", () => Effect.die(new Error("boom"))),
    });
    let status: Assets.Status<unknown> | undefined;
    const Look = System.make("Look", function* () {
      status = yield* Cursed;
    }).pipe(System.inStage("frame"));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* App.make({
            plugins: [Assets.plugin],
            components: [Level],
            systems: [Assets.during(State.is(Level, "on"), Cursed), Look],
          });
          app.frame(0);
          expect(status?._tag).toBe("Failed");
          expectFailed((status as { error: unknown }).error, "", "boom");
        })
      ).pipe(Effect.provide(Assets.layerMemory(files)), Effect.provide(quiet))
    );
  });

  it("are held by a plugin's layer for as long as the app, when they are loaded there", async () => {
    const log: string[] = [];
    const Common = Assets.bundle("as/Common", {
      font: tracked("/forest.png", log),
    });
    class Fonts extends Context.Service<
      Fonts,
      Assets.Loaded<(typeof Common)["assets"]>
    >()("as/Fonts") {}
    const Ui = Plugin.make("Ui", {
      layer: Layer.effect(Fonts, Assets.load(Common)),
    });
    const scope = Effect.runSync(Scope.make());
    await Effect.runPromise(
      App.make({ plugins: [Ui] }).pipe(
        Scope.provide(scope),
        Effect.provide(Assets.layerMemory(files))
      )
    );
    expect(log).toEqual(["open /forest.png"]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(log).toEqual(["open /forest.png", "close /forest.png"]);
  });
});
