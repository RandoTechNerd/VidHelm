// Pure geometry for header window-dragging. Kept free of Electron imports so the math
// can be reasoned about (and tested) on its own, see docs/ARCHITECTURE.md.

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi <= lo ? lo : hi)

/**
 * Windows restores a maximized window when you drag its title bar, keeping the pointer at
 * the same relative spot along the bar. This returns the grab offset (cursor → window
 * top-left) to use after restoring, so the window lands under the cursor instead of jumping.
 */
export const restoreDragOffset = (cursor: Pt, maximized: Rect, restored: Rect, headerHeight = 48): Pt => {
  const width = restored.width > 0 ? restored.width : maximized.width
  const ratio = maximized.width > 0 ? clamp((cursor.x - maximized.x) / maximized.width, 0, 1) : 0.5
  return {
    // stay a little inside the edges so the cursor is always on the header, never past it
    x: clamp(ratio * width, 12, Math.max(width - 12, 12)),
    // keep the same vertical grab point, but never below the header strip
    y: clamp(cursor.y - maximized.y, 2, Math.max(headerHeight - 8, 2)),
  }
}

/** Grab offset for a normal (already restored) window. */
export const plainDragOffset = (cursor: Pt, bounds: Rect): Pt => ({ x: cursor.x - bounds.x, y: cursor.y - bounds.y })

/** Aero-style: letting go at the very top of the screen maximizes the window. */
export const shouldSnapMaximize = (cursorY: number, workAreaTop: number, threshold = 6): boolean =>
  cursorY - workAreaTop <= threshold
