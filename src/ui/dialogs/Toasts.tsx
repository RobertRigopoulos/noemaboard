/** Toast stack (bottom centre) + a persistent banner for invite-link errors. */
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { holdToast, releaseToast, runToastAction, useToasts, type Toast, type ToastKind } from '../toast'
import { isolateBoardEvents } from './Dialog'
import './toasts.css'

const ICONS: Record<ToastKind, typeof Info> = { info: Info, success: CircleCheck, error: CircleAlert }

export function Toasts({ joinError, onDismissJoinError }: { joinError: string | null; onDismissJoinError: () => void }) {
  const toasts = useToasts((s) => s.toasts)
  return (
    // data-modal-exempt: toasts sit above dialogs and stay usable while one is open (see modalGuard.ts).
    <div className="toasts" data-modal-exempt {...isolateBoardEvents}>
      {/* Errors interrupt (alert); everything else is announced politely. */}
      <div className="toasts__stack" role="status" aria-live="polite">
        {joinError && (
          <div className="toast toast--error" role="alert">
            <CircleAlert size={16} aria-hidden className="toast__icon" />
            <span className="toast__msg">{joinError}</span>
            <button type="button" className="toast__close" aria-label="Dismiss" onClick={onDismissJoinError}>
              <X size={14} aria-hidden />
            </button>
          </div>
        )}
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </div>
    </div>
  )
}

function ToastItem({ toast: t }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss)
  const Icon = ICONS[t.kind] ?? Info
  // Focus moving between the action and the close button must not restart the countdown.
  const onBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) releaseToast(t.id)
  }
  const onFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) holdToast(t.id)
  }
  return (
    <div
      className={`toast toast--${t.kind}${t.action ? ' toast--action' : ''}`}
      role={t.kind === 'error' ? 'alert' : undefined}
      onPointerEnter={() => holdToast(t.id)}
      onPointerLeave={() => releaseToast(t.id)}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <Icon size={16} aria-hidden className="toast__icon" />
      <span className="toast__msg">{t.message}</span>
      {t.action && (
        <button type="button" className="toast__action" onClick={() => runToastAction(t.id)}>
          {t.action.label}
        </button>
      )}
      <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}
