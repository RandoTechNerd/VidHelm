// Help: a guided first-run tour, plus the credits and the third-party licences that ship
// inside VidHelm. Opened from the "?" in the header (or by an agent via open_panel help).
import { useState } from 'react'

export type HelpPanel = 'media' | 'sfx' | 'booth' | 'narration' | 'thumbnail' | 'settings' | 'connect' | 'model3d'

// Everything VidHelm ships or downloads, with the licence it arrives under. FFmpeg is first
// because it is the one with real obligations attached.
const LICENCES: { name: string; licence: string; note: string }[] = [
  { name: 'FFmpeg + FFprobe', licence: 'GPL-3.0-or-later', note: 'Bundled binaries (gyan.dev build) that do all decoding, rendering and analysis. Includes x264, x265, libvpx, Opus and more.' },
  { name: 'Electron', licence: 'MIT', note: 'The desktop shell. Its own licence file ships next to the app.' },
  { name: 'Chromium', licence: 'BSD-3-Clause and others', note: 'Rendering engine inside Electron; full notices ship as LICENSES.chromium.html.' },
  { name: 'React and React DOM', licence: 'MIT', note: 'The interface.' },
  { name: 'three.js', licence: 'MIT', note: 'The 3D Studio viewer and turntable renderer.' },
  { name: '@huggingface/transformers', licence: 'Apache-2.0', note: 'Runs Whisper on your machine for captions and script drafting.' },
  { name: 'Whisper (tiny.en and friends)', licence: 'MIT', note: 'Speech model by OpenAI, downloaded on first use rather than bundled.' },
  { name: 'sharp', licence: 'Apache-2.0', note: 'Image work, including thumbnail composition.' },
  { name: 'fluent-ffmpeg', licence: 'MIT', note: 'Builds the FFmpeg command lines.' },
  { name: 'Roughly 85 further npm packages', licence: 'MIT / BSD / ISC / Apache-2.0', note: 'The dependency tree behind the above.' },
]

const OPTIONAL = [
  { name: 'audio.cpp', licence: 'Apache-2.0', note: 'Optional local voice cloning and sound generation. Not bundled, you install it yourself.' },
  { name: 'XTTS-v2 (Coqui)', licence: 'CPML, non-commercial', note: 'Optional voice cloning. The model weights are non-commercial; prefer an Apache-licensed audio.cpp model for monetised videos.' },
  { name: 'Adversal', licence: 'third-party service', note: 'Optional video analysis for your assistant. Not bundled.' },
]

export function HelpModal({ open, onClose, onOpenPanel, onTour, onChat, version }: {
  open: boolean; onClose: () => void
  onOpenPanel: (panel: HelpPanel) => void
  onTour: () => void; onChat: () => void
  version: string
}) {
  const [tab, setTab] = useState<'start' | 'credits'>('start')
  if (!open) return null
  const go = (fn: () => void) => () => { onClose(); fn() }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal help-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Welcome aboard</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="conn-clients">
            <button className={`recipe-chip ${tab === 'start' ? 'on' : ''}`} onClick={() => setTab('start')}>Getting started</button>
            <button className={`recipe-chip ${tab === 'credits' ? 'on' : ''}`} onClick={() => setTab('credits')}>Credits &amp; licences</button>
          </div>

          {tab === 'start' ? (
            <section className="help-start">
              <div className="help-cards">
                <button onClick={go(onTour)}><b>Take the tour</b><span>Thirty seconds, pointing at the real buttons.</span></button>
                <button onClick={go(onChat)}><b>Ask the help chat</b><span>Questions in plain words, answered right in the app.</span></button>
                <button onClick={go(() => onOpenPanel('connect'))}><b>Connect your AI</b><span>Let an assistant edit with you. About a minute.</span></button>
              </div>
              <h3>A first video in five moves</h3>
              <ol className="help-steps">
                <li><b>Pick the shape</b> at the top: Landscape, Portrait or Square.</li>
                <li><b>Drop your footage</b> on the timeline (or into Media).</li>
                <li><b>Tighten it</b> with Cut Pauses, then Takes to keep your best lines.</li>
                <li><b>Tap M</b> on the beats that matter, then add text, sound effects and captions.</li>
                <li><b>Export</b> at the top right, then Watch &amp; Verify before you upload.</li>
              </ol>
              <p className="hint">VidHelm works fine by hand, but it is built to be flown with an AI co-pilot: connect one and it reads your tag points, drops effects on every beat, writes titles and runs your whole routine from one sentence. Nothing here is a wrong turn: every edit is undoable with Ctrl+Z, and nothing touches your original files.</p>
            </section>
          ) : (
            <>
              <section>
                <h3>Thanks</h3>
                <p className="hint" style={{ lineHeight: 1.6 }}>
                  VidHelm is built by <b>RandoTechNerd</b>. Special thanks to <b>inventinside</b>, now a contributor on GitHub, whose feedback drove a good chunk of what this app can do, the ideas kept coming and the app kept growing because of them.
                </p>
                <p className="hint">Found something rough, or want it to do something it doesn’t? Open an issue on GitHub, that is exactly how the list above got written.</p>
                <p className="hint" style={{ color: 'var(--accent-warning)' }}>Buying a coffee? Put <b>"VidHelm"</b> in the comment so it lands against the right project (there are a few on that page), and add the feature you want next while you are there.</p>
              </section>

              <section>
                <div className="sec-title"><h3>What VidHelm is built on</h3></div>
                <p className="hint">Everything below ships inside the app (or downloads on first use) and stays on your machine.</p>
                <div className="lic-list">
                  {LICENCES.map(l => (
                    <div className="lic-row" key={l.name}>
                      <div><b>{l.name}</b> <span className="lic-tag">{l.licence}</span></div>
                      <div className="hint" style={{ margin: 0 }}>{l.note}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <div className="sec-title"><h3>Optional extras you can add</h3></div>
                <div className="lic-list">
                  {OPTIONAL.map(l => (
                    <div className="lic-row" key={l.name}>
                      <div><b>{l.name}</b> <span className="lic-tag">{l.licence}</span></div>
                      <div className="hint" style={{ margin: 0 }}>{l.note}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h3>VidHelm itself</h3>
                <p className="hint">MIT licensed, use it, change it, ship it. The full text, the third-party notices and FFmpeg's GPL licence also ship with the app, in the <code>licences</code> folder next to the program.</p>
                <div className="conn-actions">
                  <button onClick={() => window.ipcRenderer.openExternal('https://github.com/RandoTechNerd/VidHelm/blob/main/LICENSE')}>VidHelm licence ↗</button>
                  <button onClick={() => window.ipcRenderer.openExternal('https://github.com/RandoTechNerd/VidHelm/blob/main/THIRD-PARTY-NOTICES.md')}>Third-party notices ↗</button>
                  <button onClick={() => window.ipcRenderer.openExternal('https://github.com/RandoTechNerd/VidHelm')}>GitHub ↗</button>
                </div>
              </section>
            </>
          )}
        </div>
        <div className="modal-foot"><span>VidHelm {version} · you take the helm, your AI crews the busywork</span></div>
      </div>
    </div>
  )
}

/** A verbose hint collapsed behind a small (i), click to expand, click again to tuck away. */
export function InfoNote({ children, label = 'What can I put here?' }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="info-note">
      <button className={`info-toggle ${open ? 'on' : ''}`} onClick={() => setOpen(o => !o)} title={open ? 'Hide' : label}>
        <span aria-hidden>ⓘ</span> {open ? 'Hide' : label}
      </button>
      {open && <div className="info-body">{children}</div>}
    </div>
  )
}
