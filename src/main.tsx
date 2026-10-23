import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './styles/base.css'
import './styles/board.css'
import { App } from './app/App'
import { startSync } from './collab/sync'
import { APP_NAME } from './config'
import { startRelaySync } from './collab/relay'
import { initTheme } from './ui/theme'
import { initDeepLinks } from './app/deeplinks'

document.title = APP_NAME

// Ask the browser not to evict our boards under storage pressure.
void navigator.storage?.persist?.().catch(() => {})

// Files dropped outside a drop target would otherwise replace the app with the file.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
  })
}

initTheme()
startSync()
startRelaySync()
initDeepLinks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
