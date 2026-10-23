/** Top-right canvas button that opens the Unsorted drawer and shows how many cards wait in it. */
import { Inbox } from 'lucide-react'
import type { BoardContextValue } from '../../board/BoardContext'
import { usePanels } from '../../board/store'
import { keepControlKeys } from '../keyGuard'
import { useUnsortedCards } from './UnsortedPanel'
import './panels.css'

export function UnsortedPill({ ctx }: { ctx: BoardContextValue }) {
  const count = useUnsortedCards(ctx).length
  const open = usePanels((s) => s.panel === 'unsorted')
  const otherPanel = usePanels((s) => s.panel !== null && s.panel !== 'unsorted')
  if (!count && !open) return null
  return (
    <button
      type="button"
      className={`unsorted-pill${open ? ' is-open' : ''}${otherPanel ? ' unsorted-pill--beside-panel' : ''}`}
      aria-expanded={open}
      aria-label={`${count} unsorted card${count === 1 ? '' : 's'}`}
      title={open ? 'Close Unsorted' : 'Cards waiting to be placed on this board'}
      onKeyDown={keepControlKeys}
      onClick={() => usePanels.getState().setPanel(open ? null : 'unsorted')}
    >
      <Inbox size={15} strokeWidth={1.75} aria-hidden />
      <span>
        <span className="unsorted-pill__count">{count}</span> Unsorted
      </span>
    </button>
  )
}
