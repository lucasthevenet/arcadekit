import { Option, Schema } from "effect";
import { Scene } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { describe, expect, it } from "vitest";

import { Viewport } from "../../src/foldkit/index";
import { viewportId } from "../../src/foldkit/internal/viewport-id";

// No DOM here: Scene renders the view as VNodes and resolves the viewport's Mount. The app keeps
// the viewport's two Messages as a Boolean, the way the demos do.

const Message = defineMessageUnion({
  MountedViewport: {},
  UnmountedViewport: {},
  HidViewport: {},
  GotEvent: { name: Schema.String },
});
type Message = typeof Message.Type;

interface Model {
  readonly isViewportMounted: boolean;
  readonly showsViewport: boolean;
}

const update = (model: Model, message: Message): { model: Model } =>
  Message.match(message, {
    MountedViewport: () => ({ model: { ...model, isViewportMounted: true } }),
    UnmountedViewport: () => ({
      model: { ...model, isViewportMounted: false },
    }),
    HidViewport: () => ({ model: { ...model, showsViewport: false } }),
    GotEvent: () => ({ model }),
  });

const view = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [],
    [
      model.showsViewport
        ? Viewport.make(h, {
            mounted: Message.MountedViewport(),
            unmounted: Message.UnmountedViewport(),
          })
        : h.empty,
      h.p([], [model.isViewportMounted ? "engine on" : "engine off"]),
    ]
  );

const unmounted: Model = { isViewportMounted: false, showsViewport: true };

describe("Viewport.make", () => {
  it("renders an empty .viewport whose Mount reports the app's mounted Message", () => {
    expect(() =>
      Scene.scene(
        { update, view },
        Scene.given(unmounted),
        Scene.expect(Scene.selector(".viewport")).toBeEmpty(),
        Scene.expect(Scene.text("engine off")).toExist(),
        Scene.Mount.expectExact({ name: "GameViewport" }),
        Scene.Mount.resolve(
          { name: "GameViewport" },
          Message.MountedViewport()
        ),
        Scene.expect(Scene.text("engine on")).toExist()
      )
    ).not.toThrow();
  });

  it("ends its Mount when a screen leaves it out", () => {
    expect(() =>
      Scene.scene(
        { update, view },
        Scene.given(unmounted),
        Scene.Mount.resolve(
          { name: "GameViewport" },
          Message.MountedViewport()
        ),
        Scene.Subscription.emit(Message.HidViewport()),
        Scene.Mount.expectEnded({ name: "GameViewport" }),
        Scene.expect(Scene.selector(".viewport")).toBeAbsent()
      )
    ).not.toThrow();
  });

  it("gives the element an id, so the engine entry finds it", () => {
    let id = Option.none<string>();
    Scene.scene(
      { update, view },
      Scene.given(unmounted),
      Scene.tap(({ html }) => {
        id = Option.flatMap(
          Scene.selector(".viewport")(html),
          Scene.attr("id")
        );
      }),
      Scene.Mount.resolve({ name: "GameViewport" }, Message.MountedViewport())
    );
    expect(id).toStrictEqual(Option.some(viewportId));
  });
});

// Miswired on purpose: the @ts-expect-error must be a real type error, and `pnpm typecheck`
// checks this file, so a change that loosens the viewport's types fails there.
const viewportWithNonMessage = (h: HtmlBuilder<Message>) =>
  Viewport.make(h, {
    // @ts-expect-error A string is not one of the app's Messages.
    mounted: "mounted",
    unmounted: Message.UnmountedViewport(),
  });

describe("a miswired viewport", () => {
  it("fails to compile (see the @ts-expect-error line above)", () => {
    expect(viewportWithNonMessage).toBeTypeOf("function");
  });
});
