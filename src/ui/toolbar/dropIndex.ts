/**
 * Where a card dropped into a column lands: before the first child whose vertical midpoint is
 * below the pointer. Matches CardShell's rule so rail drops and card drags behave the same.
 * Children without a rendered rect (null) are skipped.
 */
export function computeDropIndex(childRects: readonly ({ y: number; h: number } | null)[], pointerY: number): number {
  for (let i = 0; i < childRects.length; i++) {
    const r = childRects[i]
    if (r && pointerY < r.y + r.h / 2) return i
  }
  return childRects.length
}
