/**
 * Shown instead of a board when this device does not have that board's key, e.g. someone sent
 * the address-bar link (#/b/<id>) instead of an invite link, or Back was pressed after leaving a
 * board. Nothing is created or stored for the unknown id.
 */
import { House, Link2Off, LogIn } from 'lucide-react'
import { openBoard } from '../../app/router'
import { HOME_BOARD_ID } from '../../config'
import { useDialogs } from '../uiStore'
import './panels.css'

export function BoardUnavailable() {
  return (
    <div className="board-missing">
      <section className="home-empty__card" aria-labelledby="board-missing-title" aria-describedby="board-missing-desc">
        <span className="home-empty__mark" aria-hidden>
          <Link2Off size={26} strokeWidth={1.6} />
        </span>
        <h1 id="board-missing-title" className="home-empty__title">
          This board isn’t on this device
        </h1>
        <p id="board-missing-desc" className="home-empty__pitch">
          A link copied from the address bar only opens boards you already have. To open a teammate’s board, ask them for an
          invite link (Share → Copy invite link).
        </p>
        <div className="home-empty__actions">
          <button type="button" className="btn btn--primary home-empty__btn" onClick={() => useDialogs.getState().open('join')}>
            <LogIn size={16} strokeWidth={1.75} aria-hidden />
            Join with an invite link
          </button>
          <button type="button" className="btn home-empty__btn" onClick={() => openBoard(HOME_BOARD_ID, true)}>
            <House size={16} strokeWidth={1.75} aria-hidden />
            Go to Home
          </button>
        </div>
        <p className="board-missing__note">If you left this board, you need a new invite link to join it again.</p>
      </section>
    </div>
  )
}
