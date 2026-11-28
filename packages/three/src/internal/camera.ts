import type { ComponentDef } from "arcadekit/ecs";
import * as Query from "arcadekit/Query";
import * as System from "arcadekit/System";
import * as Transform2d from "arcadekit/Transform2d";
import { Effect } from "effect";
import { OrthographicCamera, Vector3 } from "three";

import type { Bounds, Camera2dOptions } from "../Camera.ts";
import { Scene } from "../Scene.ts";
import type { SceneShape } from "../Scene.ts";
import type { Needs } from "../Three.ts";

/** How far the camera stands from the plane, and so the depth either side of it that it shows. */
const DEPTH = 1000;

/** Where a view of `half` either side of `at` stays inside `from` to `to`. */
const inside = (at: number, half: number, from: number, to: number): number =>
  to - from <= 2 * half
    ? (from + to) / 2
    : Math.min(Math.max(at, from + half), to - half);

const refuse = (name: string, options: Camera2dOptions): void => {
  if (!(Number.isFinite(options.height) && options.height > 0)) {
    throw new Error(
      `Three.camera2d("${name}") was given a height of ${options.height}. Give the number of the game's units the view shows from bottom to top, above 0.`
    );
  }
  const { within } = options;
  if (
    within !== undefined &&
    !(within.right > within.left && within.top > within.bottom)
  ) {
    throw new Error(
      `Three.camera2d("${name}") was given a within whose right is not past its left or whose top is not above its bottom. Give the rectangle the view stays inside, with y up.`
    );
  }
};

/** What one `Three.camera2d` keeps from one frame to the next, in each app: its camera, and where it aims. */
interface View {
  readonly camera: OrthographicCamera;
  /** Where the view is centred, before `within` holds it. */
  x: number;
  y: number;
}

/** Fits a view's camera to the canvas of this frame, held inside `within`. */
const fit = (
  view: View,
  size: SceneShape["size"],
  height: number,
  within: Bounds | undefined
): void => {
  const aspect =
    size.width > 0 && size.height > 0 ? size.width / size.height : 1;
  const halfHeight = height / 2;
  const halfWidth = halfHeight * aspect;
  let { x, y } = view;
  if (within !== undefined) {
    x = inside(x, halfWidth, within.left, within.right);
    y = inside(y, halfHeight, within.bottom, within.top);
  }
  const { camera } = view;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.position.set(x, y, DEPTH);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
};

/**
 * The system of `Three.camera2d`.
 *
 * @internal
 */
export const camera2d = (
  name: string,
  options: Camera2dOptions
): System.System<never, Needs | System.Locals, string, "frame"> => {
  refuse(name, options);
  const { follow, height, smooth, snap, within } = options;
  const marked: readonly ComponentDef[] | undefined =
    follow === undefined ? undefined : "id" in follow ? [follow] : follow;
  const Followed =
    marked === undefined
      ? undefined
      : Query.all(Transform2d.Position).pipe(Query.with(...marked));
  const Kept = System.local((): View => ({
    camera: new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 2 * DEPTH),
    x: options.at?.x ?? 0,
    y: options.at?.y ?? 0,
  }));
  return System.frame(name, function* () {
    const shown = yield* Scene;
    const view = yield* System.Kept(Kept);
    shown.camera = view.camera;
    if (Followed !== undefined) {
      // Between two ticks, where a kind drawn with `smooth` draws it: the
      // same store, read the same way.
      const between = smooth === true ? yield* Transform2d.smooth : undefined;
      let found = false;
      (yield* Query.View(Followed)).each((position, entity) => {
        if (found) {
          return;
        }
        found = true;
        const at =
          between === undefined
            ? position
            : between.position(entity, position, snap);
        view.x = at.x;
        view.y = at.y;
      });
    }
    fit(view, shown.size, height, within);
  });
};

const near = new Vector3();
const far = new Vector3();

/** The point of the plane z = 0 under a point of the canvas, through a scene's camera. */
const planeAt = (
  shown: SceneShape,
  point: { readonly x: number; readonly y: number }
): { readonly x: number; readonly y: number } => {
  const { camera, size } = shown;
  const ndcX = size.width > 0 ? (point.x / size.width) * 2 - 1 : 0;
  const ndcY = size.height > 0 ? 1 - (point.y / size.height) * 2 : 0;
  camera.updateMatrixWorld();
  near.set(ndcX, ndcY, -1).unproject(camera);
  far.set(ndcX, ndcY, 1).unproject(camera);
  const dz = far.z - near.z;
  const t = dz === 0 ? 0 : -near.z / dz;
  return {
    x: near.x + (far.x - near.x) * t,
    y: near.y + (far.y - near.y) * t,
  };
};

/**
 * `Three.toPlane`.
 *
 * @internal
 */
export const toPlane = (point: {
  readonly x: number;
  readonly y: number;
}): Effect.Effect<{ readonly x: number; readonly y: number }, never, Scene> =>
  Effect.map(Scene, (shown) => planeAt(shown, point));
