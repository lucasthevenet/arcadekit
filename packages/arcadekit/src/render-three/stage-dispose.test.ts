import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stage needs WebGL, which Node hasn't: a stand-in renderer records what dispose does with it.
const calls: string[] = [];

const fakeRenderer = () => ({
  domElement: {
    style: {},
    remove: () => calls.push("remove canvas"),
  },
  setPixelRatio: () => {},
  setSize: () => {},
  getDrawingBufferSize: (target: { set: (x: number, y: number) => unknown }) =>
    target.set(1, 1),
  dispose: () => calls.push("dispose renderer"),
  forceContextLoss: () => calls.push("lose context"),
});

/** A stand-in to call with `new`: each instance gets the fields `fields` makes. */
const newable = <T extends object>(fields: () => T) =>
  // oxlint-disable-next-line typescript/no-extraneous-class -- Stage calls these with `new`, which an arrow can't take.
  class {
    constructor() {
      Object.assign(this, fields());
    }
  };

vi.mock(import("three"), async (importOriginal) => ({
  ...(await importOriginal()),
  WebGLRenderer: newable(fakeRenderer) as never,
}));

const { Stage } = await import("./stage");

const container = () =>
  ({
    clientWidth: 100,
    clientHeight: 100,
    append: () => {},
  }) as unknown as HTMLElement;

describe("Stage.dispose", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal(
      "ResizeObserver",
      newable(() => ({ observe: () => {}, disconnect: () => {} }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("releases the WebGL context, so stages made one after another don't pile contexts up", () => {
    new Stage(container()).dispose();
    expect(calls).toStrictEqual([
      "dispose renderer",
      "lose context",
      "remove canvas",
    ]);
  });
});
