import * as THREE from "three";

import { PixelCamera } from "./pixel-camera";

/** Which camera a Stage builds. */
export type StageCameraKind = "perspective" | "orthographic" | "pixel";

/** The camera type for a kind: what `Stage.camera` is. */
export type StageCamera<K extends StageCameraKind> = K extends "pixel"
  ? PixelCamera
  : K extends "orthographic"
    ? THREE.OrthographicCamera
    : THREE.PerspectiveCamera;

export interface StageOptions<K extends StageCameraKind = "perspective"> {
  /**
   * "perspective" (the default) for a 3D world seen from a point. "orthographic" for a flat
   * board, where sizes shouldn't shrink with distance; place it with `fitCamera`. "pixel" for
   * pixel art seen straight down (a `PixelCamera`); the stage keeps it told the drawing buffer's size.
   */
  readonly camera?: K;
  /**
   * Height of an orthographic camera's view, in world units, until `fitCamera` changes it.
   * Defaults to 10. For a pixel camera, the height it aims for (defaults to 20).
   */
  readonly viewHeight?: number;
  /** Pixel camera only: sprite pixels per world unit. Defaults to 16. */
  readonly pixelsPerUnit?: number;
  readonly background?: THREE.ColorRepresentation;
}

/** A perspective camera's field of view, in degrees. Set `stage.camera.fov` to change it. */
const FOV = 50;
/** The near and far planes of a perspective or orthographic camera. */
const NEAR = 0.1;
const FAR = 400;
/**
 * Caps devicePixelRatio for a perspective or orthographic stage; 2 keeps phones sharp without
 * rendering 9x the pixels. A pixel stage isn't capped: see `drawingBuffer`.
 */
const MAX_PIXEL_RATIO = 2;

/**
 * A renderer, scene and camera that fill a container element and resize with it.
 * The camera is perspective unless `camera: "orthographic"` or `"pixel"` is passed; on resize, an
 * orthographic camera keeps its view height and widens or narrows to the new aspect ratio, and a
 * pixel camera picks its pixel scale again. The pixel ratio is read again on every resize, and
 * a pixel stage sizes its drawing buffer to the canvas's exact device pixels, where the others
 * cap the ratio at 2 (see `drawingBuffer`). The camera is public: change its fields (a
 * perspective camera's `fov`, `near` and `far`) and call `updateProjectionMatrix()`. So is the
 * scene: set `stage.scene.fog` for fog.
 * `dispose()` frees every GPU resource in the scene, except kept textures (see `keepTexture`),
 * and removes the canvas.
 */
export class Stage<K extends StageCameraKind = "perspective"> {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene = new THREE.Scene();
  readonly camera: StageCamera<K>;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, options: StageOptions<K> = {}) {
    this.container = container;
    const pixel = options.camera === "pixel";
    this.renderer = new THREE.WebGLRenderer({
      // A pixel camera's edges are already on pixels, so it needs no multisampling.
      antialias: !pixel,
      powerPreference: "high-performance",
    });
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    if (pixel) {
      canvas.style.imageRendering = "pixelated";
    }
    container.append(canvas);

    if (pixel) {
      this.camera = new PixelCamera({
        ...(options.pixelsPerUnit === undefined
          ? {}
          : { pixelsPerUnit: options.pixelsPerUnit }),
        ...(options.viewHeight === undefined
          ? {}
          : { viewHeight: options.viewHeight }),
      }) as StageCamera<K>;
    } else if (options.camera === "orthographic") {
      const half = (options.viewHeight ?? 10) / 2;
      this.camera = new THREE.OrthographicCamera(
        -half,
        half,
        half,
        -half,
        NEAR,
        FAR
      ) as StageCamera<K>;
    } else {
      this.camera = new THREE.PerspectiveCamera(
        FOV,
        1,
        NEAR,
        FAR
      ) as StageCamera<K>;
    }
    if (options.background !== undefined) {
      this.scene.background = new THREE.Color(options.background);
    }

    this.resizeObserver = new ResizeObserver((entries) =>
      this.resize(entries.at(-1))
    );
    try {
      // Also fires when only the pixel ratio changes (the window moved to another screen).
      this.resizeObserver.observe(container, {
        box: "device-pixel-content-box",
      });
    } catch {
      this.resizeObserver.observe(container);
    }
    this.resize(undefined);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(entry: ResizeObserverEntry | undefined) {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const camera = this.camera as
      | THREE.PerspectiveCamera
      | THREE.OrthographicCamera;
    const target = drawingBuffer(
      camera instanceof PixelCamera,
      width,
      height,
      window.devicePixelRatio,
      MAX_PIXEL_RATIO,
      entry?.devicePixelContentBoxSize?.[0]
    );
    this.renderer.setPixelRatio(target.pixelRatio);
    this.renderer.setSize(target.width, target.height, false);
    const aspect = width / height;
    if (camera instanceof PixelCamera) {
      const buffer = this.renderer.getDrawingBufferSize(BUFFER_SIZE);
      camera.setBufferSize(buffer.x, buffer.y);
    } else if (camera instanceof THREE.OrthographicCamera) {
      const centerX = (camera.left + camera.right) / 2;
      const halfWidth = ((camera.top - camera.bottom) / 2) * aspect;
      camera.left = centerX - halfWidth;
      camera.right = centerX + halfWidth;
    } else {
      camera.aspect = aspect;
    }
    camera.updateProjectionMatrix();
  }
}

const BUFFER_SIZE = new THREE.Vector2();

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

const KEEP = "arcadekitKeep";

/**
 * Marks a texture that something outside the scene owns, such as a sprite sheet the app
 * loaded: `disposeObject` and `Stage.dispose` leave it alone, and its owner disposes it.
 * Returns the texture.
 */
export const keepTexture = <T extends THREE.Texture>(texture: T): T => {
  texture.userData[KEEP] = true;
  return texture;
};

/** Whether `keepTexture` marked this texture. */
export const isKeptTexture = (texture: THREE.Texture): boolean =>
  texture.userData[KEEP] === true;

/**
 * Frees the geometries, materials and textures of `root` and everything under it: the textures
 * a material holds (its maps, and a shader material's texture uniforms) and, for a scene, its
 * background and environment. Textures marked with `keepTexture` are skipped.
 * `Stage.dispose` calls it on the whole scene. A view that removes an object from the
 * scene calls it on that object, which `Stage.dispose` no longer reaches.
 */
export const disposeObject = (root: THREE.Object3D): void => {
  const textures = new Set<THREE.Texture>();
  if (root instanceof THREE.Scene) {
    addTexture(textures, root.background);
    addTexture(textures, root.environment);
  }
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.Line ||
      object instanceof THREE.Points
    ) {
      object.geometry.dispose();
      const materials: THREE.Material[] = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          addTexture(textures, value);
        }
        if (material instanceof THREE.ShaderMaterial) {
          for (const uniform of Object.values(material.uniforms)) {
            addTexture(textures, uniform.value);
          }
        }
        material.dispose();
      }
    }
  });
  for (const texture of textures) {
    texture.dispose();
  }
};

const addTexture = (textures: Set<THREE.Texture>, value: unknown) => {
  if (value instanceof THREE.Texture && !isKeptTexture(value)) {
    textures.add(value);
  }
};
