/**
 * Where the editor window may go, and what a page may open.
 *
 * The editor window carries the privileged preload (the whole ipcRenderer bridge), so whatever
 * page it shows can read and write files through it. A file dropped outside a drop target, or a
 * stray link, used to NAVIGATE that window: drop an .html file and it ran with the bridge
 * attached, and the timeline was gone. The window may only ever show the app itself; everything
 * else is refused, and a web link asked to open in a new window goes to the real browser.
 *
 * Pure module: no Electron. main.ts wires these into will-navigate and setWindowOpenHandler.
 */

/** The app's own page: the dev server's origin while developing, the built index.html when packaged. */
export interface AppPage { devServer?: string | null; indexUrl?: string | null }

const normFilePath = (p: string) => {
  try { return decodeURIComponent(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() } catch { return p.toLowerCase() }
}

/** True when `target` is the app itself (a reload or a hash change), false for anywhere else. */
export function isAppNavigation(target: string, app: AppPage): boolean {
  let u: URL
  try { u = new URL(target) } catch { return false }
  if (app.devServer) {
    try { if (u.origin === new URL(app.devServer).origin && /^https?:$/.test(u.protocol)) return true } catch { /* not a URL: no dev server */ }
  }
  if (app.indexUrl && u.protocol === 'file:') {
    try {
      const want = new URL(app.indexUrl)
      // Windows paths are case-insensitive, and the query or hash never changes which page it is
      return want.protocol === 'file:' && normFilePath(u.host + u.pathname) === normFilePath(want.host + want.pathname)
    } catch { return false }
  }
  return false
}

/** A link a page asked to open in a new window: the URL to hand to the system browser, or null to drop it. */
export function externalLink(target: string): string | null {
  try {
    const u = new URL(target)
    return u.protocol === 'https:' ? u.href : null
  } catch { return null }
}
