/** Reference of every keyboard and mouse shortcut. Opened with "?" or from the header. */
import { Fragment } from 'react'
import { IS_MAC } from '../header/hooks'
import { Dialog } from './Dialog'
import { displayKeys, SHORTCUT_GROUPS } from './shortcutList'

function Combo({ combo }: { combo: string }) {
  const keys = displayKeys(combo, IS_MAC)
  return (
    <span className="row" style={{ gap: 3 }}>
      {keys.map((k, i) => (
        <kbd key={i} className="kbd">
          {k}
        </kbd>
      ))}
    </span>
  )
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Keyboard shortcuts"
      description={IS_MAC ? 'Shortcuts work when you are not typing in a card.' : 'Shortcuts work when you are not typing in a card. On a Mac, use ⌘ instead of Ctrl.'}
    >
      <div className="shortcuts">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title} className="shortcuts__group" aria-label={g.title}>
            <h3>{g.title}</h3>
            <dl className="shortcuts__list">
              {g.items.map((s) => (
                <div key={s.label} className="shortcuts__item">
                  <dt>{s.label}</dt>
                  <dd>
                    {s.keys.map((k, i) => (
                      <Fragment key={k}>
                        {i > 0 && <span>or</span>}
                        <Combo combo={k} />
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
