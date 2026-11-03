import * as THREE from "three";

/** Which camera a Stage builds. */
export type StageCameraKind = "perspective" | "orthographic";

/** The camera type for a kind: what `Stage.camera` is. */
export type StageCamera<K extends StageCameraKind> = K extends "orthographic"
  ? THREE.OrthographicCamera
  : THREE.PerspectiveCamera;

export interface StageOptions<K extends StageCameraKind = "perspective"> {
  /**
   * "perspective" (the default) for a 3D world seen from a point. "orthographic" for a flat
   * board or a side view, where sizes shouldn't shrink with distance; place it with `fitCamera`.
   */
  readonly camera?: K;
  /** Height of an orthographic camera's view, in world units, until `fitCamera` changes it. Defaults to 10. */
  readonly viewHeight?: number;
  readonly background?: THREE.ColorRepresentation;
  /** Linear fog from `near` to `far`, in the background color. */
  readonly fog?: { readonly near: number; readonly far: number };
  /** Perspective camera only. */
  readonly fov?: number;
  readonly near?: number;
  readonly far?: number;
  /** Caps devicePixelRatio; 2 keeps phones sharp without rendering 9x the pixels. */
  readonly maxPixelRatio?: number;
}

/**
 * A renderer, scene and camera that fill a container element and resize with it.
 * The camera is perspective unless `camera: "orthographic"` is passed; on resize, an
 * orthographic camera keeps its view height and widens or narrows to the new aspect ratio.
 * `dispose()` frees every GPU resource in the scene and removes the canvas.
 */
export class Stage<K extends StageCameraKind = "perspective"> {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: StageCamera<K>;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, options: StageOptions<K> = {}) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, options.maxPixelRatio ?? 2)
    );
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    container.append(canvas);

    const near = options.near ?? 0.1;
    const far = options.far ?? 400;
    if (options.camera === "orthographic") {
      const half = (options.viewHeight ?? 10) / 2;
      this.camera = new THREE.OrthographicCamera(
        -half,
        half,
        half,
        -half,
        near,
        far
      ) as StageCamera<K>;
    } else {
      this.camera = new THREE.PerspectiveCamera(
        options.fov ?? 50,
        1,
        near,
        far
      ) as StageCamera<K>;
    }
    if (options.background !== undefined) {
      this.scene.background = new THREE.Color(options.background);
      if (options.fog) {
        this.scene.fog = new THREE.Fog(
          options.background,
          options.fog.near,
          options.fog.far
        );
      }
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
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

  private resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    const camera = this.camera as
      | THREE.PerspectiveCamera
      | THREE.OrthographicCamera;
    if (camera instanceof THREE.OrthographicCamera) {
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

/** Frees the geometries and materials of `root` and everything under it. */
export const disposeObject = (root: THREE.Object3D): void => {
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
        material.dispose();
      }
    }
  });
};
