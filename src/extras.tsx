// VidHelm add-on panels: SFX library, timeline markers, karaoke booth, cloned-voice narration.
// All components are props-driven; App.tsx owns the state.
import { useState, useRef, useEffect } from 'react'

export interface Marker { id: string; t: number; label: string; color: string }
export interface SfxItem { name: string; path: string; duration: number; builtin: boolean }

const rid = () => Math.random().toString(36).substr(2, 9)
export const MARKER_COLORS = ['#f472b6', '#60a5fa', '#4ade80', '#facc15', '#c084fc', '#fb923c']
export const newMarker = (t: number, label = ''): Marker => ({ id: rid(), t, label, color: MARKER_COLORS[Math.floor(Math.random() * MARKER_COLORS.length)] })

const fileUrl = (p?: string | null) => p
  ? 'file:///' + p.replace(/\\/g, '/').split('/').map((seg, i) => i === 0 ? seg : encodeURIComponent(seg)).join('/')
  : ''
const fmtT = (s: number) => `${Math.floor(s / 60)}:${(Math.floor(s % 60)).toString().padStart(2, '0')}.${Math.floor((s % 1) * 10)}`

// ---------------- SFX library panel ----------------
export function SfxPanel({ onPlace }: { onPlace: (item: SfxItem) => void }) {
  const [items, setItems] = useState<SfxItem[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const load = () => window.ipcRenderer.sfxLibrary()
    .then(r => setItems(r.items || []))
    .catch(e => setErr(String(e)))
  useEffect(() => { load() }, [])

  const audition = (item: SfxItem) => {
    audioRef.current?.pause()
    const a = new Audio(fileUrl(item.path))
    audioRef.current = a
    setPlaying(item.path)
    a.onended = () => setPlaying(null)
    a.play().catch(() => setPlaying(null))
  }

  return (
    <div className="sfx-panel">
      {err && <div className="empty-hint">{err}</div>}
      {!err && items.length === 0 && <div className="empty-hint">Generating sound library…</div>}
      <div className="sfx-list">
        {items.map(item => (
          <div key={item.path} className={`sfx-item ${playing === item.path ? 'playing' : ''}`}>
            <button className="sfx-play" title="Audition" onClick={() => audition(item)}>{playing === item.path ? '◼' : '▶'}</button>
            <span className="sfx-name" title={item.builtin ? 'Built-in (synthesized)' : 'Custom sound'}>{item.name}</span>
            <span className="sfx-dur">{item.duration.toFixed(1)}s</span>
            <button className="sfx-add" title="Place on the SFX track at the playhead" onClick={() => onPlace(item)}>+</button>
          </div>
        ))}
      </div>
      <div className="sfx-foot">
        <button onClick={() => window.ipcRenderer.openSfxFolder()}>Add your own…</button>
        <button onClick={load} title="Rescan the custom folder">↻</button>
      </div>
    </div>
  )
}

// ---------------- Marker (tag point) panel ----------------
export function MarkerPanel({ markers, currentTime, onChange, onSeek }: {
  markers: Marker[]; currentTime: number
  onChange: (m: Marker[]) => void; onSeek: (t: number) => void
}) {
  const sorted = [...markers].sort((a, b) => a.t - b.t)
  return (
    <div className="marker-panel">
      <button className="marker-add" onClick={() => onChange([...markers, newMarker(currentTime)])}>+ Tag at {fmtT(currentTime)} <kbd>M</kbd></button>
      {sorted.length === 0 && <p className="hint">Tag points mark beats in your video — a joke landing, a reveal, a cut point. Press <b>M</b> while playing to drop one. Use them to line up SFX, captions and narration.</p>}
      <div className="marker-list">
        {sorted.map(m => (
          <div key={m.id} className="marker-row">
            <button className="marker-dot" style={{ background: m.color }} title="Jump to tag" onClick={() => onSeek(m.t)} />
            <input className="marker-name" placeholder="label…" value={m.label}
              onChange={e => onChange(markers.map(x => x.id === m.id ? { ...x, label: e.target.value } : x))} />
            <span className="marker-time" onClick={() => onSeek(m.t)}>{fmtT(m.t)}</span>
            <button className="marker-del" title="Delete tag" onClick={() => onChange(markers.filter(x => x.id !== m.id))}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------- Karaoke booth ----------------
// One-take read-along recording over the timeline. Cue lines come from the script box;
// each line is timed either evenly across the video or pinned to your tag points.
export function KaraokeBooth({ open, onClose, markers, totalDuration, currentTime, onSeek, onPlay, onRecorded }: {
  open: boolean; onClose: () => void
  markers: Marker[]; totalDuration: number; currentTime: number; isPlaying: boolean
  onSeek: (t: number) => void; onPlay: (p: boolean) => void
  onRecorded: (path: string, startAt: number) => void
}) {
  const [script, setScript] = useState('')
  const [useMarkers, setUseMarkers] = useState(true)
  const [recording, setRecording] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [level, setLevel] = useState(0)
  const [status, setStatus] = useState('')
  const recRef = useRef<{ rec: MediaRecorder; stream: MediaStream } | null>(null)
  const meterRaf = useRef(0)

  const lines = script.split('\n').map(l => l.trim()).filter(Boolean)
  const sortedMarkers = [...markers].sort((a, b) => a.t - b.t)
  // cue start time for line i
  const cueT = (i: number) => {
    if (useMarkers && sortedMarkers.length >= lines.length && lines.length > 0) return sortedMarkers[i].t
    return lines.length ? (i * totalDuration) / lines.length : 0
  }
  const curIdx = lines.length ? Math.max(0, lines.findLastIndex((_, i) => currentTime >= cueT(i))) : -1

  useEffect(() => () => { cancelAnimationFrame(meterRaf.current); recRef.current?.stream.getTracks().forEach(t => t.stop()) }, [])

  // auto-stop at the end of the timeline
  useEffect(() => {
    if (recording && currentTime >= totalDuration - 0.05) stop()
  }, [currentTime, recording, totalDuration])

  const start = async () => {
    if (totalDuration <= 0) { setStatus('Put something on the timeline first.'); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false } })
      // live level meter
      const ac = new AudioContext()
      const an = ac.createAnalyser(); an.fftSize = 512
      ac.createMediaStreamSource(stream).connect(an)
      const buf = new Uint8Array(an.fftSize)
      const meter = () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) { const x = Math.abs(v - 128); if (x > m) m = x } setLevel(m / 70); meterRaf.current = requestAnimationFrame(meter) }
      meter()
      for (const n of [3, 2, 1]) { setCountdown(n); await new Promise(r => setTimeout(r, 650)) }
      setCountdown(null)
      const rec = new MediaRecorder(stream, { audioBitsPerSecond: 192000 })
      const chunks: Blob[] = []
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        cancelAnimationFrame(meterRaf.current)
        const blob = new Blob(chunks, { type: 'audio/webm' })
        const buf2 = new Uint8Array(await blob.arrayBuffer())
        let bin = ''
        for (let i = 0; i < buf2.length; i += 0x8000) bin += String.fromCharCode(...Array.from(buf2.subarray(i, i + 0x8000)))
        const path = await window.ipcRenderer.saveRecording(btoa(bin))
        setStatus('Take saved and placed on the voice track ✓')
        onRecorded(path, 0)
      }
      recRef.current = { rec, stream }
      onSeek(0); onPlay(true)
      rec.start()
      setRecording(true)
      setStatus('Recording — read along')
    } catch (e) { console.error(e); setStatus('Microphone blocked — allow access and retry.') }
  }

  const stop = () => {
    onPlay(false)
    setRecording(false)
    if (recRef.current && recRef.current.rec.state !== 'inactive') recRef.current.rec.stop()
  }

  if (!open) return null
  return (
    <div className="booth">
      <div className="booth-head">
        <b>🎙 Karaoke booth</b>
        <span className="booth-status">{status}</span>
        <div className="booth-meter"><i style={{ width: `${Math.min(100, level * 100)}%` }} /></div>
        <button className="modal-close" onClick={() => { if (recording) stop(); onClose() }}>✕</button>
      </div>
      {lines.length > 0 ? (
        <div className="booth-cues">
          <div className="booth-line">{curIdx >= 0 ? lines[curIdx] : lines[0]}</div>
          <div className="booth-next">{curIdx + 1 < lines.length ? `next: ${lines[curIdx + 1]}` : ''}</div>
        </div>
      ) : (
        <textarea className="booth-script" rows={4} placeholder={'Paste your script — one line per beat.\nLines light up as the video plays; read along in one take.'} value={script} onChange={e => setScript(e.target.value)} />
      )}
      {lines.length > 0 && !recording && <button className="booth-edit" onClick={() => setScript(s => s + ' ')}>edit script</button>}
      <div className="booth-controls">
        <button className={`booth-rec ${recording ? 'on' : ''}`} onClick={() => recording ? stop() : start()}>
          {recording ? '■ Stop' : '● Record take'}
        </button>
        <label className="switch" title="Pin each line to your tag points (needs at least as many tags as lines); otherwise lines are spread evenly">
          <input type="checkbox" checked={useMarkers} onChange={e => setUseMarkers(e.target.checked)} /> time lines with tag points
        </label>
        <span className="hint" style={{ margin: 0 }}>{lines.length} line{lines.length === 1 ? '' : 's'} · {sortedMarkers.length} tag{sortedMarkers.length === 1 ? '' : 's'}</span>
      </div>
      {countdown !== null && <div className="booth-count">{countdown}</div>}
    </div>
  )
}

// ---------------- Start Recipe ----------------
// "Start G-code" for videos: a plain-text block of standing instructions that runs when you
// (or your AI) kick off a project. Lines starting with # are off. Toggles below rewrite the
// text; free-typed lines are preserved and shown to the AI via the agent bridge.
export interface RecipeSettings { text: string; introAudioPath: string | null }

export const RECIPE_TOGGLES: { key: string; label: string; hint: string }[] = [
  { key: 'cut-pauses', label: 'Cut dead air', hint: 'remove silent/static pauses first' },
  { key: 'thumbnail', label: 'Thumbnail', hint: 'pick a frame, add subtitle + logo' },
  { key: 'subtitle', label: 'Catchy subtitle', hint: 'one-liner burned onto the thumbnail' },
  { key: 'titles', label: '5 title options', hint: 'your AI pitches titles, you pick' },
  { key: 'logo', label: 'Brand logo', hint: 'watermark on every export' },
  { key: 'intro-audio', label: 'Intro audio', hint: 'your sting placed at 0:00' },
  { key: 'captions', label: 'Captions', hint: 'on-device Whisper subtitles' },
]

export const DEFAULT_RECIPE = `# ── Start Recipe — runs when you (or your AI) kick off a video ──
cut-pauses           # tighten dead air before anything else
thumbnail            # sample frames, pick one in the picker
subtitle             # catchy one-liner on the thumbnail
titles 5             # AI pitches 5 title options, you pick
logo bottom-right    # brand watermark (set it in Brand Kit above)
intro-audio          # your intro sting at 0:00 (pick it below)
# captions           # on-device Whisper captions
# anything you type here is passed to your AI as standing instructions`

const lineKey = (line: string) => line.replace(/^#/, '').trim().split(/\s+/)[0] || ''
export const recipeActive = (text: string): Record<string, boolean> => {
  const state: Record<string, boolean> = {}
  for (const t of RECIPE_TOGGLES) state[t.key] = false
  for (const raw of text.split('\n')) {
    const key = lineKey(raw)
    if (key && state[key] !== undefined && !raw.trim().startsWith('#')) state[key] = true
  }
  return state
}
export const toggleRecipeLine = (text: string, key: string, on: boolean): string => {
  const lines = text.split('\n')
  let found = false
  const out = lines.map(raw => {
    if (lineKey(raw) !== key) return raw
    found = true
    const isOff = raw.trim().startsWith('#')
    if (on && isOff) return raw.replace(/^(\s*)#\s?/, '$1')
    if (!on && !isOff) return '# ' + raw
    return raw
  })
  if (on && !found) out.push(key)
  return out.join('\n')
}

export function RecipeSection({ recipe, onChange, logoPath, onPickLogo }: {
  recipe: RecipeSettings; onChange: (r: RecipeSettings) => void
  logoPath: string | null; onPickLogo: () => void
}) {
  const active = recipeActive(recipe.text)
  return (
    <section>
      <div className="sec-title">
        <h3>Start Recipe <span className="hint" style={{ fontWeight: 400 }}>— your defaults, like start G-code. <b>#</b> = off</span></h3>
      </div>
      <div className="recipe-toggles">
        {RECIPE_TOGGLES.map(t => (
          <button key={t.key} className={`recipe-chip ${active[t.key] ? 'on' : ''}`} title={t.hint}
            onClick={() => onChange({ ...recipe, text: toggleRecipeLine(recipe.text, t.key, !active[t.key]) })}>
            {active[t.key] ? '●' : '○'} {t.label}
          </button>
        ))}
      </div>
      <textarea className="recipe-text" rows={9} spellCheck={false} value={recipe.text}
        onChange={e => onChange({ ...recipe, text: e.target.value })} />
      <div className="recipe-files">
        <div className="recipe-file">
          <span>Intro audio:</span>
          <button onClick={async () => { const p = await window.ipcRenderer.pickAudio(); if (p) onChange({ ...recipe, introAudioPath: p }) }}>
            {recipe.introAudioPath ? recipe.introAudioPath.split(/[\\/]/).pop() : 'Choose…'}
          </button>
          {recipe.introAudioPath && <button onClick={() => onChange({ ...recipe, introAudioPath: null })}>✕</button>}
        </div>
        <div className="recipe-file">
          <span>Logo:</span>
          <button onClick={onPickLogo}>{logoPath ? logoPath.split(/[\\/]/).pop() : 'Choose PNG…'}</button>
        </div>
      </div>
      <p className="hint">Hit <b>🚀 Recipe</b> in the header to run it on the current timeline. Steps your AI handles (titles, subtitle ideas, free-typed lines) are picked up automatically when it reads the project.</p>
    </section>
  )
}

// ---------------- Thumbnail picker ----------------
export function ThumbnailModal({ open, onClose, videoPath, videoName, logoPath }: {
  open: boolean; onClose: () => void
  videoPath: string | null; videoName: string; logoPath: string | null
}) {
  const [frames, setFrames] = useState<{ t: number; path: string }[]>([])
  const [sel, setSel] = useState<number | null>(null)
  const [subtitle, setSubtitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (open && !videoPath) { setFrames([]); setStatus('No video yet — drag one into the Media Bin (or onto the timeline), then reopen this picker.'); return }
    if (!open || !videoPath) return
    setFrames([]); setSel(null); setStatus('Sampling frames…')
    window.ipcRenderer.sampleFrames({ filePath: videoPath, count: 8 }).then(r => {
      if (r.frames?.length) { setFrames(r.frames); setStatus('') }
      else setStatus(r.error || 'No frames found')
    })
  }, [open, videoPath])

  const save = async () => {
    if (sel === null || !videoPath) return
    const out = await window.ipcRenderer.selectSavePath(`${videoName.replace(/\.[^.]+$/, '')}_thumbnail.png`)
    if (!out) return
    setBusy(true); setStatus('Composing…')
    const r = await window.ipcRenderer.composeThumbnail({ filePath: videoPath, t: frames[sel].t, subtitle, logoPath, outPath: out })
    setBusy(false)
    if (r.ok) { setStatus('Saved ✓'); window.ipcRenderer.revealFile(out) }
    else setStatus(r.error || 'failed')
  }

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h2>Pick a thumbnail frame</h2><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {status && <p className="hint">{status}</p>}
          <div className="thumb-grid">
            {frames.map((f, i) => (
              <button key={f.path} className={`thumb-cand ${sel === i ? 'selected' : ''}`} onClick={() => setSel(i)}>
                <img src={fileUrl(f.path)} alt="" /><span>{f.t.toFixed(1)}s</span>
              </button>
            ))}
          </div>
          <section>
            <h3>Catchy subtitle (burned on, bottom-left)</h3>
            <input className="duration-input" style={{ width: '100%' }} placeholder="e.g.  Hide parts INSIDE your prints" value={subtitle} onChange={e => setSubtitle(e.target.value)} />
            <p className="hint">{logoPath ? 'Your logo goes top-right automatically.' : 'Tip: set a logo in Settings → Brand Kit and it’s added top-right automatically.'}</p>
          </section>
        </div>
        <div className="modal-foot">
          <span>1280×720 PNG — YouTube-ready</span>
          <button className="primary" disabled={sel === null || busy} onClick={save}>{busy ? 'Composing…' : 'Save thumbnail…'}</button>
        </div>
      </div>
    </div>
  )
}

// ---------------- Cloned-voice narration ----------------
export function NarrationModal({ open, onClose, command, onCommand, onGenerated }: {
  open: boolean; onClose: () => void
  command: string; onCommand: (c: string) => void
  onGenerated: (files: string[], lines: string[]) => void
}) {
  const [script, setScript] = useState('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState('')

  useEffect(() => {
    const h = (_e: any, chunk: string) => setLog(l => (l + chunk).slice(-4000))
    window.ipcRenderer.on('voice-clone-progress', h)
    return () => window.ipcRenderer.off('voice-clone-progress', h)
  }, [])

  const run = async () => {
    setBusy(true); setLog('')
    try {
      const r = await window.ipcRenderer.voiceClone({ command, scriptText: script })
      if (r.error) setLog(l => l + '\n' + r.error)
      else if (r.files) onGenerated(r.files, script.split('\n').map(s => s.trim()).filter(Boolean))
    } catch (e) { setLog(String(e)) }
    setBusy(false)
  }

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h2>Narrate with a cloned voice</h2><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <section>
            <h3>Script — one line per scene</h3>
            <textarea className="booth-script" rows={6} placeholder={'In 1959, a scientist looked down a microscope…\nEverybody has 46. He counted 45.'} value={script} onChange={e => setScript(e.target.value)} />
          </section>
          <section>
            <h3>Narration command</h3>
            <input className="duration-input" style={{ width: '100%' }} placeholder='e.g.  python C:\tools\clone_voice.py my_voice.wav {script} {outdir}' value={command} onChange={e => onCommand(e.target.value)} />
            <p className="hint"><b>{'{script}'}</b> is replaced with a text file of your lines, <b>{'{outdir}'}</b> with a folder your tool should fill with <b>scene_1.wav, scene_2.wav…</b> (one per line). Works with any TTS/voice-clone CLI — see <b>docs/VOICE_CLONE.md</b> for a ready-made XTTS setup.</p>
          </section>
          {log && <pre className="clone-log">{log}</pre>}
        </div>
        <div className="modal-foot">
          <span>{busy ? 'Generating narration…' : 'Generated lines are placed at your tag points (or back-to-back).'}</span>
          <button className="primary" disabled={busy || !script.trim()} onClick={run}>{busy ? 'Running…' : 'Generate narration'}</button>
        </div>
      </div>
    </div>
  )
}
