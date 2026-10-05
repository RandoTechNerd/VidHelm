// Recorded takes on disk. Kept out of extras.tsx, which holds only components, so React Fast
// Refresh can hot-swap those panels (react-refresh/only-export-components).

/** Save a recorded take (voiceover or booth) somewhere that lasts: <project>/voice when a project
 *  folder is open, otherwise the app's own recordings folder, never %TEMP%, which Windows cleans
 *  out from under saved projects. The bytes go over IPC as they are (structured clone): turning
 *  them into base64 one character per byte used to balloon memory on long takes. If the project
 *  folder cannot be written, main keeps the take in its own folder and the next Save moves it in. */
export async function saveTake(blob: Blob, projectDir?: string | null): Promise<{ path: string; keptElsewhere: boolean }> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (!bytes.length) throw new Error('nothing was recorded')
  const dir = projectDir ? `${projectDir.replace(/[\\/]+$/, '')}/voice` : undefined
  const r: unknown = await window.ipcRenderer.saveRecording(bytes, dir)
  const p = typeof r === 'string' ? r : (r as { path?: string } | null)?.path
  if (!p) throw new Error((r as { error?: string } | null)?.error || 'no file was written')
  // keptElsewhere: the project folder could not be written, so main kept it in its own folder
  const norm = (s: string) => s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return { path: p, keptElsewhere: !!projectDir && !norm(p).startsWith(norm(projectDir) + '\\') }
}
