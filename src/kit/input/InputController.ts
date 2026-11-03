import type { Input } from '../sim/world'

const KEYS: Record<string, readonly [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
}
const STICK_DEADZONE = 0.2
/** Pixels of finger drag for full speed. */
const TOUCH_RANGE = 60

/**
 * Merges keyboard, gamepad and touch/mouse-drag into one movement vector.
 * Touch: press anywhere on the game and drag to move (a floating joystick).
 */
export class InputController {
  private readonly held = new Set<string>()
  private drag: { id: number; startX: number; startY: number; x: number; y: number } | null = null
  private readonly cleanups: Array<() => void> = []

  constructor(private readonly surface: HTMLElement) {
    this.listen(window, 'keydown', e => {
      if (e.code in KEYS) this.held.add(e.code)
    })
    this.listen(window, 'keyup', e => this.held.delete(e.code))
    this.listen(window, 'blur', () => this.held.clear())
    this.listen(surface, 'pointerdown', e => {
      if (this.drag) return
      surface.setPointerCapture(e.pointerId)
      this.drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY }
    })
    this.listen(surface, 'pointermove', e => {
      if (this.drag?.id === e.pointerId) {
        this.drag.x = e.clientX
        this.drag.y = e.clientY
      }
    })
    const release = (e: PointerEvent) => {
      if (this.drag?.id === e.pointerId) this.drag = null
    }
    this.listen(surface, 'pointerup', release)
    this.listen(surface, 'pointercancel', release)
    surface.style.touchAction = 'none'
  }

  read(): Input {
    let x = 0
    let z = 0
    for (const code of this.held) {
      const dir = KEYS[code]
      if (dir) {
        x += dir[0]
        z += dir[1]
      }
    }
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue
      const ax = pad.axes[0] ?? 0
      const az = pad.axes[1] ?? 0
      if (Math.hypot(ax, az) > STICK_DEADZONE) {
        x += ax
        z += az
      }
    }
    if (this.drag) {
      x += clampUnit((this.drag.x - this.drag.startX) / TOUCH_RANGE)
      z += clampUnit((this.drag.y - this.drag.startY) / TOUCH_RANGE)
    }
    const len = Math.hypot(x, z)
    return len > 1 ? { moveX: x / len, moveZ: z / len } : { moveX: x, moveZ: z }
  }

  dispose(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.held.clear()
    this.drag = null
  }

  private listen<K extends keyof WindowEventMap & keyof HTMLElementEventMap>(
    target: Window | HTMLElement,
    type: K,
    handler: (event: WindowEventMap[K] & HTMLElementEventMap[K]) => void,
  ) {
    const listener = handler as EventListener
    target.addEventListener(type, listener)
    this.cleanups.push(() => target.removeEventListener(type, listener))
  }
}

const clampUnit = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v)
