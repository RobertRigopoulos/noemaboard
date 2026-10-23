/** Peer-to-peer settings: on/off, TURN servers, extra Nostr relays and BitTorrent trackers. */
import { useId, useState } from 'react'
import { Info, Plus, X } from 'lucide-react'
import { useNetworkSettings } from '../../../collab/sync/settings'
import { toast } from '../../toast'
import { MAX_FIELD, MAX_TURN_ROWS, parseTurnRows, parseWssList, toTurnRows, type TurnRow } from './networkValidation'

export function NetworkSection() {
  const settings = useNetworkSettings()
  const [rows, setRows] = useState<TurnRow[]>(() => toTurnRows(settings.iceServers))
  const [relays, setRelays] = useState(settings.nostrRelays.join('\n'))
  const [trackers, setTrackers] = useState(settings.trackers.join('\n'))
  const [error, setError] = useState<string | null>(null)
  const id = useId()

  const setRow = (i: number, patch: Partial<TurnRow>) => setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)))

  const apply = () => {
    const turn = parseTurnRows(rows)
    if ('error' in turn) return setError(turn.error)
    const nostr = parseWssList(relays, 'Nostr relays')
    if ('error' in nostr) return setError(nostr.error)
    const tr = parseWssList(trackers, 'Trackers')
    if ('error' in tr) return setError(tr.error)
    setError(null)
    settings.update({ iceServers: turn.servers, nostrRelays: nostr.urls, trackers: tr.urls })
    toast('Network settings saved. They apply to new connections; reload the app to apply them everywhere.', 'success', 6000)
  }

  return (
    <div>
      <h3>Network</h3>
      <label className="switch">
        <input type="checkbox" checked={settings.p2pEnabled} onChange={(e) => settings.update({ p2pEnabled: e.target.checked })} />
        <span className="switch__text">
          <strong>Peer-to-peer sync</strong>
          <span>
            Sync shared boards directly with teammates' devices. Turn off to keep everything on this device (boards with a sync server still use
            it).
          </span>
        </span>
      </label>

      <section className="dlg-section" style={{ marginTop: 22 }} aria-labelledby={`${id}-turn`}>
        <h4 className="dlg-section__title" id={`${id}-turn`}>
          TURN servers
        </h4>
        <div className="callout" style={{ marginBottom: 10 }}>
          <Info size={16} aria-hidden />
          <span>
            Teammates normally connect directly. Some company, school, hotel or mobile networks block direct connections — then a TURN
            server relays the connection (it stays end-to-end encrypted). Add one if teammates can see each other online but changes never
            arrive. You can run your own (for example coturn) or use a hosted TURN service.
          </span>
        </div>
        {rows.map((r, i) => (
          <div className="turn-row" key={i}>
            <input
              className="input"
              aria-label={`TURN server ${i + 1} address`}
              placeholder="turn:turn.example.com:3478"
              value={r.urls}
              maxLength={MAX_FIELD}
              spellCheck={false}
              onChange={(e) => setRow(i, { urls: e.target.value })}
            />
            <input
              className="input"
              aria-label={`TURN server ${i + 1} username`}
              placeholder="Username"
              value={r.username}
              maxLength={MAX_FIELD}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setRow(i, { username: e.target.value })}
            />
            <input
              className="input"
              type="password"
              aria-label={`TURN server ${i + 1} password`}
              placeholder="Password"
              value={r.credential}
              maxLength={MAX_FIELD}
              autoComplete="new-password"
              onChange={(e) => setRow(i, { credential: e.target.value })}
            />
            <button type="button" className="icon-btn" aria-label={`Remove TURN server ${i + 1}`} title="Remove" onClick={() => setRows((rs) => rs.filter((_, n) => n !== i))}>
              <X size={16} aria-hidden />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn--ghost"
          style={{ marginTop: 6 }}
          disabled={rows.length >= MAX_TURN_ROWS}
          onClick={() => setRows((rs) => [...rs, { urls: '', username: '', credential: '' }])}
        >
          <Plus size={14} aria-hidden />
          Add TURN server
        </button>
      </section>

      <section className="dlg-section" aria-labelledby={`${id}-disc`}>
        <h4 className="dlg-section__title" id={`${id}-disc`}>
          Finding teammates
        </h4>
        <p className="dlg-text">
          Devices find each other through free public Nostr relays and BitTorrent trackers; they only see a random room id, never your boards.
          You can add your own (one wss:// address per line).
        </p>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-nostr`}>
            Extra Nostr relays
          </label>
          <textarea
            id={`${id}-nostr`}
            className="textarea"
            rows={3}
            placeholder="wss://relay.example.com"
            spellCheck={false}
            value={relays}
            onChange={(e) => setRelays(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-trackers`}>
            Extra trackers
          </label>
          <textarea
            id={`${id}-trackers`}
            className="textarea"
            rows={3}
            placeholder="wss://tracker.example.com"
            spellCheck={false}
            value={trackers}
            onChange={(e) => setTrackers(e.target.value)}
          />
        </div>
      </section>

      {error && (
        <p className="field__error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="btn btn--primary" onClick={apply}>
          Save network settings
        </button>
      </div>
    </div>
  )
}
