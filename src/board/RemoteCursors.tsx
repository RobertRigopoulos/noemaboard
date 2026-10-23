import { usePeers } from './BoardContext'
import { useView } from './store'

/** Other people's mouse pointers, drawn in board space but kept at constant screen size. */
export function RemoteCursors() {
  const peers = usePeers()
  const zoom = useView((s) => s.viewport.zoom)
  return (
    <div className="remote-cursors" aria-hidden>
      {peers.map(({ clientId, state }) =>
        state.pointer ? (
          <div
            key={clientId}
            className="remote-cursor"
            style={{
              transform: `translate(${state.pointer.x}px, ${state.pointer.y}px) scale(${1 / zoom})`,
              color: state.user.color,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path d="M2 2 L16 8 L9 10 L7 16 Z" fill="currentColor" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span className="remote-cursor__name" style={{ background: state.user.color }}>
              {state.user.name || 'Guest'}
            </span>
          </div>
        ) : null,
      )}
    </div>
  )
}
