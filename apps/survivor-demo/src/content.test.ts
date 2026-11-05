import { readFileSync } from "node:fs";

import { ContentError, loadContent } from "@arcadekit/content";
import type { ContentSource } from "@arcadekit/content";
import { GameLoop } from "@arcadekit/runtime";
import {
  chooseUpgrade,
  soloInput,
  survivorsContentDefinition,
  survivorsSimulation,
} from "@arcadekit/survivors";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

// Checks this game's real content files: they decode, reference each other correctly,
// and every hero can play a minute of a run, stepped by the runtime's GameLoop as the demo is.

const contentDir = new URL("../public/content/", import.meta.url);
const fileSource: ContentSource = (file) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(new URL(file, contentDir), "utf-8")) as unknown,
    catch: (cause) => new ContentError({ message: String(cause) }),
  });

const content = await Effect.runPromise(
  loadContent({ ...survivorsContentDefinition, source: fileSource })
);

/** Walks in a slow circle. */
const circling = soloInput({
  read: (step) => ({
    moveX: Math.cos(step / 200),
    moveZ: Math.sin(step / 200),
  }),
});

describe("demo content", () => {
  it.each(content.heroes.map((hero) => hero.id))(
    "%s survives a minute of play",
    (heroId) => {
      const loop = new GameLoop(survivorsSimulation);
      loop.start({ content, heroIds: [heroId] }, 1, 0);
      const world = loop.state!;
      for (
        let frame = 0;
        frame < 60 * 60 && world.status === "running";
        frame++
      ) {
        const nowMs = (frame * 1000) / 60;
        if (world.heroes[0]!.offer) {
          loop.modify((offered) => chooseUpgrade(offered, 0, 0), nowMs);
        }
        loop.frame(circling, { steps: 1 }, nowMs);
      }
      expect(world.kills).toBeGreaterThan(0);
      expect(world.level).toBeGreaterThan(1);
    }
  );
});
