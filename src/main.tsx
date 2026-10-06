import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installIpcMock } from './ipcMock'
import { holdsDrop, isTextEntry } from './uikit'

installIpcMock() // no-op inside Electron; enables browser-only UI dev

// A file or link dropped where nothing takes drops is opened by Chromium as a PAGE, replacing the
// editor (and an .html file would run with the app's bridge attached). Every such drop is marked
// handled here, in the capture phase so a component that stops propagation cannot skip it; the
// real drop targets (the bin, the tracks, the 3D Studio) still get the event and do the importing.
// main.ts refuses the navigation as well, this keeps the window from ever trying. Because every
// such drop arrives already cancelled, a drop target says it took one by stopping it, not by
// cancelling it (see the editor's own window-wide drop in App.tsx). A link over a text field is
// left alone: Chromium types it into the field rather than navigating (holdsDrop).
const holdDrop = (e: DragEvent) => {
  if (holdsDrop(e.dataTransfer?.types, isTextEntry(e.target as HTMLElement | null))) e.preventDefault()
}
window.addEventListener('dragover', holdDrop, true)
window.addEventListener('drop', holdDrop, true)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
