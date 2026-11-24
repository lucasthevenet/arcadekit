import { BufferGeometry } from "three";
import type { Material, Object3D } from "three";

/**
 * What a system of this module has created, released with the app.
 *
 * @internal
 */
export interface Kept {
  readonly dispose: () => void;
  /**
   * Called just before the scene is drawn, for things built from assets: are
   * the assets still loaded? Anything whose assets aren't is removed from the
   * scene now, so nothing is drawn with assets released since its system ran.
   */
  readonly settle?: () => void;
}

/**
 * A geometry or a material: what this module disposes of for the game.
 *
 * @internal
 */
export type Owned = BufferGeometry | Material;

/**
 * The geometries and materials one system draws with. One that several
 * systems draw with is disposed of when the last of them lets go: when the
 * bundle it was made from is released, or the app closes. Three.js uploads a
 * disposed one again if it is drawn again.
 *
 * @internal
 */
export class Holdings {
  private readonly mine = new Set<Owned>();

  constructor(
    // How many systems hold each one: the scene's.
    private readonly counts: Map<Owned, number>
  ) {}

  hold(resource: Owned | readonly Owned[]): void {
    if (Array.isArray(resource)) {
      for (const one of resource) {
        this.hold(one);
      }
      return;
    }
    const one = resource as Owned;
    if (this.mine.has(one)) {
      return;
    }
    this.mine.add(one);
    this.counts.set(one, (this.counts.get(one) ?? 0) + 1);
    // Disposed of by the game, in a `free`: it is not held any longer.
    one.addEventListener("dispose", this.forget);
  }

  /** Holds what each mesh of an object is drawn with. */
  holdAll(object: Object3D): void {
    object.traverse((part) => {
      if ("geometry" in part && part.geometry instanceof BufferGeometry) {
        this.hold(part.geometry);
      }
      if ("material" in part && part.material !== undefined) {
        this.hold(part.material as Material | Material[]);
      }
    });
  }

  private readonly forget = (event: { readonly target: Owned }): void => {
    const one = event.target;
    one.removeEventListener("dispose", this.forget);
    if (this.mine.delete(one)) {
      this.drop(one);
    }
  };

  /** Fewer systems hold it: returns whether none does. */
  private drop(one: Owned): boolean {
    const left = (this.counts.get(one) ?? 1) - 1;
    if (left > 0) {
      this.counts.set(one, left);
      return false;
    }
    this.counts.delete(one);
    return true;
  }

  letGo(): void {
    for (const one of this.mine) {
      one.removeEventListener("dispose", this.forget);
      if (this.drop(one)) {
        one.dispose();
      }
    }
    this.mine.clear();
  }
}
