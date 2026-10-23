import { useEffect } from 'react'
import type { BoardContextValue } from '../BoardContext'
import { getCanvasElement } from '../geometry'
import type { Tool } from '../store'
import { startDraftLine } from './interactions'

/** Screen pixels a line-tool press must move to count as a drag; shorter presses drop a default arrow. */
const LINE_TOOL_MIN_DRAG = 8

/** Pointer-down on empty canvas while the line tool is active: drag out a new line. */
export function onLineToolPointerDown(e: React.PointerEvent, board: BoardContextValue) {
  if (e.button !== 0 || board.readOnly) return
  e.preventDefault()
  startDraftLine({
    board,
    pointerId: e.pointerId,
    clientX: e.clientX,
    clientY: e.clientY,
    source: null,
    minDrag: LINE_TOOL_MIN_DRAG,
    captureEl: e.currentTarget as Element,
    fromTool: true,
  })
}

/**
 * With the line tool active, a press on a card starts a line attached to that card. Runs in the
 * capture phase so the card does not start a drag or enter edit mode.
 */
export function useLineToolOnCards(board: BoardContextValue, tool: Tool) {
  useEffect(() => {
    if (tool !== 'line' || board.readOnly) return
    const canvas = getCanvasElement()
    if (!canvas) return
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || canvas.classList.contains('is-space')) return
      const shell = (e.target as HTMLElement | null)?.closest?.('[data-card-id]') as HTMLElement | null
      const id = shell?.dataset.cardId
      if (!id) return
      const c = board.index.get(id)
      if (!c || c.type === 'line') return
      e.stopPropagation()
      e.preventDefault()
      startDraftLine({
        board,
        pointerId: e.pointerId,
        clientX: e.clientX,
        clientY: e.clientY,
        source: id,
        minDrag: LINE_TOOL_MIN_DRAG,
        captureEl: canvas,
        fromTool: true,
      })
    }
    canvas.addEventListener('pointerdown', onDown, true)
    return () => canvas.removeEventListener('pointerdown', onDown, true)
  }, [board, tool])
}
