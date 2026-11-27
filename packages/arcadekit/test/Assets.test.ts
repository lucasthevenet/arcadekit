import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Random as EffectRandom,
  Exit,
  Layer,
  Logger,
  Option,
  Result,
  Schema,
  Scope,
} from "effect";

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
  Replay,
  Save,
  Singleton,
  State,
  System,
  Time,
  Timeline,
  World,
} from "../src/index.ts";
import { Session } from "../src/net/index.ts";

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
  expect(error).toBeInstanceOf(Assets.Failed);
  expect(error).toEqual(new Assets.Failed({ url, message }));
};

const files = {
  "/forest.png": new Uint8Array([1, 2, 3]),
  "/forest.json": '{"walls":3,"name":"Forest"}',
  "/cave.png": new Uint8Array([4, 5]),
  "/notes.txt": "héllo",
};

/** A file of `files`, as the loader `Assets.makeMemory` makes of them reads it. */
const fromMemory = (url: string) =>
  Effect.service(Assets.Loader).pipe(
    Effect.flatMap((loader) => loader.bytes(url)),
    Effect.provide(Assets.layer(Assets.makeMemory(files)))
  );

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
      Effect.callback<Uint8Array, Assets.Failed>((resume) => {
        asked.push(url);
        waiting.set(url, {
          arrive: (bytes) => resume(Effect.succeed(bytes)),
          fail: (message) =>
            resume(Effect.fail(new Assets.Failed({ url, message }))),
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
    (yield* Level.sets).set(to);
  });
  const drawn: string[] = [];
  const Draw = System.frame("Draw", function* () {
    const forest = yield* Forest;
    const cave = yield* Cave;
    drawn.push(
      `${(yield* Level).value}: forest ${forest._tag}${forest._tag === "Ready" ? ` (${forest.assets.layout.name}, ${forest.assets.backdrop.size} bytes)` : ""}, cave ${cave._tag}`
    );
  });
  const Game = Plugin.make("Game", {
    plugins: [Assets.plugin],
    handlers: [go],
    systems: [
      Assets.during(Forest).pipe(System.runIf(State.is(Level, "forest"))),
      Assets.during(Cave).pipe(System.runIf(State.is(Level, "cave"))),
      Draw,
    ],
  });
  return { Cave, Forest, Game, Go, Level, drawn, log };
};

describe("a failure, in these tests", () => {
  it("is not equal to one that differs only in its reason, which toEqual alone would not see", () => {
    // tooling/build/vitest-setup.ts sees to it: without it the first of these
    // passes whatever the two messages are.
    const failed = (url: string, message: string) =>
      new Assets.Failed({ url, message });
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

  it.effect("is loaded into a scope, and let go when the scope closes", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const Forest = Assets.bundle("as/Forest", {
        backdrop: tracked("/forest.png", log),
        layout: Assets.json("/forest.json", Layout),
        notes: Assets.text("/notes.txt"),
        raw: Assets.bytes("/cave.png"),
      });
      const scope = Scope.makeUnsafe();
      const loaded = yield* Assets.load(Forest).pipe(
        Scope.provide(scope),
        Effect.provide(Assets.layer(Assets.makeMemory(files)))
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
      yield* Scope.close(scope, Exit.void);
      expect(log).toEqual(["open /forest.png", "close /forest.png"]);

      // With Effect.scoped, the scope is the block.
      log.length = 0;
      const size = yield* Effect.scoped(
        Effect.gen(function* () {
          const { backdrop } = yield* Assets.load(Forest);
          expect(log).toEqual(["open /forest.png"]);
          return backdrop.size;
        })
      ).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
      expect(size).toBe(3);
      expect(log).toEqual(["open /forest.png", "close /forest.png"]);
    })
  );

  it.effect(
    "fails with the asset that could not be loaded, and what the others made is let go with the scope",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Broken = Assets.bundle("as/Broken", {
          backdrop: tracked("/forest.png", log),
          missing: tracked("/nowhere.png", log),
        });
        const exit = yield* Effect.exit(
          Effect.scoped(Assets.load(Broken))
        ).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
        expect(Exit.isFailure(exit)).toBe(true);
        const error = Cause.squash(
          (exit as Exit.Failure<never, unknown>).cause
        );
        expectFailed(error, "/nowhere.png", "There is no such file.");
        // Nothing that was made is left.
        expect(log.filter((line) => line.startsWith("open")).length).toBe(
          log.filter((line) => line.startsWith("close")).length
        );
        expect(log.includes("open /nowhere.png")).toBe(false);
        // A file is one that was given, not a word every object knows.
        const inherited = yield* Effect.exit(
          Effect.scoped(
            Assets.load(
              Assets.bundle("as/Odd", { file: Assets.bytes("toString") })
            )
          )
        ).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
        expectFailed(
          Cause.squash((inherited as Exit.Failure<never, unknown>).cause),
          "toString",
          "There is no such file."
        );
      })
  );

  it.effect("is checked against its schema, since it comes from outside", () =>
    Effect.gen(function* () {
      const tryLoad = (file: string | Uint8Array) =>
        Effect.exit(
          Effect.scoped(
            Assets.load(
              Assets.bundle("as/One", {
                layout: Assets.json("/layout.json", Layout),
              })
            )
          )
        ).pipe(
          Effect.provide(
            Assets.layer(Assets.makeMemory({ "/layout.json": file }))
          )
        );
      const failure = Effect.fnUntraced(function* (file: string | Uint8Array) {
        const exit = yield* tryLoad(file);
        expect(Exit.isFailure(exit)).toBe(true);
        return Option.getOrThrow(Exit.findErrorOption(exit));
      });
      expect(yield* tryLoad('{"walls":2,"name":"Ok"}')).toEqual(
        Exit.succeed({ layout: { walls: 2, name: "Ok" } })
      );
      const notJson = yield* failure("<html>");
      expect(notJson).toBeInstanceOf(Assets.Failed);
      expect(notJson.url).toBe("/layout.json");
      expect(notJson.message).toMatch(/^It is not JSON/);
      const wrongShape = yield* failure('{"walls":-1,"name":"Bad"}');
      expect(wrongShape).toBeInstanceOf(Assets.Failed);
      expect(wrongShape.url).toBe("/layout.json");
      expect(wrongShape.message).not.toMatch(/^It is not JSON/);
      expect((yield* failure('{"walls":2}')).url).toBe("/layout.json");
      // Text has to be text.
      const exit = yield* Effect.exit(
        Effect.scoped(
          Assets.load(
            Assets.bundle("as/Text", { notes: Assets.text("/notes.txt") })
          )
        )
      ).pipe(
        Effect.provide(
          Assets.layer(
            Assets.makeMemory({ "/notes.txt": new Uint8Array([0xff, 0xfe]) })
          )
        )
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Option.getOrThrow(Exit.findErrorOption(exit)).message).toMatch(
        /^It is not text/
      );
    })
  );

  it.effect(
    "comes by fetch unless told otherwise, and an interrupted load gives the request up",
    () =>
      Effect.gen(function* () {
        const requests: { url: string; signal: AbortSignal }[] = [];
        const answers = new Map<string, () => Response>([
          ["/notes.txt", () => new Response("fetched")],
          [
            "/gone.txt",
            () => new Response("no", { status: 404, statusText: "Not Found" }),
          ],
          ["/busy.txt", () => new Response("later", { status: 503 })],
          [
            "/cut.txt",
            () =>
              new Response(
                new ReadableStream({
                  pull: (controller) => controller.error(new Error("reset")),
                })
              ),
          ],
        ]);
        // A page asks for a file by its path, from where the page is.
        vi.stubGlobal("location", new URL("https://game.test/play/"));
        vi.stubGlobal("fetch", (asked: URL, init: { signal: AbortSignal }) => {
          const url = asked.pathname;
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
        expect(yield* one("/notes.txt")).toEqual({
          file: "fetched",
        });
        const gone = yield* Effect.exit(one("/gone.txt"));
        expectFailed(
          Cause.squash((gone as Exit.Failure<never, unknown>).cause),
          "/gone.txt",
          "The server answered 404"
        );
        // A server that failed may answer the next time, which one that said no
        // won't.
        const busy = yield* Effect.exit(one("/busy.txt"));
        expect(
          Cause.squash((busy as Exit.Failure<never, unknown>).cause)
        ).toEqual(
          new Assets.Failed({
            url: "/busy.txt",
            message: "The server answered 503",
            transient: true,
          })
        );
        // So may a file whose download was cut off.
        const cut = yield* Effect.exit(one("/cut.txt"));
        expect(Option.getOrThrow(Exit.findErrorOption(cut)).transient).toBe(
          true
        );
        // A request that never answers, and a load that is interrupted.
        const fiber = yield* Effect.forkChild(one("/slow.txt"), {
          startImmediately: true,
        });
        yield* Effect.promise(() => settle());
        expect(requests.at(-1)!.url).toBe("/slow.txt");
        expect(requests.at(-1)!.signal.aborted).toBe(false);
        fiber.interruptUnsafe();
        yield* Effect.promise(() => settle());
        expect(requests.at(-1)!.signal.aborted).toBe(true);
      })
  );
});

describe("a level's assets", () => {
  it.effect(
    "are loaded when the level starts, and freed when the game leaves it",
    () =>
      Effect.gen(function* () {
        const { Game, Go, drawn, log } = makeGame();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* Effect.acquireRelease(
              App.make(App.define({ plugins: [Game] })),
              (made) => made.close
            );
            const frame = Effect.fnUntraced(function* () {
              yield* app.frame();
              return drawn.at(-1)!;
            });
            yield* app.tick(1);
            expect(yield* frame()).toBe("menu: forest Absent, cave Absent");
            expect(log).toEqual([]);

            // The game enters the forest: its assets are loaded.
            yield* app.dispatch(Go, { to: "forest" });
            expect(yield* frame()).toBe("menu: forest Absent, cave Absent");
            yield* app.tick(1);
            expect(yield* frame()).toBe(
              "forest: forest Ready (Forest, 3 bytes), cave Absent"
            );
            expect(log).toEqual(["open /forest.png"]);
            // They stay for as long as it does, loaded once.
            yield* app.tick(1);
            yield* frame();
            yield* frame();
            expect(log).toEqual(["open /forest.png"]);

            // It leaves for the cave: the forest's are freed, the cave's loaded.
            yield* app.dispatch(Go, { to: "cave" });
            yield* app.tick(1);
            expect(yield* frame()).toBe("cave: forest Absent, cave Ready");
            expect(log).toEqual([
              "open /forest.png",
              "close /forest.png",
              "open /cave.png",
            ]);

            // Back to the menu: nothing is left loaded.
            yield* app.dispatch(Go, { to: "menu" });
            yield* app.tick(1);
            expect(yield* frame()).toBe("menu: forest Absent, cave Absent");
            expect(log).toEqual([
              "open /forest.png",
              "close /forest.png",
              "open /cave.png",
              "close /cave.png",
            ]);

            // And a level entered again is loaded again.
            yield* app.dispatch(Go, { to: "forest" });
            yield* app.tick(1);
            expect(yield* frame()).toBe(
              "forest: forest Ready (Forest, 3 bytes), cave Absent"
            );
            expect(log.at(-1)).toBe("open /forest.png");
          })
        ).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
        // The program's scope has closed the app: what was still loaded went
        // with it.
        expect(log.at(-1)).toBe("close /forest.png");
        expect(log.filter((line) => line.startsWith("open")).length).toBe(
          log.filter((line) => line.startsWith("close")).length
        );
      })
  );

  it.effect(
    "are there, or gone, for every system of the frame they come or go in, wherever the system that keeps them is listed",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const Level = State.define("as/Order", ["menu", "forest"]);
        const Forest = Assets.bundle("as/Ordered", {
          backdrop: tracked("/forest.png", log),
        });
        const seen: string[] = [];
        const Draw = System.frame("Draw", function* () {
          seen.push((yield* Forest)._tag);
        });
        const Keep = Assets.during(Forest).pipe(
          System.runIf(State.is(Level, "forest"))
        );
        const Visit = Action.define(
          "as/Visit",
          Schema.Struct({ to: Schema.Literals(["menu", "forest"]) })
        );
        const visit = Action.handler(Visit, function* ({ to }) {
          (yield* Level.sets).set(to);
        });
        // It is of the stage before a frame's own.
        expect(Keep.stage).toBe("preFrame");
        yield* Effect.gen(function* () {
          const app = yield* App.make(
            App.define({
              plugins: [Assets.plugin], // Listed after what draws with the bundle.
              systems: [Draw, Keep],
              handlers: [visit],
            })
          );
          expect(app.frameOrder).toEqual(["Assets.during(as/Ordered)", "Draw"]);
          const go = (to: "menu" | "forest") =>
            Effect.gen(function* () {
              yield* app.dispatch(Visit, { to });
              yield* app.tick(1);
              yield* app.frame();
            });
          yield* app.frame();
          yield* go("forest");
          yield* go("menu");
          expect(seen).toEqual(["Absent", "Ready", "Absent"]);
          expect(log).toEqual(["open /forest.png", "close /forest.png"]);
        }).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
      })
  );

  it.effect(
    "take the time they take, and are given up if the game leaves first",
    () =>
      Effect.gen(function* () {
        const { Game, Go, drawn, log } = makeGame();
        const slow = makeSlowLoader();
        yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Game] }));
          const frame = Effect.fnUntraced(function* () {
            yield* app.frame();
            return drawn.at(-1)!;
          });
          yield* app.dispatch(Go, { to: "forest" });
          yield* app.tick(1);
          expect(yield* frame()).toBe("forest: forest Loading, cave Absent");
          expect(slow.asked.toSorted()).toEqual([
            "/forest.json",
            "/forest.png",
          ]);
          // The game goes on while they load.
          yield* app.tick(1);
          yield* app.tick(1);
          expect(yield* frame()).toBe("forest: forest Loading, cave Absent");
          slow.waiting.get("/forest.png")!.arrive(new Uint8Array(7));
          yield* Effect.promise(settle);
          expect(yield* frame()).toBe("forest: forest Loading, cave Absent");
          slow.waiting
            .get("/forest.json")!
            .arrive(new TextEncoder().encode('{"walls":1,"name":"Slow"}'));
          yield* Effect.promise(settle);
          expect(yield* frame()).toBe(
            "forest: forest Ready (Slow, 7 bytes), cave Absent"
          );
          expect(slow.asked.length).toBe(2);

          // The cave starts loading, and the game leaves before it has.
          yield* app.dispatch(Go, { to: "cave" });
          yield* app.tick(1);
          expect(yield* frame()).toBe("cave: forest Absent, cave Loading");
          yield* app.dispatch(Go, { to: "menu" });
          yield* app.tick(1);
          expect(yield* frame()).toBe("menu: forest Absent, cave Absent");
          yield* Effect.promise(settle);
          expect(slow.givenUp).toEqual(["/cave.png"]);
          // Arriving late, it is nobody's.
          slow.waiting.get("/cave.png")!.arrive(new Uint8Array(1));
          yield* Effect.promise(settle);
          expect(yield* frame()).toBe("menu: forest Absent, cave Absent");
          expect(log).toEqual(["open /forest.png", "close /forest.png"]);
        }).pipe(Effect.provideService(Assets.Loader, slow.loader));
      })
  );

  it.effect(
    "say so when they cannot be loaded, keep nothing of what did load, and are tried again",
    () =>
      Effect.gen(function* () {
        const { Forest, Game, Go, drawn, log } = makeGame();
        const slow = makeSlowLoader();
        const logged: unknown[] = [];
        const errors: Assets.Failed[] = [];
        const Peek = System.frame("Peek", function* () {
          const forest = yield* Forest;
          if (forest._tag === "Failed") {
            errors.push(forest.error);
          }
        });
        yield* Effect.gen(function* () {
          const app = yield* App.make(
            App.define({ plugins: [Game], systems: [Peek] })
          );
          const frame = Effect.fnUntraced(function* () {
            yield* app.frame();
            return drawn.at(-1)!;
          });
          yield* app.dispatch(Go, { to: "forest" });
          yield* app.tick(1);
          yield* frame();
          slow.waiting.get("/forest.png")!.arrive(new Uint8Array(2));
          yield* Effect.promise(settle);
          expect(log).toEqual(["open /forest.png"]);
          slow.waiting.get("/forest.json")!.fail("The disk is full.");
          yield* Effect.promise(settle);
          expect(yield* frame()).toBe("forest: forest Failed, cave Absent");
          expectFailed(errors.at(-1), "/forest.json", "The disk is full.");
          // The picture that did load is let go at once.
          expect(log).toEqual(["open /forest.png", "close /forest.png"]);
          // It is said once, through the app's loggers.
          expect(logged.length).toBe(1);
          expect(String(logged[0])).toMatch(
            /The assets "as\/Forest" could not be loaded/
          );
          // It stays failed, and is not asked for again while the level lasts.
          yield* frame();
          yield* frame();
          expect(slow.asked.length).toBe(2);
          // Left and entered again, it is tried again.
          yield* app.dispatch(Go, { to: "menu" });
          yield* app.tick(1);
          expect(yield* frame()).toBe("menu: forest Absent, cave Absent");
          yield* app.dispatch(Go, { to: "forest" });
          yield* app.tick(1);
          expect(yield* frame()).toBe("forest: forest Loading, cave Absent");
          expect(slow.asked.length).toBe(4);
        }).pipe(
          Effect.provideService(Assets.Loader, slow.loader),
          Effect.provide(
            Logger.layer([
              Logger.make((options) => {
                logged.push(options.message);
              }),
            ])
          )
        );
      })
  );

  it.effect("go with the app when it is closed, loaded or still loading", () =>
    Effect.gen(function* () {
      const { Game, Go, log } = makeGame();
      const slow = makeSlowLoader();
      const app = yield* App.make(App.define({ plugins: [Game] })).pipe(
        Effect.provideService(Assets.Loader, slow.loader)
      );
      yield* app.dispatch(Go, { to: "forest" });
      yield* app.tick(1);
      yield* app.frame();
      slow.waiting.get("/forest.png")!.arrive(new Uint8Array(2));
      yield* Effect.promise(() => settle());
      expect(log).toEqual(["open /forest.png"]);
      expect(slow.givenUp).toEqual([]);
      yield* app.close;
      // The file that had not arrived is given up, and the one that had is let go.
      expect(slow.givenUp).toEqual(["/forest.json"]);
      expect(log).toEqual(["open /forest.png", "close /forest.png"]);
    })
  );

  it.effect(
    "are no part of the simulation: a game that never draws loads nothing and is the same game",
    () =>
      Effect.gen(function* () {
        const drawnGame = makeGame();
        const bare = makeGame();
        let asked = 0;
        const counting: Assets.LoaderShape = {
          bytes: () => {
            asked++;
            return Effect.succeed(new Uint8Array(1));
          },
        };
        const seen = yield* App.make(
          App.define({ plugins: [drawnGame.Game] }),
          { hashEvery: 1 }
        ).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
        const unseen = yield* App.make(App.define({ plugins: [bare.Game] }), {
          hashEvery: 1,
        }).pipe(Effect.provideService(Assets.Loader, counting));
        for (const to of ["forest", "cave", "menu"] as const) {
          yield* seen.dispatch(drawnGame.Go, { to });
          yield* unseen.dispatch(bare.Go, { to });
          yield* seen.tick(1);
          yield* seen.frame();
          yield* unseen.tick(1);
          expect((yield* seen.read(World)).hash()).toBe(
            (yield* unseen.read(World)).hash()
          );
        }
        expect(asked).toBe(0);
        expect(bare.log).toEqual([]);
        expect(drawnGame.log.length).toBe(4);
        // The log of one replays in the other, which has no files.
        const played = yield* Replay.record(seen);
        const again = yield* Replay.verify(
          played,
          App.define({ plugins: [bare.Game] }),
          { hashEvery: 1 }
        ).pipe(Effect.provideService(Assets.Loader, counting));
        expect((yield* again.read(World)).hash()).toBe(
          (yield* seen.read(World)).hash()
        );
        expect(asked).toBe(0);
      })
  );

  it.effect(
    "are loaded with none of the game's own services: nothing a loader draws or reaches is the world's",
    () =>
      Effect.gen(function* () {
        const drawnGame = makeGame();
        const bare = makeGame();
        const reached: string[] = [];
        const services = {
          World,
          Time,
          Frame,
          Commands,
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
        yield* Effect.gen(function* () {
          const seen = yield* App.make(
            App.define({ plugins: [drawnGame.Game] }),
            { seed: 3 }
          );
          const unseen = yield* App.make(App.define({ plugins: [bare.Game] }), {
            seed: 3,
          });
          for (const app of [seen, unseen]) {
            yield* app.dispatch(app === seen ? drawnGame.Go : bare.Go, {
              to: "forest",
            });
            yield* app.tick(1);
          }
          // The loader draws at once, while the frame stage is running:
          // not from the world, which is frozen and would say so.
          yield* seen.frame();
          yield* Effect.promise(settle);
          yield* Effect.promise(settle);
          yield* seen.frame();
          expect(drawnGame.drawn.at(-1)).toBe(
            "forest: forest Ready (Drawn, 26 bytes), cave Absent"
          );
          expect(reached).toEqual([]);
          // The game that loaded is the game that did not, its random
          // numbers among the rest.
          const seenWorld = yield* seen.read(World);
          const unseenWorld = yield* unseen.read(World);
          expect(seenWorld.hash()).toBe(unseenWorld.hash());
          yield* seen.tick(1);
          yield* unseen.tick(1);
          expect(seenWorld.hash()).toBe(unseenWorld.hash());
        }).pipe(Effect.provideService(Assets.Loader, loader));
      })
  );

  it.effect(
    "cannot be asked for in the tick, where a replay would have nothing to say",
    () =>
      Effect.gen(function* () {
        const { Forest, Game } = makeGame();
        // Nor loaded by any system: the only scope there is the app's, which
        // would keep what each frame loaded until the app closed.
        System.tick(
          "Reload",
          // @ts-expect-error a tick has no scope
          function* () {
            yield* Assets.load(Forest);
          }
        );
        System.frame(
          "Reload",
          // @ts-expect-error a frame has no scope
          function* () {
            yield* Assets.load(Forest);
          }
        );
        System.input(
          "Reload",
          // @ts-expect-error an input system has no scope
          function* () {
            yield* Assets.load(Forest);
          }
        );
        System.tick(
          "Cheat",
          // @ts-expect-error assets are real time
          function* () {
            yield* Forest;
          }
        );
        System.tick(
          "Sneak",
          // @ts-expect-error the store of assets is real time
          function* () {
            yield* Assets.Store;
          }
        );
        yield* Effect.gen(function* () {
          // The input stage may ask, as the frame stage may.
          let status = "";
          const Ask = System.input("Ask", function* () {
            status = (yield* Forest)._tag;
          });
          const asking = yield* App.make(
            App.define({ plugins: [Game], systems: [Ask] })
          );
          yield* asking.input();
          expect(status).toBe("Absent");
        }).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
      })
  );

  it.effect(
    "reach the game as an action, issued once they are there, which a replay has without the file",
    () =>
      Effect.gen(function* () {
        const Wall = Component.define("as/Wall", { at: Field.i32 });
        const Built = Singleton.define(
          "as/Built",
          { level: Field.json<string>("") },
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
            (yield* Level.sets).set("forest");
          }),
          Action.handler(Build, function* ({ name, walls }) {
            const commands = yield* Commands.spawns(Wall);
            for (let at = 0; at < walls; at++) {
              commands.spawn(Wall.of({ at }));
            }
            (yield* Built.writes).level = name;
          }),
        ] as const;
        // What comes from a file comes in as an action, once the file is there.
        const Begin = System.input("Begin", function* () {
          const forest = yield* Forest;
          if (forest._tag === "Ready" && (yield* Built).level === "") {
            (yield* Action.Actions).enqueue(Build, forest.assets.layout);
          }
        });
        const Rules = Plugin.make("Rules", {
          handlers,
        });
        const Shown = Plugin.make("Shown", {
          plugins: [Rules, Assets.plugin],
          systems: [
            Assets.during(Forest).pipe(System.runIf(State.is(Level, "forest"))),
            Begin,
          ],
        });
        const slow = makeSlowLoader();
        const { hash, recording } = yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Shown] }), {
            hashEvery: 1,
          });
          const step = Driver.fixedStep(app, { hz: 10 });
          yield* step(0.1);
          yield* app.dispatch(Enter, {});
          yield* step(0.1);
          yield* step(0.1);
          expect((yield* app.read(Query.all(Wall))).count()).toBe(0);
          slow.waiting
            .get("/forest.json")!
            .arrive(new TextEncoder().encode('{"walls":4,"name":"Forest"}'));
          yield* Effect.promise(settle);
          yield* step(0.1);
          expect((yield* app.read(Query.all(Wall))).count()).toBe(4);
          yield* step(0.1);
          yield* step(0.1);
          // Issued once.
          expect(
            app.actionLog.filter(
              (entry) => !Action.isHashCheck(entry) && entry.name === "as/Build"
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
            hash: (yield* app.read(World)).hash(),
            recording: yield* Replay.record(app),
          };
        }).pipe(Effect.provideService(Assets.Loader, slow.loader));
        // The replay has the rules and nothing that loads or draws.
        const again = yield* Replay.verify(
          recording,
          App.define({ plugins: [Rules] }),
          { hashEvery: 1 }
        );
        expect((yield* again.read(World)).hash()).toBe(hash);
        expect((yield* again.read(Query.all(Wall))).count()).toBe(4);
      })
  );

  it.effect("are there again in a game that is loaded from a save", () =>
    Effect.gen(function* () {
      const { Game, Go, drawn, log } = makeGame();
      yield* Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Game] }));
        yield* app.dispatch(Go, { to: "forest" });
        yield* app.tick(1);
        yield* app.frame();
        const save = yield* Effect.exit(Save.make(app));
        assert(Exit.isSuccess(save));
        const loaded = yield* App.make(App.define({ plugins: [Game] }), {
          save: save.value,
        });
        drawn.length = 0;
        yield* loaded.frame();
        expect(drawn).toEqual([
          "forest: forest Ready (Forest, 3 bytes), cave Absent",
        ]);
        // Each app holds its own.
        expect(log).toEqual(["open /forest.png", "open /forest.png"]);
      }).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
    })
  );

  it.effect(
    "are kept by one system per bundle, whose condition may hold in several states",
    () =>
      Effect.gen(function* () {
        const { Forest, Game, Go, Level } = makeGame();
        yield* Effect.gen(function* () {
          // A second system for the same bundle is refused by its name.
          const twice = yield* Effect.exit(
            App.make(
              App.define({
                plugins: [Game],
                systems: [
                  Assets.during(Forest).pipe(
                    System.runIf(State.is(Level, "menu"))
                  ),
                ],
              })
            )
          );
          expect(Exit.isFailure(twice)).toBe(true);
          const duplicate = Result.getOrThrow(Exit.findDefect(twice));
          assert.instanceOf(duplicate, Error);
          expect(duplicate.message).toMatch(
            /Duplicate system name "Assets\.during\(as\/Forest\)"/
          );
          // Kept for two states by one condition that holds in both.
          const log: string[] = [];
          const Shared = Assets.bundle("as/Shared", {
            font: tracked("/cave.png", log),
          });
          const app = yield* App.make(
            App.define({
              plugins: [Game],
              systems: [
                Assets.during(Shared).pipe(
                  System.runIf(State.is(Level, "forest", "cave"))
                ),
              ],
            })
          );
          for (const to of ["forest", "cave", "forest"] as const) {
            yield* app.dispatch(Go, { to });
            yield* app.tick(1);
            yield* app.frame();
          }
          expect(log).toEqual(["open /cave.png"]);
          yield* app.dispatch(Go, { to: "menu" });
          yield* app.tick(1);
          yield* app.frame();
          expect(log).toEqual(["open /cave.png", "close /cave.png"]);
        }).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
      })
  );

  it.effect(
    "stay while anyone holds them: a system of the game's own can keep a bundle the level has left",
    () =>
      Effect.gen(function* () {
        const { Forest, Game, Go, drawn, log } = makeGame();
        let keep = false;
        // Holds the forest while it is told to, whatever the level.
        const Keep = System.frame("Keep", function* () {
          const store = yield* Assets.Store;
          if (keep) {
            store.hold(Forest, "Keep");
          } else {
            store.drop(Forest, "Keep");
          }
        });
        yield* Effect.gen(function* () {
          const app = yield* App.make(
            App.define({ plugins: [Game], systems: [Keep] })
          );
          const frame = Effect.fnUntraced(function* () {
            yield* app.frame();
            return drawn.at(-1)!;
          });
          // Nobody holds it, and dropping what is not held does nothing.
          yield* frame();
          yield* frame();
          expect(log).toEqual([]);
          yield* app.dispatch(Go, { to: "forest" });
          yield* app.tick(1);
          yield* frame();
          keep = true;
          yield* frame();
          // Held twice, loaded once.
          expect(log).toEqual(["open /forest.png"]);
          yield* app.dispatch(Go, { to: "menu" });
          yield* app.tick(1);
          yield* frame();
          yield* frame();
          // The level has left it, and it is still held.
          expect(yield* frame()).toBe(
            "menu: forest Ready (Forest, 3 bytes), cave Absent"
          );
          expect(log).toEqual(["open /forest.png"]);
          keep = false;
          // The frame that drops it has it still; it is gone by the next.
          yield* frame();
          expect(yield* frame()).toBe("menu: forest Absent, cave Absent");
          expect(log).toEqual(["open /forest.png", "close /forest.png"]);
        }).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
      })
  );

  it.effect("fetch a file once for every bundle that names it", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const asked: string[] = [];
      const Level = State.define("as/Shared", ["menu", "forest"]);
      const Forest = Assets.bundle("as/Forest", {
        backdrop: tracked("/forest.png", log),
      });
      const Raw = Assets.bundle("as/Raw", {
        backdrop: Assets.bytes("/forest.png"),
      });
      const seen: string[] = [];
      const Look = System.frame("Look", function* () {
        seen.push(`${(yield* Forest)._tag} ${(yield* Raw)._tag}`);
      });
      const Enter = Action.define("as/EnterShared", Schema.Struct({}));
      const counting: Assets.LoaderShape = {
        bytes: (url) =>
          Effect.suspend(() => {
            asked.push(url);
            return fromMemory(url);
          }),
      };
      yield* Effect.gen(function* () {
        const app = yield* App.make(
          App.define({
            plugins: [Assets.plugin],
            handlers: [
              Action.handler(Enter, function* () {
                (yield* Level.sets).set("forest");
              }),
            ],
            systems: [
              Assets.during(Forest).pipe(
                System.runIf(State.is(Level, "forest"))
              ),
              Assets.during(Raw).pipe(System.runIf(State.is(Level, "forest"))),
              Look,
            ],
          })
        );
        yield* app.dispatch(Enter, {});
        yield* app.tick(1);
        yield* app.frame();
        expect(seen.at(-1)).toBe("Ready Ready");
        expect(asked).toEqual(["/forest.png"]);
        expect(log).toEqual(["open /forest.png"]);
      }).pipe(Effect.provideService(Assets.Loader, counting));
    })
  );

  it.live(
    "fetch again a file whose request got no answer, and are ready without the level being entered again",
    () =>
      Effect.gen(function* () {
        const { Game, Go, drawn } = makeGame();
        const asked: string[] = [];
        const loader: Assets.LoaderShape = {
          bytes: (url) =>
            Effect.suspend(() => {
              asked.push(url);
              return url === "/forest.png" &&
                asked.filter((one) => one === url).length === 1
                ? Effect.fail(
                    new Assets.Failed({
                      url,
                      message: "The server answered 503",
                      transient: true,
                    })
                  )
                : fromMemory(url);
            }),
        };
        yield* Effect.gen(function* () {
          const app = yield* App.make(App.define({ plugins: [Game] }));
          const frame = Effect.fnUntraced(function* () {
            yield* app.frame();
            return drawn.at(-1)!;
          });
          yield* app.dispatch(Go, { to: "forest" });
          yield* app.tick(1);
          expect(yield* frame()).toBe("forest: forest Loading, cave Absent");
          // Each frame draws what has arrived, a few milliseconds at a time
          // for as long as two seconds.
          const ready = "forest: forest Ready (Forest, 3 bytes), cave Absent";
          let shown = yield* frame();
          for (let i = 0; i < 400 && shown !== ready; i++) {
            yield* Effect.promise(
              () => new Promise((resolve) => setTimeout(resolve, 5))
            );
            shown = yield* frame();
          }
          expect(shown).toBe(ready);
          expect(asked.filter((url) => url === "/forest.png")).toEqual([
            "/forest.png",
            "/forest.png",
          ]);
        }).pipe(Effect.provideService(Assets.Loader, loader));
      })
  );

  it.effect(
    "are let go once, when the last bundle that has them is let go",
    () =>
      Effect.gen(function* () {
        const log: string[] = [];
        const backdrop = tracked("/forest.png", log);
        const Forest = Assets.bundle("as/Forest", { backdrop });
        const Grove = Assets.bundle("as/Grove", { backdrop });
        const held = { forest: true, grove: true };
        const Keep = System.frame("Keep", function* () {
          const store = yield* Assets.Store;
          for (const [bundle, keep] of [
            [Forest, held.forest],
            [Grove, held.grove],
          ] as const) {
            if (keep) {
              store.hold(bundle, "Keep");
            } else {
              store.drop(bundle, "Keep");
            }
          }
        });
        const app = yield* App.make(
          App.define({ plugins: [Assets.plugin], systems: [Keep] })
        ).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))));
        yield* app.frame();
        expect(log).toEqual(["open /forest.png"]);
        held.forest = false;
        yield* app.frame();
        expect(log).toEqual(["open /forest.png"]);
        held.grove = false;
        yield* app.frame();
        expect(log).toEqual(["open /forest.png", "close /forest.png"]);
        yield* app.close;
        expect(log).toEqual(["open /forest.png", "close /forest.png"]);
      })
  );

  it.effect(
    "fail as assets that could not be loaded when what makes them dies",
    () =>
      Effect.gen(function* () {
        const Level = State.define("as/Mode", ["on"]);
        const Cursed = Assets.bundle("as/Cursed", {
          one: Assets.make("/forest.png", () => Effect.die(new Error("boom"))),
        });
        let status: Assets.Status<unknown> | undefined;
        const Look = System.frame("Look", function* () {
          status = yield* Cursed;
        });
        yield* Effect.gen(function* () {
          const app = yield* App.make(
            App.define({
              plugins: [Assets.plugin],
              systems: [
                Assets.during(Cursed).pipe(System.runIf(State.is(Level, "on"))),
                Look,
              ],
            })
          );
          yield* app.frame();
          expect(status?._tag).toBe("Failed");
          expectFailed((status as { error: unknown }).error, "", "boom");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(Assets.layer(Assets.makeMemory(files)), quiet)
          )
        );
      })
  );

  it.effect(
    "are held by a plugin's layer for as long as the app, when they are loaded there",
    () =>
      Effect.gen(function* () {
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
        const app = yield* App.make(App.define({ plugins: [Ui] })).pipe(
          Effect.provide(Assets.layer(Assets.makeMemory(files)))
        );
        expect(log).toEqual(["open /forest.png"]);
        yield* app.close;
        expect(log).toEqual(["open /forest.png", "close /forest.png"]);
      })
  );
});

describe("levels as data", () => {
  // A game of levels, each a file: nothing in it names a level but by number.
  const Walls = Schema.Struct({ walls: Schema.Array(Schema.Int) });
  const Wall = Component.define("lv/Wall", { at: Field.i32 });
  const Progress = Singleton.define(
    "lv/Progress",
    { level: Field.i32, builds: Field.i32 },
    { level: 1, builds: 0 }
  );
  const Levels = Assets.family("lv/Level", (level: number) => ({
    layout: Assets.json(`/levels/${level}.json`, Walls),
  }));
  const level = Effect.map(Progress, (progress) => progress.level);
  const Build = Action.define(
    "lv/Build",
    Schema.Struct({ level: Schema.Int, walls: Schema.Array(Schema.Int) })
  );
  // A level replaces the one before: its walls go, and the new ones come.
  const build = Action.handler(Build, function* ({ walls }) {
    const commands = yield* Commands.spawns(Wall);
    (yield* Query.all(Wall)).each((_, entity) => {
      commands.despawn(entity);
    });
    for (const at of walls) {
      commands.spawn(Wall.of({ at }));
    }
    (yield* Progress.writes).builds += 1;
  });
  const Go = Action.define("lv/Go", Schema.Struct({ level: Schema.Int }));
  const LevelReady = Assets.onReady(Levels, level, build, ({ layout }, at) => ({
    level: at,
    walls: layout.walls,
  }));
  const Rules = Plugin.make("lv/Rules", {
    plugins: [LevelReady],
    handlers: [
      Action.handler(Go, function* ({ level: to }) {
        (yield* Progress.writes).level = to;
      }),
    ],
  });
  const Shown = Plugin.make("lv/Shown", {
    plugins: [Rules],
    systems: [Assets.during(Levels, level)],
  });
  const LevelGame = App.define({ plugins: [Shown] });
  const makeLevels = () => App.make(LevelGame, { hashEvery: 1 });
  const files = {
    "/levels/1.json": '{"walls":[]}',
    "/levels/2.json": '{"walls":[4,5]}',
  };
  /** A frame, what loads meanwhile, the input stage and a tick, as a driver runs them. */
  const play = Effect.fnUntraced(function* (
    app: Effect.Success<ReturnType<typeof makeLevels>>,
    turns = 4
  ) {
    for (let turn = 0; turn < turns; turn++) {
      yield* app.frame();
      yield* Effect.promise(settle);
      yield* app.input();
      yield* app.tick(1);
    }
  });
  const handedOver = (log: readonly Action.LogEntry[]) =>
    log.flatMap((entry) =>
      !Action.isHashCheck(entry) &&
      entry.name === "arcadekit/Assets.onReady(lv/Level)"
        ? [entry.payload]
        : []
    );
  const buildsOf = (app: Pick<App.Any, "read">) =>
    Effect.map(app.read(Progress), (progress) => progress.builds);

  it.effect(
    "hands each level's file to the rules once, a level with no walls too, and again when the game comes back to it",
    () =>
      Effect.gen(function* () {
        const app = yield* makeLevels();
        yield* play(app);
        // The first level has no walls, and is handed over once all the same.
        expect(handedOver(app.actionLog)).toEqual([
          { key: 1, payload: { level: 1, walls: [] } },
        ]);
        expect(yield* buildsOf(app)).toBe(1);
        yield* app.dispatch(Go, { level: 2 });
        yield* play(app);
        yield* app.dispatch(Go, { level: 1 });
        yield* play(app);
        expect(yield* buildsOf(app)).toBe(3);
        expect((yield* app.read(Query.all(Wall))).count()).toBe(0);
      }).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))))
  );

  it.effect("plays a level that is added as a file, and no code", () =>
    Effect.gen(function* () {
      const walls = Effect.map(
        Query.all(Wall),
        (query) => query.entities().length
      );
      for (const [given, wanted] of [
        [files, 2],
        [{ ...files, "/levels/3.json": '{"walls":[7]}' }, 3],
      ] as const) {
        yield* Effect.gen(function* () {
          const app = yield* makeLevels();
          yield* app.dispatch(Go, { level: 2 });
          yield* play(app);
          yield* app.dispatch(Go, { level: 3 });
          yield* play(app);
          expect(yield* buildsOf(app)).toBe(wanted - 1);
          // With no third file, the game is still at the second level's walls.
          expect(yield* app.read(walls)).toBe(wanted === 2 ? 2 : 1);
        }).pipe(
          Effect.provide(
            Layer.merge(Assets.layer(Assets.makeMemory(given)), quiet)
          )
        );
      }
    })
  );

  it.effect(
    "builds the same world on every machine, which a replay holds without the files",
    () =>
      Effect.gen(function* () {
        const one = yield* makeLevels();
        const two = yield* makeLevels();
        for (const app of [one, two]) {
          yield* play(app);
          yield* app.dispatch(Go, { level: 2 });
          yield* play(app);
        }
        const hash = (yield* one.read(World)).hash();
        expect((yield* two.read(World)).hash()).toBe(hash);
        expect((yield* one.read(Query.all(Wall))).count()).toBe(2);
        const replayed = yield* Replay.verify(
          yield* Replay.record(one),
          App.define({ plugins: [Rules] }),
          { hashEvery: 1 }
        );
        expect((yield* replayed.read(World)).hash()).toBe(hash);
      }).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))))
  );

  it.effect(
    "is not handed over again by an app made from a save of the level",
    () =>
      Effect.gen(function* () {
        const one = yield* makeLevels();
        yield* one.dispatch(Go, { level: 2 });
        yield* play(one);
        expect(yield* buildsOf(one)).toBe(1);
        const loaded = yield* App.make(LevelGame, {
          hashEvery: 1,
          save: yield* Save.make(one),
        });
        // Its bundle loads again, and the world has what it holds already.
        yield* play(loaded);
        yield* play(one);
        expect(handedOver(loaded.actionLog)).toEqual([]);
        expect(yield* buildsOf(loaded)).toBe(1);
        expect((yield* loaded.read(World)).hash()).toBe(
          (yield* one.read(World)).hash()
        );
      }).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))))
  );

  it.effect("is handed over again, once, after a rewind to before it was", () =>
    Effect.gen(function* () {
      const app = yield* makeLevels();
      const before = yield* Timeline.capture(app);
      yield* play(app);
      expect(yield* buildsOf(app)).toBe(1);
      yield* Timeline.rewind(app, before);
      expect(yield* buildsOf(app)).toBe(0);
      yield* play(app);
      expect(yield* buildsOf(app)).toBe(1);
      // And a rewind to after it hands nothing over.
      const after = yield* Timeline.capture(app);
      yield* play(app);
      yield* Timeline.rewind(app, after);
      yield* play(app);
      expect(yield* buildsOf(app)).toBe(1);
    }).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))))
  );

  it.effect(
    "is handed over again once the rules forget it, as a new run does",
    () =>
      Effect.gen(function* () {
        const Sky = Assets.bundle("lv/Sky", {
          layout: Assets.json("/levels/2.json", Walls),
        });
        const Again = Action.define("lv/Again");
        const Runs = Plugin.make("lv/Runs", {
          plugins: [
            Assets.onReady(Sky, build, ({ layout }) => ({
              level: 0,
              walls: layout.walls,
            })),
          ],
          handlers: [
            Action.handler(Again, function* () {
              yield* Assets.forget(Sky);
            }),
          ],
          systems: [Assets.during(Sky)],
        });
        const app = yield* App.make(App.define({ plugins: [Runs] }));
        yield* play(app);
        expect(yield* buildsOf(app)).toBe(1);
        yield* app.dispatch(Again, undefined);
        yield* play(app);
        expect(yield* buildsOf(app)).toBe(2);
      }).pipe(Effect.provide(Assets.layer(Assets.makeMemory(files))))
  );

  it.effect(
    "reaches every peer of a session from whichever loaded it, when the first peer by name could not",
    () =>
      Effect.gen(function* () {
        const peer = (
          me: string,
          others: readonly string[],
          given: Readonly<Record<string, string>>
        ) =>
          Session.make(LevelGame, { seed: 1, me, others, hz: 1 }).pipe(
            Effect.provide(
              Layer.merge(Assets.layer(Assets.makeMemory(given)), quiet)
            )
          );
        // The first peer by name has none of the files.
        const peers = [
          yield* peer("ada", ["edsger", "grace"], {}),
          yield* peer("edsger", ["ada", "grace"], files),
          yield* peer("grace", ["ada", "edsger"], files),
        ];
        for (let turn = 0; turn < 8; turn++) {
          for (const peer of peers) {
            yield* peer.frame(1);
          }
          yield* Effect.promise(settle);
          for (const peer of peers) {
            yield* peer.tick();
          }
          for (const from of peers) {
            for (const message of from.outgoing()) {
              for (const to of peers) {
                if (to !== from) {
                  to.receive(message);
                }
              }
            }
          }
        }
        const hashes = [];
        for (const peer of peers) {
          expect(peer.app.time.tick).toBeGreaterThan(2);
          expect(yield* buildsOf(peer.app)).toBe(1);
          hashes.push((yield* peer.app.read(World)).hash());
        }
        expect(new Set(hashes).size).toBe(1);
      })
  );
});
