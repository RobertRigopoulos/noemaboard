/** Your name and colour, shown to people you share boards with. Required on first run. */
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { USER_COLORS, useIdentity } from '../../collab/identity'
import { toast } from '../toast'
import { Avatar } from '../header/Avatar'
import { Dialog } from './Dialog'

export const MAX_NAME = 40

const COLOR_NAMES: Record<string, string> = {
  '#e5484d': 'Red',
  '#f76b15': 'Orange',
  '#d6a40b': 'Amber',
  '#30a46c': 'Green',
  '#12a594': 'Teal',
  '#0090ff': 'Blue',
  '#6e56cf': 'Violet',
  '#d6409f': 'Pink',
  '#8e4ec6': 'Purple',
  '#3e63dd': 'Indigo',
}

/** Name + colour picker; used by the profile dialog and the Settings → Profile tab. */
export function ProfileForm({ onSaved, submitLabel = 'Save', autoFocus = true }: { onSaved?: () => void; submitLabel?: string; autoFocus?: boolean }) {
  const user = useIdentity((s) => s.user)
  const [name, setName] = useState(user.name)
  const [color, setColor] = useState(USER_COLORS.includes(user.color) ? user.color : USER_COLORS[0])
  const [touched, setTouched] = useState(false)
  const id = useId()
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([])
  const trimmed = name.replace(/\s+/g, ' ').trim()
  const invalid = !trimmed
  const dirty = trimmed !== user.name || color !== user.color

  const save = (e?: React.FormEvent) => {
    e?.preventDefault()
    setTouched(true)
    if (invalid) return
    useIdentity.getState().setProfile({ name: trimmed, color })
    onSaved?.()
  }

  const onSwatchKey = (e: KeyboardEvent, i: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!delta) return
    e.preventDefault()
    const next = (i + delta + USER_COLORS.length) % USER_COLORS.length
    setColor(USER_COLORS[next])
    swatchRefs.current[next]?.focus()
  }

  return (
    <form onSubmit={save} noValidate>
      <div className="row row--top" style={{ gap: 16, marginBottom: 16 }}>
        <Avatar name={trimmed || '?'} color={color} size={52} />
        <p className="dlg-text" style={{ margin: 0 }}>
          Your name and colour appear on your cursor, on cards you are editing and on your comments. They are only shown to people you
          share boards with — there are no accounts.
        </p>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-name`}>
          Display name
        </label>
        <input
          id={`${id}-name`}
          className="input"
          value={name}
          maxLength={MAX_NAME}
          autoComplete="name"
          placeholder="e.g. Alex Kim"
          data-autofocus={autoFocus || undefined}
          aria-invalid={touched && invalid}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
        />
        <span id={`${id}-hint`} className={touched && invalid ? 'field__error' : 'field__hint'}>
          {touched && invalid ? 'Please enter a name.' : `${trimmed.length}/${MAX_NAME} characters`}
        </span>
      </div>
      <div className="field">
        <span className="field__label" id={`${id}-color`}>
          Colour
        </span>
        <div className="swatches" role="radiogroup" aria-labelledby={`${id}-color`}>
          {USER_COLORS.map((c, i) => (
            <button
              key={c}
              ref={(el) => {
                swatchRefs.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={COLOR_NAMES[c] ?? c}
              title={COLOR_NAMES[c] ?? c}
              tabIndex={color === c ? 0 : -1}
              className="swatch-btn"
              style={{ '--sw': c } as React.CSSProperties}
              onClick={() => setColor(c)}
              onKeyDown={(e) => onSwatchKey(e, i)}
            />
          ))}
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
        <button type="submit" className="btn btn--primary" disabled={invalid || (!dirty && !!user.name)}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}

export function ProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const needsName = useIdentity((s) => s.needsName)
  return (
    <Dialog
      open={open || needsName}
      onClose={onClose}
      dismissible={!needsName}
      size="sm"
      title={needsName ? 'Welcome! What should we call you?' : 'Your profile'}
    >
      <ProfileForm
        submitLabel={needsName ? 'Continue' : 'Save'}
        onSaved={() => {
          if (!needsName) toast('Profile saved', 'success')
          onClose()
        }}
      />
    </Dialog>
  )
}
