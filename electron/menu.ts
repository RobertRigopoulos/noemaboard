/** Native application menu. Edit roles matter: without them copy/paste shortcuts fail on macOS. */
import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'

export const PROJECT_URL = 'https://noemaboard.app'
/** Where people report problems and suggest ideas (same as COMMUNITY_URL in src/config.ts). */
const COMMUNITY_URL = 'https://discord.gg/4gcUz2GP3w'

export function buildAppMenu(opts: { onAbout: () => void }): Menu {
  const isMac = process.platform === 'darwin'
  const name = app.getName()

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(!app.isPackaged ? ([{ role: 'forceReload' }, { role: 'toggleDevTools' }] satisfies MenuItemConstructorOptions[]) : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [
        { label: `${name} website`, click: () => void shell.openExternal(PROJECT_URL) },
        { label: 'Report a problem…', click: () => void shell.openExternal(COMMUNITY_URL) },
        ...(!isMac ? ([{ type: 'separator' }, { label: `About ${name}`, click: opts.onAbout }] satisfies MenuItemConstructorOptions[]) : []),
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}
