// The drawing buffer a stage asks its renderer for, on each resize. Its own file, so a test checks
// the arithmetic with no renderer; no public file exports it.

/**
 * The drawing buffer for a canvas `width` x `height` CSS pixels: the pixel ratio and size to
 * give `renderer.setSize`. A pixel stage never caps the ratio, since a smaller buffer is
 * stretched onto the screen by a fraction and sprite pixels would cover uneven numbers of
 * screen pixels; where the browser reports the canvas's device pixels (`device`), it uses
 * those, as width * ratio can round a pixel off from the browser's size at a fractional ratio.
 */
export const drawingBuffer = (
  pixel: boolean,
  width: number,
  height: number,
  devicePixelRatio: number,
  maxPixelRatio: number,
  device?: { readonly inlineSize: number; readonly blockSize: number }
): { pixelRatio: number; width: number; height: number } => {
  if (!pixel) {
    return {
      pixelRatio: Math.min(devicePixelRatio, maxPixelRatio),
      width,
      height,
    };
  }
  if (device === undefined) {
    return { pixelRatio: devicePixelRatio, width, height };
  }
  return {
    pixelRatio: 1,
    width: Math.max(1, device.inlineSize),
    height: Math.max(1, device.blockSize),
  };
};
