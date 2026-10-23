/** IPC channel names shared by main and preload. */
export const IPC = {
  fetchLinkPreview: 'desktop:fetch-link-preview',
  fetchImage: 'desktop:fetch-image',
  takePendingOpenUrl: 'desktop:take-pending-open-url',
  getSettings: 'desktop:get-settings',
  setSettings: 'desktop:set-settings',
  saveFile: 'desktop:save-file',
  openExternal: 'desktop:open-external',
  printToPdf: 'desktop:print-to-pdf',
  /** main → renderer: an invite deep link was opened while the app runs. */
  openUrl: 'desktop:open-url',
  /** renderer → main: number of onOpenUrl subscribers changed (0 = queue links instead). */
  openUrlListeners: 'desktop:open-url-listeners',
} as const

/** Passed through webPreferences.additionalArguments so the sandboxed preload can read it. */
export const APP_VERSION_ARG = '--noema-app-version='
