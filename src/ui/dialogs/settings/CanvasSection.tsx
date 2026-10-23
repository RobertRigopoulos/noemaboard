/** Settings > Boards: canvas preferences of this device (grid, snapping, the Unsorted drawer). */
import { useCanvasPrefs } from '../../../board/prefs'

export function CanvasSection() {
  const prefs = useCanvasPrefs()
  return (
    <div>
      <h3>Boards</h3>
      <label className="switch">
        <input type="checkbox" checked={prefs.unsortedOnMove} onChange={(e) => prefs.set({ unsortedOnMove: e.target.checked })} />
        <span className="switch__text">
          <strong>Put cards moved into a board in its Unsorted drawer</strong>
          <span>Cards you move or copy into another board wait in its Unsorted drawer, ready to be placed. Off: they go next to the board's content.</span>
        </span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={prefs.showGrid} onChange={(e) => prefs.set({ showGrid: e.target.checked })} />
        <span className="switch__text">
          <strong>Show dot grid</strong>
          <span>Dots on the board background.</span>
        </span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={prefs.snapToGrid} onChange={(e) => prefs.set({ snapToGrid: e.target.checked })} />
        <span className="switch__text">
          <strong>Snap to grid</strong>
          <span>Cards line up on the grid when you move or resize them. Hold Ctrl (⌘ on a Mac) while dragging to place freely.</span>
        </span>
      </label>
      <p className="dlg-small" style={{ marginTop: 14 }}>
        These settings apply to this device only.
      </p>
    </div>
  )
}
