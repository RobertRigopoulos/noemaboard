/** App-wide overlays: first-run profile setup, dialogs that don't need a board, toasts and join errors. */
import { useDialogs } from './uiStore'
import { ProfileDialog } from './dialogs/ProfileDialog'
import { JoinDialog } from './dialogs/JoinDialog'
import { SettingsDialog } from './dialogs/SettingsDialog'
import { ShortcutsDialog } from './dialogs/ShortcutsDialog'
import { Toasts } from './dialogs/Toasts'
import { StorageBanner } from './dialogs/StorageBanner'
import { MovedBanner } from './dialogs/MovedBanner'

export function AppOverlays({ joinError, onDismissJoinError }: { joinError: string | null; onDismissJoinError: () => void }) {
  const dialog = useDialogs((s) => s.dialog)
  const close = useDialogs((s) => s.close)
  return (
    <>
      <JoinDialog open={dialog === 'join'} onClose={close} />
      <SettingsDialog open={dialog === 'settings'} onClose={close} />
      <ShortcutsDialog open={dialog === 'shortcuts'} onClose={close} />
      {/* Last so the first-run name prompt stacks above anything else. */}
      <ProfileDialog open={dialog === 'profile'} onClose={() => useDialogs.getState().dialog === 'profile' && close()} />
      <Toasts joinError={joinError} onDismissJoinError={onDismissJoinError} />
      <MovedBanner />
      <StorageBanner />
    </>
  )
}
