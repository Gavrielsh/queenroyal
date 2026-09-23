/**
 * Wheel geometry. The server picks the slice; this only works out how far to turn so that
 * slice stops under the pointer at 12 o'clock.
 *
 * Slice `i` is centred at `i * sliceAngle` degrees clockwise from the top. Rotating the wheel
 * by `-i * sliceAngle` (mod 360) brings it to the pointer, so the target is the next such
 * angle at least `turns` full turns beyond the current rotation. `jitter` (a fraction of a
 * slice, -0.5…0.5 exclusive) keeps the stop from always being dead-centre without ever
 * crossing into a neighbour.
 */
export function wheelTargetRotation(
  index: number,
  count: number,
  currentRotation: number,
  turns: number,
  jitter = 0,
): number {
  const slice = 360 / count;
  const base = currentRotation - (((currentRotation % 360) + 360) % 360);
  const clamped = Math.max(-0.45, Math.min(0.45, jitter));
  return base + 360 * turns - index * slice + clamped * slice;
}

/** Which slice sits under the pointer for a given rotation (inverse of the above). */
export function sliceUnderPointer(rotation: number, count: number): number {
  const slice = 360 / count;
  const normalized = (((-rotation % 360) + 360) % 360) + slice / 2;
  return Math.floor(normalized / slice) % count;
}
