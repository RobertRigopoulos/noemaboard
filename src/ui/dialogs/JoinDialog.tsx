/** Paste an invite link to join a shared board. */
import { useId, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { APP_NAME } from '../../config'
import { parseInviteLink } from '../../collab/links'
import { joinWithConfirmation } from '../../app/joinFlow'
import { openBoard } from '../../app/router'
import { toast } from '../toast'
import { Dialog } from './Dialog'

export function JoinDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Join a board"
      description="Paste an invite link a teammate sent you. The board appears on your Home and syncs directly with their devices."
    >
      <JoinForm onDone={onClose} />
    </Dialog>
  )
}

function JoinForm({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const t = text.trim()
    if (!t) {
      setError('Paste the invite link first.')
      return
    }
    const invite = parseInviteLink(t)
    if (!invite) {
      setError(`That doesn't look like a ${APP_NAME} invite link. Ask your teammate to copy it again from Share → Copy invite link.`)
      return
    }
    setBusy(true)
    try {
      const boardId = await joinWithConfirmation(invite)
      onDone()
      openBoard(boardId)
      toast(`Joined “${invite.t}”`, 'success')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Something went wrong while joining. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-link`}>
          Invite link
        </label>
        <input
          id={`${id}-link`}
          className="input"
          data-autofocus
          value={text}
          placeholder="https://…/#/join/…  or  noema://join/…"
          spellCheck={false}
          autoComplete="off"
          maxLength={4000}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => {
            setText(e.target.value)
            if (error) setError(null)
          }}
        />
        {error && (
          <span id={`${id}-err`} className="field__error" role="alert">
            {error}
          </span>
        )}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy && <LoaderCircle size={14} className="spin" aria-hidden />}
          Join board
        </button>
      </div>
    </form>
  )
}
