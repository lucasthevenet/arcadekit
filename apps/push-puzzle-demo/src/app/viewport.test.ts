import { Story } from "foldkit";
import { describe, expect, it } from "vitest";

import { Message } from "./message";
import type { Model } from "./model";
import { subscriptions } from "./subscriptions";
import { init, update } from "./update";

const runsEngine = (model: Model) =>
  subscriptions.engine.modelToDependencies(model).isViewportMounted;

describe("the viewport", () => {
  it("runs the engine exactly while it is in the document", () => {
    Story.story(
      update,
      Story.given(init().model),
      Story.model((model) => expect(runsEngine(model)).toBe(false)),
      Story.message(Message.MountedViewport()),
      Story.model((model) => expect(runsEngine(model)).toBe(true)),
      Story.message(Message.UnmountedViewport()),
      Story.model((model) => expect(runsEngine(model)).toBe(false))
    );
  });
});
