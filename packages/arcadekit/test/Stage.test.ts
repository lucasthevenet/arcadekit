import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Assets,
  Commands,
  Component,
  Event,
  Field,
  Frame,
  Input,
  Plugin,
  Query,
  Singleton,
  Sound,
  State,
  System,
  View,
  World,
} from "../src/index";

const Position = Component.define("stg/Position", { x: Field.f32 });
const Moving = Query.all(Position).pipe(Query.writes(Position));
const Placed = Query.all(Position);
const Moved = Event.define("stg/Moved", Schema.Struct({ x: Schema.Number }));
const Phase = State.define("stg/Phase", ["menu", "playing"]);
const Turn = Singleton.define("stg/Turn", { player: Field.u8 }, { player: 1 });

const Move = System.tick("stg/Move", function* () {
  const moved = yield* Moved.emits;
  (yield* Moving).each((position) => {
    position.x += 1;
  });
  moved.emit({ x: 1 });
});

const Read = System.frame("stg/Read", function* () {
  for (const step of (yield* Moved).read()) {
    seen.push(step.x);
  }
});

const seen: number[] = [];

const Start = Plugin.make("stg/Start", {
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Position)).spawn(Position.of({ x: 0 }));
  }),
});

describe("a system's stage", () => {
  it("emits from the tick and reads that event from the frame", () => {
    seen.length = 0;
    const app = Effect.runSync(
      App.make(App.define({ plugins: [Start], systems: [Move, Read] }))
    );
    app.tick(1);
    app.frame(0);
    expect(seen).toEqual([1]);
    const world = Effect.runSync(app.read(World));
    const positions = Effect.runSync(app.read(Placed))
      .entities()
      .map((id) => world.get(id, Position)?.x);
    expect(positions).toEqual([1]);
  });

  it("refuses what the other stages do", () => {
    System.tick(
      "stg/BadSound",
      // @ts-expect-error sound is the frame's
      function* () {
        yield* Sound.Player;
      }
    );
    System.tick(
      "stg/BadFrame",
      // @ts-expect-error Frame is the frame's
      function* () {
        yield* Frame;
      }
    );
    System.tick(
      "stg/BadView",
      // @ts-expect-error a view is published from the frame
      function* () {
        yield* View.Port;
      }
    );
    System.tick(
      "stg/BadAssets",
      // @ts-expect-error assets load outside the tick
      function* () {
        yield* Assets.Store;
      }
    );
    System.tick(
      "stg/BadDevices",
      // @ts-expect-error the devices are the input stage's
      function* () {
        yield* Input.Devices;
      }
    );
    System.frame(
      "stg/BadEmit",
      // @ts-expect-error emitting is the tick's
      function* () {
        (yield* Moved.emits).emit({ x: 1 });
      }
    );
    System.frame(
      "stg/BadCommand",
      // @ts-expect-error commands are the tick's
      function* () {
        yield* Commands;
      }
    );
    System.frame(
      "stg/BadWrite",
      // @ts-expect-error a writing query is the tick's
      function* () {
        yield* Moving;
      }
    );
    System.frame(
      "stg/BadState",
      // @ts-expect-error setting a state is the tick's
      function* () {
        (yield* Phase.sets).set("playing");
      }
    );
    System.frame(
      "stg/BadTurn",
      // @ts-expect-error writing a singleton is the tick's
      function* () {
        (yield* Turn.writes).player = 2;
      }
    );
    System.input(
      "stg/BadSoundInput",
      // @ts-expect-error sound is the frame's
      function* () {
        yield* Sound.Player;
      }
    );
    System.tick("stg/Reader", function* () {
      // @ts-expect-error emit is not on the reader
      (yield* Moved).emit({ x: 1 });
    });
    System.frame("stg/ReadTurn", function* () {
      const turn = yield* Turn;
      // @ts-expect-error the read is read-only
      turn.player = 2;
    });
    expect(Move.stage).toBe("update");
    expect(Read.stage).toBe("frame");
  });

  it("refuses a hook that is not a tick, and a move into another group", () => {
    State.onEnter(
      Phase,
      "playing",
      "stg/Hook",
      // @ts-expect-error a hook is a system of the tick
      function* () {
        yield* Frame;
      }
    );
    const drawn = System.frame("stg/Drawn", function* () {
      void (yield* Frame).alpha;
    });
    System.inStage("preUpdate")(
      // @ts-expect-error inStage stays inside the frame
      drawn
    );
    const moved = System.tick("stg/MovedSys", function* () {
      void (yield* Phase).value;
    });
    System.inStage("frame")(
      // @ts-expect-error a frame system is System.frame
      moved
    );
    expect(drawn.stage).toBe("frame");
    expect(moved.stage).toBe("update");
  });

  it("refuses two systems, two handlers or two plugins with one name", () => {
    const one = System.tick("stg/Same", function* () {});
    const two = System.tick("stg/Same", function* () {});
    Plugin.make(
      "stg/Twice",
      // @ts-expect-error duplicate system name
      { systems: [one, two] }
    );
    const Go = Action.define("stg/Go", Schema.Struct({}));
    const first = Action.handler(Go, function* () {});
    const second = Action.handler(Go, function* () {});
    Plugin.make(
      "stg/Hands",
      // @ts-expect-error duplicate handler
      { handlers: [first, second] }
    );
    const left = Plugin.make("stg/Shared", {});
    const right = Plugin.make("stg/Shared", {});
    App.define(
      // @ts-expect-error duplicate plugin name
      { plugins: [left, right] }
    );
    expect(one.name).toBe(two.name);
    expect(left.name).toBe(right.name);
  });
});
