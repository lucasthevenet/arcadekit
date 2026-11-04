import { loadContent } from "@gamekit/content";
// PROTOTYPE (#24 art): a crowded fight to judge an art variant at full crowd, with no menus.
// Loads the demo's real content, fast-forwards a run with the hero kept alive, then keeps
// playing it live with a wandering hero. Add &hero=<id> for another hero, &seconds=<n> to
// fast-forward a different length (default 150).
import { fetchJsonSource } from "@gamekit/content/browser";
import { GameLoop } from "@gamekit/runtime";
import type { StepInput } from "@gamekit/runtime";
import {
  chooseUpgrade,
  soloInput,
  survivorsContentDefinition,
  survivorsSimulation,
} from "@gamekit/survivors";
import type { HeroInput, World } from "@gamekit/survivors";
import { Effect } from "effect";

import type { ArtVariant } from "./variants";

/** A stick that turns every couple of seconds, so the hero roams the horde. */
const wander = (): StepInput<HeroInput> => {
  const input = { moveX: 0, moveZ: 0 };
  return {
    read: (step) => {
      const turn = Math.floor(step / 120);
      const angle = turn * 2.399;
      input.moveX = Math.cos(angle) * 0.8;
      input.moveZ = Math.sin(angle) * 0.8;
      return input;
    },
  };
};

/** Keeps every hero at full health and takes the first upgrade offered. */
const keepAlive = (world: World) => {
  for (const hero of world.heroes) {
    hero.hp = hero.maxHp;
    if (hero.offer) {
      chooseUpgrade(world, hero.slot, 0);
    }
  }
};

export const runShowcase = async (variant: ArtVariant) => {
  const params = new URLSearchParams(window.location.search);
  const content = await Effect.runPromise(
    loadContent({
      ...survivorsContentDefinition,
      source: fetchJsonSource(`${import.meta.env.BASE_URL}content/`),
    })
  );
  const heroId = params.get("hero") ?? content.heroes[0]!.id;
  const seconds = Number(params.get("seconds") ?? 150);

  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0";
  document.body.append(container);
  const view = variant.makeView(container, {});

  const loop = new GameLoop(survivorsSimulation);
  const input = soloInput(wander());
  loop.start({ content, heroIds: [heroId] }, 2026, 0);
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    loop.modify(keepAlive, 0);
    loop.frame(input, { steps: 1 }, 0);
  }

  let last = performance.now();
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    loop.modify(keepAlive, now);
    loop.frame(input, { seconds: (now - last) / 1000 }, now);
    last = now;
    view.render(loop.state, now / 1000);
  };
  requestAnimationFrame(frame);
};
