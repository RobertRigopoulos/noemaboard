/**
 * Native context menu for text fields, selections and images (spelling suggestions, clipboard). The board
 * canvas shows its own menus by preventing the DOM 'contextmenu' event, so this only appears
 * where the page left the default behaviour alone.
 */
import { clipboard, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { isAllowedExternalUrl } from './validate'

export function attachContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []

    if (params.isEditable && params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
      }
      if (params.dictionarySuggestions.length === 0) items.push({ label: 'No suggestions', enabled: false })
      items.push(
        {
          label: 'Add to dictionary',
          click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: 'separator' },
      )
    }

    // Images the page leaves to the native menu (the lightbox picture); board menus preventDefault.
    if (params.mediaType === 'image' && params.hasImageContents) {
      const { x, y } = params
      items.push({ label: 'Copy image', click: () => contents.copyImageAt(x, y) }, { type: 'separator' })
    }

    if (params.linkURL && isAllowedExternalUrl(params.linkURL)) {
      const link = params.linkURL
      items.push(
        { label: 'Open link in browser', click: () => void shell.openExternal(link) },
        { label: 'Copy link', click: () => clipboard.writeText(link) },
        { type: 'separator' },
      )
    }

    if (params.isEditable) {
      const f = params.editFlags
      items.push(
        { role: 'undo', enabled: f.canUndo },
        { role: 'redo', enabled: f.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: f.canCut },
        { role: 'copy', enabled: f.canCopy },
        { role: 'paste', enabled: f.canPaste },
        { role: 'pasteAndMatchStyle', enabled: f.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: f.canSelectAll },
      )
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy' })
    }

    while (items.length && items[items.length - 1].type === 'separator') items.pop()
    if (items.length) Menu.buildFromTemplate(items).popup()
  })
}
