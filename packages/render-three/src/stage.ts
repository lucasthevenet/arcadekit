import * as THREE from 'three'

export interface StageOptions {
  readonly background?: THREE.ColorRepresentation
  /** Linear fog from `near` to `far`, in the background color. */
  readonly fog?: { readonly near: number; readonly far: number }
  readonly fov?: number
  readonly near?: number
  readonly far?: number
  /** Caps devicePixelRatio; 2 keeps phones sharp without rendering 9x the pixels. */
  readonly maxPixelRatio?: number
}

/**
 * A renderer, scene and perspective camera that fill a container element and resize with it.
 * `dispose()` frees every GPU resource in the scene and removes the canvas.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private readonly resizeObserver: ResizeObserver

  constructor(
    private readonly container: HTMLElement,
    options: StageOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.maxPixelRatio ?? 2))
    const canvas = this.renderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container.appendChild(canvas)

    this.camera = new THREE.PerspectiveCamera(options.fov ?? 50, 1, options.near ?? 0.1, options.far ?? 400)
    if (options.background !== undefined) {
      this.scene.background = new THREE.Color(options.background)
      if (options.fog) this.scene.fog = new THREE.Fog(options.background, options.fog.near, options.fog.far)
    }

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.resizeObserver.disconnect()
    disposeObject(this.scene)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }
}

/** Frees the geometries and materials of `root` and everything under it. */
export const disposeObject = (root: THREE.Object3D): void => {
  root.traverse(object => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
      object.geometry.dispose()
      const materials: THREE.Material[] = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) material.dispose()
    }
  })
}
