import { readFileSync } from "node:fs";

import {
  ChooseUpgrade,
  Survivors,
  SurvivorsContent,
} from "@arcadekit/survivors";
import { ContentSource } from "arcadekit/content";
import * as Game from "arcadekit/game";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

// Checks this game's real content files: they decode, reference each other correctly,
// and every hero can play a minute of a run, as `Game.Loop` steps it for any declared host.

const contentDir = new URL("../public/content/", import.meta.url);
const fileSource = ContentSource.make((file) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(new URL(file, contentDir), "utf-8")) as unknown,
    catch: (cause) =>
      new ContentSource.ContentError({ message: String(cause), cause }),
  })
);

const content = await Effect.runPromise(SurvivorsContent.read(fileSource));

/** Walks in a slow circle. */
const circling = Game.soloInput({
  read: (step) => ({
    moveX: Math.cos(step / 200),
    moveZ: Math.sin(step / 200),
  }),
});

describe("demo content", () => {
  it.each(content.heroes.map((hero) => hero.id))(
    "%s survives a minute of play",
    (heroId) => {
      const loop = new Game.Loop(Survivors);
      loop.start({ content, heroIds: [heroId] }, 1, 0);
      const world = loop.state!;
      for (
        let frame = 0;
        frame < 60 * 60 && world.status === "running";
        frame++
      ) {
        const nowMs = (frame * 1000) / 60;
        if (world.heroes[0]!.offer) {
          loop.send(new ChooseUpgrade({ offer: world.offerSeq, index: 0 }));
        }
        loop.frame(circling, { steps: 1 }, nowMs);
      }
      expect(world.kills).toBeGreaterThan(0);
      expect(world.level).toBeGreaterThan(1);
    }
  );
});
