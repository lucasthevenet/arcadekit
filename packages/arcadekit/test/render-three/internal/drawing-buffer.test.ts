import { describe, expect, it } from "vitest";

import { drawingBuffer } from "../../../src/render-three/internal/drawing-buffer";

describe(drawingBuffer, () => {
  it("caps the pixel ratio of a 3D stage", () => {
    expect(drawingBuffer(false, 400, 800, 3, 2)).toStrictEqual({
      pixelRatio: 2,
      width: 400,
      height: 800,
    });
  });

  it("never caps a pixel stage's, so sprite pixels stay whole on a phone's screen", () => {
    expect({
      device: drawingBuffer(false, 390, 844, 3, 2, {
        inlineSize: 1170,
        blockSize: 2532,
      }),
      pixel: drawingBuffer(true, 390, 844, 3, 2, {
        inlineSize: 1170,
        blockSize: 2532,
      }),
      unreported: drawingBuffer(true, 390, 844, 3, 2),
    }).toStrictEqual({
      device: { pixelRatio: 2, width: 390, height: 844 },
      pixel: { pixelRatio: 1, width: 1170, height: 2532 },
      unreported: { pixelRatio: 3, width: 390, height: 844 },
    });
  });
});
