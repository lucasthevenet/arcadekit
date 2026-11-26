import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import type { Spawned } from "../src/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Plugin,
  Query,
  Save,
  System,
  Time,
  Transform2d,
  Transform3d,
  World,
} from "../src/index.ts";
import * as Entry from "../src/Transform2d.ts";
import { placedIn } from "./placed.ts";

const { Position, Rotation, Scale } = Transform2d;

const Card = Component.tag("t2/Card");

describe("Transform2d", () => {
  it.effect(
    "is three components of a flat game, of 32-bit floats, each known by its name",
    () =>
      Effect.gen(function* () {
        expect(Position.name).toBe("arcadekit/Transform2d.Position");
        expect(Rotation.name).toBe("arcadekit/Transform2d.Rotation");
        expect(Scale.name).toBe("arcadekit/Transform2d.Scale");
        // No third dimension, and a turn is one number.
        expect(Position.fields).toEqual(["x", "y"]);
        expect(Rotation.fields).toEqual(["angle"]);
        expect(Scale.fields).toEqual(["x", "y"]);
        for (const component of [Position, Rotation, Scale]) {
          expect(new Set(component.kinds)).toEqual(new Set(["f32"]));
          expect(component.storage).toBe("table");
        }
        // Added bare, it is where it was made, turned by nothing, and of its
        // own size: a Scale of zeros would be drawn as nothing.
        const Bare = Plugin.make("t2/Bare", {
          setup: Effect.gen(function* () {
            (yield* Commands.spawns(Position, Rotation, Scale)).spawn(
              Position,
              Rotation,
              Scale
            );
          }),
        });
        const app = yield* App.make(App.define({ plugins: [Bare] }));
        const world = yield* app.read(World);
        const bare = (yield* app.read(Query.all(Position, Scale)))
          .entities()
          .map((entity) => ({
            scale: world.get(entity, Scale),
            position: new Set(Object.values(world.get(entity, Position) ?? {})),
          }));
        expect(bare).toEqual([
          { scale: { x: 1, y: 1 }, position: new Set([0]) },
        ]);
        // One module, whichever entry it is reached through.
        expect(Entry.Position).toBe(Position);
      })
  );

  it.effect(
    "is not Transform3d: an entity can have either, and nothing keeps one in step with the other",
    () =>
      Effect.gen(function* () {
        expect(Position).not.toBe(Transform3d.Position);
        expect(Rotation).not.toBe(Transform3d.Rotation);
        expect(Scale).not.toBe(Transform3d.Scale);
        const spawned: Spawned[] = [];
        const Both = Plugin.make("t2/Both", {
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(
              Position,
              Transform3d.Position
            );
            spawned.push(
              commands.spawn(
                Position.of({ x: 1, y: 2 }),
                Transform3d.Position.of({ x: 7, y: 8, z: 9 })
              )
            );
          }),
        });
        const Slide = Action.define(
          "t2/Slide",
          Schema.Struct({ x: Schema.Number, y: Schema.Number })
        );
        const slide = Action.handler(Slide, function* (to) {
          (yield* Query.all(Position).pipe(Query.writes(Position))).each(
            (position) => {
              position.x = to.x;
              position.y = to.y;
            }
          );
        });
        const Lift = Action.define("t2/Lift", Schema.Struct({}));
        const lift = Action.handler(Lift, function* () {
          const commands = yield* Commands;
          (yield* Query.all(Position)).each((_, entity) => {
            commands.remove(entity, Position);
          });
        });
        const app = yield* App.make(
          App.define({ plugins: [Both], handlers: [slide, lift] })
        );
        const world = yield* app.read(World);
        const placed = spawned.map((id) => placedIn(world, id));
        const flat = yield* app.read(Query.all(Position));
        yield* app.dispatch(Slide, { x: 3, y: 4 });
        expect(
          placed.map((both) => [
            world.get(both, Position),
            world.get(both, Transform3d.Position),
          ])
        ).toEqual([
          [
            { x: 3, y: 4 },
            { x: 7, y: 8, z: 9 },
          ],
        ]);
        expect(flat.count()).toBe(1);
        yield* app.dispatch(Lift, {});
        expect(flat.count()).toBe(0);
        expect(
          placed.map((both) => world.get(both, Transform3d.Position))
        ).toEqual([{ x: 7, y: 8, z: 9 }]);
      })
  );

  it.effect(
    "is moved and turned by a system with a loop over its columns",
    () =>
      Effect.gen(function* () {
        const Moving = Query.all(Position, Rotation).pipe(
          Query.writes(Position, Rotation)
        );
        const Drift = System.tick("t2/Drift", function* () {
          const { delta } = yield* Time;
          (yield* Moving).eachChunk((start, end, position, rotation) => {
            for (let i = start; i < end; i++) {
              position.x[i] = position.x[i]! + 4 * delta;
              position.y[i] = position.y[i]! - 2 * delta;
              rotation.angle[i] = rotation.angle[i]! + delta;
            }
          });
        });
        const spawned: Spawned[] = [];
        const Deal = Plugin.make("t2/Deal", {
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(Position, Rotation);
            spawned.push(
              commands.spawn(
                Position.of({ x: 1, y: 2 }),
                Rotation.of({ angle: 0.25 })
              ),
              // Added with no value: at the origin, and not turned.
              commands.spawn(Position, Rotation)
            );
          }),
        });
        const app = yield* App.make(
          App.define({ plugins: [Deal], systems: [Drift] })
        );
        const world = yield* app.read(World);
        yield* app.tick(0.5);
        const moved = spawned
          .map((id) => placedIn(world, id))
          .map((card) => [
            world.get(card, Position),
            world.get(card, Rotation),
          ]);
        expect(moved).toEqual([
          [{ x: 3, y: 1 }, { angle: 0.75 }],
          [{ x: 2, y: -1 }, { angle: 0.5 }],
        ]);
      })
  );

  it.effect(
    "is saved and loaded by a flat game, which names none of its components",
    () =>
      Effect.gen(function* () {
        const spawned: Spawned[] = [];
        const Deal = Plugin.make("t2/Deal", {
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(
              Card,
              Position,
              Rotation,
              Scale
            );
            spawned.push(
              commands.spawn(
                Card,
                Position.of({ x: 1, y: 2 }),
                Rotation.of({ angle: 1.5 }),
                Scale.of({ x: 2, y: 3 })
              )
            );
          }),
        });
        const Flat = App.define({ plugins: [Deal] });
        const app = yield* App.make(Flat);
        const made = (yield* app.read(World)).hash();
        const save = yield* Effect.exit(Save.make(app));
        if (Exit.isFailure(save)) {
          throw new Error("The game could not be saved");
        }
        const read = Save.decode(Save.encode(save.value));
        if (Exit.isFailure(read)) {
          throw new Error("The save could not be read back");
        }
        const again = yield* App.make(Flat, { save: read.value });
        const world = yield* again.read(World);
        const loaded = {
          hash: world.hash(),
          cards: spawned
            .map((id) => placedIn(world, id))
            .map((card) => [
              world.get(card, Position),
              world.get(card, Rotation),
              world.get(card, Scale),
            ]),
        };
        expect(loaded).toEqual({
          hash: made,
          cards: [[{ x: 1, y: 2 }, { angle: 1.5 }, { x: 2, y: 3 }]],
        });
      })
  );
});

describe("Transform2d.smooth", () => {
  const Player = Component.tag("t2/Player", { requires: [Position] });
  const Players = Query.all(Position).pipe(Query.with(Player));
  const Teleport = Action.define(
    "t2/Teleport",
    Schema.Struct({ x: Schema.Number })
  );
  const teleport = Action.handler(Teleport, function* ({ x }) {
    (yield* Players.pipe(Query.writes(Position))).each((position) => {
      position.x = x;
    });
  });
  const Run = System.tick("t2/Run", function* () {
    (yield* Players.pipe(Query.writes(Position))).each((position) => {
      position.x += 10;
    });
  });
  const Start = Plugin.make("t2/Start", {
    setup: Effect.gen(function* () {
      (yield* Commands.spawns(Player)).spawn(Player);
    }),
  });
  /** A canvas game's drawing: where the player is drawn, and a camera on it. */
  const drawing = () => {
    const drawn: number[] = [];
    const camera: number[] = [];
    const Draw = System.frame("t2/Draw", function* () {
      const smooth = yield* Transform2d.smooth;
      (yield* Players).each((position, entity) => {
        drawn.push(smooth.position(entity, position, 50).x);
      });
    });
    const Camera = System.frame("t2/Camera", function* () {
      const smooth = yield* Transform2d.smooth;
      (yield* Players).each((position, entity) => {
        camera.push(smooth.position(entity, position, 50).x);
      });
    });
    return { drawn, camera, Draw, Camera };
  };

  it.effect(
    "draws a canvas game between two ticks, and draws a teleported player where it landed",
    () =>
      Effect.gen(function* () {
        const { Camera, Draw, camera, drawn } = drawing();
        const app = yield* App.make(
          App.define({
            plugins: [Start],
            systems: [Run, Draw, Camera],
            handlers: [teleport],
          })
        );
        yield* app.tick(1);
        // The first frame has nothing to come from: where the tick left it.
        yield* app.frame(0.5);
        yield* app.tick(1);
        yield* app.frame(0);
        yield* app.frame(0.5);
        yield* app.frame(1);
        yield* app.enqueue(Teleport, { x: 500 });
        yield* app.tick(1);
        yield* app.frame(0.5);
        expect(drawn).toEqual([10, 10, 15, 20, 510]);
        // A camera of its own, drawn after the player, stays on it.
        expect(camera).toEqual(drawn);
      })
  );

  it.effect(
    "keeps nothing in the world: a game drawn smoothly hashes and saves as one not drawn",
    () =>
      Effect.gen(function* () {
        const { Camera, Draw } = drawing();
        const drawn = yield* App.make(
          App.define({ plugins: [Start], systems: [Run, Draw, Camera] })
        );
        const bare = yield* App.make(
          App.define({ plugins: [Start], systems: [Run] })
        );
        const ended = [];
        for (const app of [drawn, bare]) {
          for (let i = 0; i < 3; i++) {
            yield* app.tick(1);
            yield* app.frame(0.5);
          }
          ended.push({
            hash: (yield* app.read(World)).hash(),
            save: Save.encode(yield* Save.make(app)),
          });
        }
        expect(ended[0]).toEqual(ended[1]);
      })
  );

  it.effect("keeps what one app draws apart from another's", () =>
    Effect.gen(function* () {
      const { Draw, drawn } = drawing();
      const Game = App.define({ plugins: [Start], systems: [Run, Draw] });
      const one = yield* App.make(Game);
      const two = yield* App.make(Game);
      yield* one.tick(1);
      yield* one.frame(1);
      yield* two.tick(1);
      yield* two.tick(1);
      yield* two.frame(1);
      yield* one.tick(1);
      // From where it was in this app's last frame, not in the other's.
      yield* one.frame(0.5);
      expect(drawn).toEqual([10, 20, 15]);
    })
  );

  it.effect(
    "turns an entity the shorter way round, and sizes it between its two scales",
    () =>
      Effect.gen(function* () {
        const Spin = System.tick("t2/Spin", function* () {
          (yield* Query.all(Rotation, Scale).pipe(
            Query.writes(Rotation, Scale)
          )).each((rotation, scale) => {
            rotation.angle = -3;
            scale.x = 3;
          });
        });
        const Spun = Plugin.make("t2/Spun", {
          setup: Effect.gen(function* () {
            (yield* Commands.spawns(Rotation, Scale)).spawn(
              Rotation.of({ angle: 3 }),
              Scale
            );
          }),
        });
        const seen: { angle: number; x: number }[] = [];
        const Draw = System.frame("t2/DrawSpun", function* () {
          const smooth = yield* Transform2d.smooth;
          (yield* Query.all(Rotation, Scale)).each(
            (rotation, scale, entity) => {
              seen.push({
                angle: smooth.rotation(entity, rotation),
                x: smooth.scale(entity, scale).x,
              });
            }
          );
        });
        const app = yield* App.make(
          App.define({ plugins: [Spun], systems: [Spin, Draw] })
        );
        yield* app.frame(1);
        yield* app.tick(1);
        yield* app.frame(0.5);
        // From 3 to -3 the shorter way is through pi, not back through 0.
        expect(seen[1]!.angle).toBeCloseTo(Math.PI, 5);
        expect(seen[1]!.x).toBe(2);
      })
  );

  it("is read by a frame system alone", () => {
    const drawn = System.frame("t2/Drawn", function* () {
      yield* Transform2d.smooth;
    });
    System.tick(
      "t2/Ticked",
      // @ts-expect-error a tick reads the world, not where a frame draws it
      function* () {
        yield* Transform2d.smooth;
      }
    );
    System.input(
      "t2/Heard",
      // @ts-expect-error the input stage has no frame
      function* () {
        yield* Transform2d.smooth;
      }
    );
    expect(drawn.stage).toBe("frame");
  });
});
