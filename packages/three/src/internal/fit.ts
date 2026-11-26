import type { Camera, PerspectiveCamera } from "three";

import type { FitOptions, RendererLike, RendererShape } from "../Renderer.ts";

const isPerspective = (camera: Camera): camera is PerspectiveCamera =>
  (camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true;

/**
 * Renders through a Three.js renderer, fitting it to its canvas first unless
 * `fit` is false.
 *
 * @internal
 */
export const fitted = (
  renderer: RendererLike,
  options: FitOptions
): RendererShape => {
  const fit = options.fit !== false;
  let width = 0;
  let height = 0;
  let ratio = 0;
  // Asked once a frame: the one object, so that asking allocates nothing.
  const size = { width: 0, height: 0 };
  return {
    size() {
      size.width = renderer.domElement.clientWidth ?? 0;
      size.height = renderer.domElement.clientHeight ?? 0;
      return size;
    },
    render(scene, camera) {
      const w = renderer.domElement.clientWidth ?? 0;
      const h = renderer.domElement.clientHeight ?? 0;
      // A canvas that is not laid out has no size to fit.
      if (fit && w > 0 && h > 0) {
        const r =
          options.pixelRatio ??
          Math.min(
            (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1,
            2
          );
        if (w !== width || h !== height || r !== ratio) {
          width = w;
          height = h;
          ratio = r;
          renderer.setPixelRatio(r);
          renderer.setSize(w, h, false);
        }
        // Asked of the camera each frame, since it can be replaced.
        if (isPerspective(camera) && camera.aspect !== w / h) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        }
      }
      renderer.render(scene, camera);
    },
  };
};
