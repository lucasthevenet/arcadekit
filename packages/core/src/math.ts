export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value

export const lerp = (from: number, to: number, t: number): number => from + (to - from) * t

/** Scales (x, y) down to length 1 if it is longer, so diagonal input isn't faster. */
export const clampLength = (x: number, y: number): { x: number; y: number } => {
  const length = Math.hypot(x, y)
  return length > 1 ? { x: x / length, y: y / length } : { x, y }
}
