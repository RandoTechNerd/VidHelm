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

// ---------------- Connect your AI (setup + troubleshooter) ----------------
// One place to wire VidHelm to any MCP-capable assistant: live diagnostics of the
// agent bridge, ready-to-paste configs generated with the real install path, and
// fixes for the usual snags. Agents can open it too (open_panel "connect").
type AgentStatus = Awaited<ReturnType<Window['ipcRenderer']['agentStatus']>>

const CLIENT_DOCS: { id: string; name: string; where: string; kind: 'json' | 'toml' | 'http' | 'auto' }[] = [
  { id: 'claude-code', name: 'Claude Code', where: 'Zero config — open this repo folder and approve the "vidhelm" server when prompted (.mcp.json is auto-discovered). Installed-app users: run the command below once instead.', kind: 'auto' },
  { id: 'claude-desktop', name: 'Claude Desktop', where: 'Settings → Developer → Edit Config, or edit  %APPDATA%\\Claude\\claude_desktop_config.json  — merge this in, then fully restart Claude Desktop.', kind: 'json' },
  { id: 'cursor', name: 'Cursor', where: 'Zero config in the repo (.cursor/mcp.json ships with it). Otherwise: Settings → MCP → Add server, or merge into  %USERPROFILE%\\.cursor\\mcp.json.', kind: 'json' },
  { id: 'vscode', name: 'VS Code (Copilot)', where: 'Zero config in the repo (.vscode/mcp.json ships with it). Otherwise: Command Palette → "MCP: Add Server", or merge into your user mcp.json.', kind: 'json' },
  { id: 'windsurf', name: 'Windsurf', where: 'Merge into  %USERPROFILE%\\.codeium\\windsurf\\mcp_config.json  then reload Windsurf.', kind: 'json' },
  { id: 'cline', name: 'Cline / Roo', where: 'Extension sidebar → MCP Servers → Configure → merge this into the JSON.', kind: 'json' },
  { id: 'codex', name: 'Codex CLI', where: 'Append to  %USERPROFILE%\\.codex\\config.toml.', kind: 'toml' },
  { id: 'gemini', name: 'Gemini CLI', where: 'Merge into  %USERPROFILE%\\.gemini\\settings.json.', kind: 'json' },
  { id: 'lmstudio', name: 'LM Studio', where: 'Fully local: chat sidebar → Program → Install → Edit mcp.json — merge this in. Pick a model that supports tool use (Qwen, Llama 3.1+, Mistral…) and toggle on just the VidHelm tools you need for small models.', kind: 'json' },
  { id: 'jan', name: 'Jan', where: 'Fully local: Settings → MCP Servers (enable the experimental toggle) → add server, or merge this into its JSON.', kind: 'json' },
  { id: 'openwebui', name: 'Open WebUI', where: 'Open WebUI speaks OpenAPI tool servers, not MCP — run the mcpo proxy below, then add http://localhost:8001 under Settings → Tools.', kind: 'http' },
  { id: 'localmodels', name: 'Ollama / Lemonade', where: 'Ollama, AMD Lemonade Server, llama.cpp & co. serve the model but are not agents themselves — point an MCP-capable front-end (LM Studio, Cline, Continue, Open WebUI) at your local endpoint, then add VidHelm in that front-end:', kind: 'http' },
  { id: 'http', name: 'Anything else', where: 'No MCP? Any agent that can run shell commands can drive the plain HTTP bridge directly:', kind: 'http' },
]

export function ConnectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [st, setSt] = useState<AgentStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [client, setClient] = useState('claude-code')
  const [copied, setCopied] = useState('')

  const refresh = async () => {
    setBusy(true)
    try { setSt(await window.ipcRenderer.agentStatus()) } catch (e) { console.error(e) }
    setBusy(false)
  }
  useEffect(() => { if (open) refresh() }, [open])

  if (!open) return null

  const port = st?.port ?? 5959
  const mcpPath = st?.mcpFile.path ?? '<path to VidHelm>\\agent\\mcp-server.mjs'
  const jsonPath = mcpPath.replace(/\\/g, '\\\\')
  const stdJson = `{\n  "mcpServers": {\n    "vidhelm": {\n      "command": "node",\n      "args": ["${jsonPath}"]\n    }\n  }\n}`
  const SNIPPETS: Record<string, string> = {
    'claude-code': `claude mcp add vidhelm -- node "${mcpPath}"`,
    'claude-desktop': stdJson,
    'cursor': stdJson,
    'vscode': `{\n  "servers": {\n    "vidhelm": {\n      "type": "stdio",\n      "command": "node",\n      "args": ["${jsonPath}"]\n    }\n  }\n}`,
    'windsurf': stdJson,
    'cline': stdJson,
    'codex': `[mcp_servers.vidhelm]\ncommand = "node"\nargs = ["${jsonPath}"]`,
    'gemini': stdJson,
    'lmstudio': stdJson,
    'jan': stdJson,
    'openwebui': `uvx mcpo --port 8001 -- node "${mcpPath}"`,
    'localmodels': `# 1) In the front-end, set your local model server:\n#      Ollama    http://localhost:11434/v1\n#      Lemonade  http://localhost:8000/api/v1\n# 2) Add VidHelm as an MCP server there (standard shape):\n${stdJson}`,
    'http': `# read the timeline          # drive the editor\ncurl http://127.0.0.1:${port}/state\ncurl -X POST http://127.0.0.1:${port}/command -H "Content-Type: application/json" -d "{\\"action\\":\\"place_sfx\\",\\"name\\":\\"pop\\",\\"t\\":3.2}"`,
  }
  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopied(label); setTimeout(() => setCopied(''), 1600) })
  }
  const cdoc = CLIENT_DOCS.find(c => c.id === client)!

  const Check = ({ ok, label, detail, fix }: { ok: boolean | undefined; label: string; detail?: string; fix?: string }) => (
    <div className={`conn-check ${ok === undefined ? '' : ok ? 'ok' : 'bad'}`}>
      <span className="conn-dot">{ok === undefined ? '…' : ok ? '✓' : '✕'}</span>
      <div><b>{label}</b>{detail && <span className="conn-detail"> — {detail}</span>}
        {ok === false && fix && <div className="conn-fix">{fix}</div>}
      </div>
    </div>
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal conn-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h2>🤖 Connect your AI</h2><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <section>
            <div className="sec-title"><h3>Health check</h3>
              <button onClick={refresh} disabled={busy}>{busy ? 'Testing…' : '↻ Test connection'}</button>
            </div>
            <Check ok={st?.bridge.listening} label={`Agent bridge on port ${port}`}
              detail={st?.bridge.listening ? `http://127.0.0.1:${port}` : st?.bridge.error || undefined}
              fix={`Another program may be using port ${port}. Close it, or launch VidHelm with the environment variable VH_AGENT_PORT set to a free port (and add the same env to your AI client's server config).`} />
            <Check ok={st?.loopback.ok} label="Bridge answers HTTP" detail={st?.loopback.detail}
              fix="The port is open but not answering — restart VidHelm. If a firewall prompt appeared, allow it (the bridge only ever listens on 127.0.0.1, nothing leaves your machine)." />
            <Check ok={st?.mcpFile.ok} label="MCP server file" detail={st?.mcpFile.ok ? mcpPath : `missing: ${mcpPath}`}
              fix="Reinstall VidHelm, or clone the repo — the file is agent/mcp-server.mjs." />
            <Check ok={st?.node.ok} label={`Node.js for your AI client ${st?.node.version ? `(${st.node.version})` : ''}`}
              detail={st?.node.ok ? 'found on PATH' : 'not found on PATH'}
              fix="MCP clients start the server themselves with `node`. Install Node 18+ from nodejs.org, then restart your AI client. (VidHelm itself runs fine without it.)" />
            <p className="hint">All green? Then any failure below is on the client side — pick yours and re-check its config.</p>
          </section>
          <section>
            <div className="sec-title"><h3>Set up your AI of choice</h3></div>
            <div className="conn-clients">
              {CLIENT_DOCS.map(c => (
                <button key={c.id} className={`recipe-chip ${client === c.id ? 'on' : ''}`} onClick={() => setClient(c.id)}>{c.name}</button>
              ))}
            </div>
            <p className="hint">{cdoc.where}</p>
            <pre className="conn-snippet">{SNIPPETS[client]}</pre>
            <div className="conn-actions">
              <button className="primary" onClick={() => copy('snippet', SNIPPETS[client])}>{copied === 'snippet' ? 'Copied ✓' : 'Copy config'}</button>
              <button onClick={() => copy('path', mcpPath)}>{copied === 'path' ? 'Copied ✓' : 'Copy server path'}</button>
              <button onClick={() => window.ipcRenderer.openExternal('https://github.com/RandoTechNerd/VidHelm/blob/main/docs/CONNECT.md')}>Full guide ↗</button>
            </div>
          </section>
          <section>
            <div className="sec-title"><h3>Optional power-ups</h3></div>
            <details><summary>🌐 Claude in Chrome — let your AI upload &amp; film the web</summary>
              <p className="hint">Pair Claude with its Chrome extension and your AI can take the finished export all the way: <b>upload it to YouTube for you</b> (title, description, tags, thumbnail) and pause for your OK before publishing. It can also <b>capture websites or your localhost app</b> — screenshots and walkthrough recordings that drop straight into your timeline as footage. Get it at <code>claude.ai/chrome</code>, then just ask: "upload my export to YouTube" or "record my site's landing page for the intro".</p></details>
            <details><summary>🎞 Adversal AI — your agent understands the footage (optional)</summary>
              <p className="hint">Adversal is a third-party video-analysis MCP: your AI sends it a video and gets back Markdown notes, chapters, and extracted stills — perfect for auto-writing chapters, summaries, and finding the best moments in long source footage before cutting in VidHelm. Free tier is 100 minutes/month; needs Python 3.13+. Setup:</p>
              <pre className="conn-snippet">{'pip install adversal-cli\nclaude mcp add adversal -- adversal-cli'}</pre>
              <p className="hint">Then ask your AI things like "analyze my raw footage and tag the highlights in VidHelm". Details at <code>adversal.ai</code>. Entirely optional — VidHelm never requires it.</p></details>
          </section>
          <section>
            <h3>Still stuck?</h3>
            <details><summary>My AI says "VidHelm is not running"</summary>
              <p className="hint">The bridge only exists while this app is open. Keep VidHelm running, then retry the tool call. (Dev mode: <code>npm run dev</code>.)</p></details>
            <details><summary>I added the config but no tools show up</summary>
              <p className="hint">Fully restart the AI client (most only read MCP configs at startup), make sure the JSON merged cleanly (no trailing commas), and confirm the file path in <code>args</code> exists. In Claude Code, run <code>/mcp</code> to see server status.</p></details>
            <details><summary>Tools exist but every call errors</summary>
              <p className="hint">Run the health check above. If the bridge is green, the client is probably launching the server without Node on PATH, or pointing at an old path after an update — re-copy the config.</p></details>
            <details><summary>Port conflict (bridge check is red)</summary>
              <p className="hint">Set <code>VH_AGENT_PORT</code> to a free port before launching VidHelm, and add <code>"env": {'{'}"VH_AGENT_PORT": "5960"{'}'}</code> to the server entry in your client config so both sides agree.</p></details>
            <details><summary>My local model connects but never uses the tools</summary>
              <p className="hint">The model itself must support tool calling — Qwen 2.5+, Llama 3.1+, and Mistral do; older or heavily-quantized models often don't. Twenty-one tools can also overwhelm small (7B) models: in clients with per-tool toggles (like LM Studio) enable just <code>get_state</code>, <code>screenshot</code>, <code>cut_pauses</code>, <code>place_sfx</code>, and <code>export_video</code> to start.</p></details>
            <details><summary>My assistant doesn't support MCP at all</summary>
              <p className="hint">If it can run shell commands, it can still steer VidHelm over plain HTTP — pick "Anything else" above and paste those curl examples into its instructions. The repo also ships a portable skill file (<code>agent/skills/vidhelm-skill.md</code>) you can paste into any assistant's custom instructions.</p></details>
          </section>
        </div>
        <div className="modal-foot">
          <span>VidHelm {st?.appVersion} · bridge http://127.0.0.1:{port} · local only, nothing leaves your machine</span>
        </div>
      </div>
    </div>
  )
}

// ---------------- Cloned-voice narration ----------------
const VOICE_SAMPLE_TEXT = `Hi, this is my voice sample for VidHelm. I make videos about the things I build, and I like explaining how they work step by step. The quick brown fox jumps over the lazy dog, which covers most of the sounds I'll ever need. When something finally works after ten tries, that's the moment worth recording.`

// One-click voice-clone setup: record a reference sample (or pick a wav), and the app
// writes a ready-to-run XTTS engine (installer + generator script) and fills in the command.
function VoiceWizard({ onCommand }: { onCommand: (c: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [recording, setRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [sample, setSample] = useState<{ base64?: string; path?: string; label: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const recRef = useRef<{ rec: MediaRecorder; stream: MediaStream; raf: number; timer: number } | null>(null)

  useEffect(() => () => { if (recRef.current) { cancelAnimationFrame(recRef.current.raf); clearInterval(recRef.current.timer); recRef.current.stream.getTracks().forEach(t => t.stop()) } }, [])

  const record = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false } })
      const ac = new AudioContext()
      const an = ac.createAnalyser(); an.fftSize = 512
      ac.createMediaStreamSource(stream).connect(an)
      const buf = new Uint8Array(an.fftSize)
      const meter = () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) { const x = Math.abs(v - 128); if (x > m) m = x } setLevel(m / 70); if (recRef.current) recRef.current.raf = requestAnimationFrame(meter) }
      const rec = new MediaRecorder(stream, { audioBitsPerSecond: 192000 })
      const chunks: Blob[] = []
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const b = new Uint8Array(await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer())
        let bin = ''
        for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...Array.from(b.subarray(i, i + 0x8000)))
        setSample({ base64: btoa(bin), label: `recorded sample (${Math.round(elapsedRef.current)}s)` })
        setStatus('Sample recorded ✓ — now create the engine.')
      }
      const t0 = Date.now()
      const timer = window.setInterval(() => { elapsedRef.current = (Date.now() - t0) / 1000; setElapsed(elapsedRef.current) }, 250)
      recRef.current = { rec, stream, raf: 0, timer }
      recRef.current.raf = requestAnimationFrame(meter)
      rec.start()
      setRecording(true)
      setStatus('Reading the sample text aloud — 15 to 30 seconds is perfect.')
    } catch { setStatus('Microphone blocked — allow access and retry.') }
  }
  const elapsedRef = useRef(0)
  const stop = () => {
    setRecording(false)
    if (recRef.current) { cancelAnimationFrame(recRef.current.raf); clearInterval(recRef.current.timer); if (recRef.current.rec.state !== 'inactive') recRef.current.rec.stop(); recRef.current = null }
  }

  const create = async () => {
    if (!sample) return
    setBusy(true); setStatus('Pick a folder in the dialog — the installer opens in its own window (one time, ~2 GB).')
    const r = await window.ipcRenderer.voiceCloneSetup(sample.base64 ? { sampleBase64: sample.base64 } : { samplePath: sample.path })
    if (r.command) {
      onCommand(r.command)
      setStatus('Voice engine created and the command below is filled in ✓ — once the installer window finishes, write a script and hit Generate narration.')
    } else setStatus(r.error || 'canceled')
    setBusy(false)
  }

  return (
    <section className="vc-wizard">
      <div className="sec-title" style={{ cursor: 'pointer' }} onClick={() => setExpanded(e => !e)}>
        <h3>🧬 No cloned voice yet? Create one {expanded ? '▾' : '▸'}</h3>
      </div>
      {expanded && <>
        <p className="hint" style={{ marginTop: 4 }}>Three steps, all free and local: record ~20 seconds of your voice, pick an install folder, and VidHelm sets up the XTTS-v2 engine (needs <b>Python 3.10+</b> from python.org) and fills in the command for you.</p>
        <div className="vc-sample">{VOICE_SAMPLE_TEXT}</div>
        <div className="vc-row">
          <button className={`booth-rec ${recording ? 'on' : ''}`} onClick={() => recording ? stop() : record()}>{recording ? `■ Stop (${elapsed.toFixed(0)}s)` : '● Record sample'}</button>
          {recording && <div className="booth-meter"><i style={{ width: `${Math.min(100, level * 100)}%` }} /></div>}
          <span className="hint" style={{ margin: 0 }}>or</span>
          <button onClick={async () => { const p = await window.ipcRenderer.pickAudio(); if (p) { setSample({ path: p, label: p.split(/[\\/]/).pop() || 'sample' }); setStatus('Sample chosen ✓ — now create the engine.') } }}>Use a WAV/MP3 I have…</button>
          {sample && <button className="primary" disabled={busy} onClick={create}>{busy ? 'Setting up…' : `⚙ Create voice engine (${sample.label})`}</button>}
        </div>
        {status && <p className="hint" style={{ marginTop: 6 }}>{status}</p>}
      </>}
    </section>
  )
}

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
          <VoiceWizard onCommand={onCommand} />
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
