import { readFileSync } from "node:fs";

import {
  type ContentSource,
  ContentError,
  loadContent,
} from "@gamekit/content";
import {
  CONTENT_FILES,
  GameContent,
  chooseUpgrade,
  createWorld,
  findBrokenReferences,
  step,
} from "@gamekit/survivors";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

// Checks this game's real content files: they decode, reference each other correctly,
// and every hero can play a minute of a run.

const contentDir = new URL("../public/content/", import.meta.url);
const fileSource: ContentSource = (file) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(new URL(file, contentDir), "utf8")) as unknown,
    catch: (cause) => new ContentError({ message: String(cause) }),
  });

const content = await Effect.runPromise(
  loadContent({
    schema: GameContent,
    files: CONTENT_FILES,
    source: fileSource,
    validate: findBrokenReferences,
  })
);

describe("demo content", () => {
  it.each(content.heroes.map((hero) => hero.id))(
    "%s survives a minute of play",
    (heroId) => {
      const world = createWorld({ content, heroId }, 1);
      for (
        let frame = 0;
        frame < 60 * 60 && world.status === "running";
        frame++
      ) {
        if (world.offer) chooseUpgrade(world, 0);
        step(
          world,
          { moveX: Math.cos(frame / 200), moveZ: Math.sin(frame / 200) },
          1 / 60
        );
        world.events.drain();
      }
      expect(world.kills).toBeGreaterThan(0);
      expect(world.player.level).toBeGreaterThan(1);
    }
  );
});
