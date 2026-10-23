/** Rail "Add image" / "Upload": local files become image and file cards at a board position. */
import type * as Y from 'yjs'
import { importFiles } from '../../cards/media/import'
import { toast } from '../toast'

export async function importFilesAt(doc: Y.Doc, files: File[], at: { x: number; y: number }): Promise<void> {
  if (!files.length) return
  try {
    // importFiles reports per-file problems (size, storage) itself.
    await importFiles(doc, files, at, { center: true })
  } catch (err) {
    console.error('File import failed', err)
    toast('Couldn’t add the files', 'error')
  }
}
