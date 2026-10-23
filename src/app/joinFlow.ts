/**
 * Joining from an invite link, with a clear explanation when the link conflicts with a board this
 * device already has (an invite must never silently re-key an existing board).
 */
import { BoardKeyMismatchError, joinBoard } from '../collab/boards'
import type { InvitePayload } from '../collab/links'

export const MISMATCH_MESSAGE =
  "This link doesn't match the board you already have on this device, so nothing was changed. Ask the person who shared it to copy a fresh link from Share → Copy invite link."

/** Joins; asks before trusting a link over a key that was only seen on a board card. Throws with a user-facing message. */
export async function joinWithConfirmation(invite: InvitePayload): Promise<string> {
  try {
    return await joinBoard(invite, { onMismatch: 'throw' })
  } catch (err) {
    if (!(err instanceof BoardKeyMismatchError)) throw err
    if (
      err.replaceable &&
      window.confirm(
        `You already have a board with this id, but you have never opened it on this device. Use the key from this invite link for “${invite.t}”?`,
      )
    ) {
      return joinBoard(invite, { onMismatch: 'throw', replaceUnverifiedKey: true })
    }
    throw new Error(MISMATCH_MESSAGE)
  }
}
