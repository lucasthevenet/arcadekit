import type * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stage needs WebGL, which Node hasn't: a stand-in renderer records what the stage does with it.
const calls: string[] = [];
/** The camera of each render, in order. */
const rendered: THREE.Camera[] = [];

const fakeRenderer = () => {
  let size = { width: 1, height: 1, ratio: 1 };
  return {
    domElement: {
      style: {},
      remove: () => calls.push("remove canvas"),
    },
    setPixelRatio: (ratio: number) => {
      size = { ...size, ratio };
    },
    setSize: (width: number, height: number) => {
      size = { ...size, width, height };
    },
    getDrawingBufferSize: (target: {
      set: (x: number, y: number) => unknown;
    }) =>
      target.set(
        Math.floor(size.width * size.ratio),
        Math.floor(size.height * size.ratio)
      ),
    render: (_scene: THREE.Scene, camera: THREE.Camera) => {
      rendered.push(camera);
    },
    dispose: () => calls.push("dispose renderer"),
    forceContextLoss: () => calls.push("lose context"),
  };
};

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

const Stage = await import("../../src/render-three/stage");
const PixelCamera = await import("../../src/render-three/pixel-camera");

const container = (width = 100, height = 100) =>
  ({
    clientWidth: width,
    clientHeight: height,
    append: () => {},
  }) as unknown as HTMLElement;

describe("Stage", () => {
  beforeEach(() => {
    calls.length = 0;
    rendered.length = 0;
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal(
      "ResizeObserver",
      newable(() => ({ observe: () => {}, disconnect: () => {} }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("releases the WebGL context on dispose, so stages made one after another don't pile contexts up", () => {
    Stage.dispose(Stage.make(container()));
    expect(calls).toStrictEqual([
      "dispose renderer",
      "lose context",
      "remove canvas",
    ]);
  });

  it("tells a pixel camera its drawing buffer, and renders with the camera it places", () => {
    const stage = Stage.make(container(640, 480), {
      camera: "pixel",
      pixelsPerUnit: 16,
      viewHeight: 15,
    });
    Stage.render(stage);
    expect({
      pixel: PixelCamera.isPixelCamera(stage.camera),
      // 15 units of 16 px is 240 sprite pixels, in a buffer 480 high.
      scale: stage.camera.pixelScale,
      rendered: rendered.length === 1 && rendered[0] === stage.camera.camera,
    }).toStrictEqual({ pixel: true, scale: 2, rendered: true });
    Stage.dispose(stage);
  });

  it("renders a 3D stage with its camera", () => {
    const stage = Stage.make(container(), { camera: "orthographic" });
    Stage.render(stage);
    expect([Stage.isStage(stage), rendered]).toStrictEqual([
      true,
      [stage.camera],
    ]);
    Stage.dispose(stage);
  });
});
