import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { Message } from "./message";
import type { Model } from "./model";
import { subscriptions } from "./subscriptions";
import { init, update } from "./update";

const runsEngine = (model: Model) =>
  subscriptions.engine.modelToDependencies(model).isViewportMounted;

describe("the viewport", () => {
  it("runs the engine exactly while it is in the document, once loaded", () => {
    Story.story(
      update,
      Story.given(init().model),
      Story.model((model) => expect(runsEngine(model)).toBe(false)),
      Story.message(Message.MountedViewport()),
      // No engine until the levels and sprite sheet have loaded.
      Story.model((model) => expect(runsEngine(model)).toBe(false)),
      Story.message(Message.LoadedContent({ levels: [] })),
      Story.model((model) => expect(runsEngine(model)).toBe(true)),
      Story.message(Message.UnmountedViewport()),
      Story.model((model) => expect(runsEngine(model)).toBe(false))
    );
  });

  it("never runs the engine after a failed load", () => {
    Story.story(
      update,
      Story.given(init().model),
      Story.message(Message.MountedViewport()),
      Story.message(Message.FailedToLoadContent({ error: "no sheet" })),
      Story.model((model) => expect(runsEngine(model)).toBe(false))
    );
  });
});
