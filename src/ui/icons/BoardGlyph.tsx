/** A board's icon on a small tile in the board's colour (pickers, menus, lists). */
import { isBoardIconId } from '../../model/boardIcons'
import { CARD_COLORS } from '../../model/types'
import { BoardIcon } from './BoardIcon'
import './boardGlyph.css'

export function BoardGlyph({ icon, color, size = 22 }: { icon: string | null | undefined; color: string | null | undefined; size?: number }) {
  // Both come from library entries (peers' board cards): only known values are used.
  const c = color && (CARD_COLORS as readonly string[]).includes(color) ? color : undefined
  return (
    <span className="board-glyph" data-color={c} style={{ width: size, height: size }} aria-hidden>
      <BoardIcon icon={isBoardIconId(icon) ? icon : null} size={Math.round(size * 0.64)} />
    </span>
  )
}
