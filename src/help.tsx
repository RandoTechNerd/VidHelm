// Help: a guided first-run tour, plus the credits and the third-party licences that ship
// inside VidHelm. Opened from the "?" in the header (or by an agent via open_panel help).
import { useState } from 'react'

export type HelpPanel = 'media' | 'sfx' | 'booth' | 'narration' | 'thumbnail' | 'settings' | 'connect' | 'model3d'

const TOUR: { title: string; body: string; go?: { label: string; panel: HelpPanel } }[] = [
  {
    title: 'Welcome — you take the helm',
    body: 'VidHelm is a normal video editor you can drive by hand, and it is at its best with an AI co-captain sitting alongside you, doing the busywork while you make the calls. That part comes at the end of this tour — for now, here is the hand-driven version.',
  },
  {
    title: '1 · Bring in your footage',
    body: 'Drag a video straight onto the timeline, or drop it in the Media Bin first. Audio, images and 3D models work too — anything VidHelm can’t use is refused with a reason rather than landing as a broken clip.',
    go: { label: 'Open the Media Bin', panel: 'media' },
  },
  {
    title: '1b · Or skip importing entirely',
    body: 'In Settings, point VidHelm at a project folder. Every sub-folder inside it becomes a project, and opening one loads the footage sitting in that folder — so dropping files in with Explorer is the import. Saving writes back to the same folder, which makes a project something you can copy or back up like anything else.',
    go: { label: 'Set up a project folder', panel: 'settings' },
  },
  {
    title: '2 · Mark the beats',
    body: 'Play it through once and tap M wherever something happens — a joke landing, a reveal, a cut. Those tag points become the skeleton of the edit: sound effects, captions and narration all snap to them, and your AI reads them too.',
  },
  {
    title: '3 · Tighten it up',
    body: 'Cut Pauses finds dead air (or motionless stretches in silent footage) and ripples it out with clean crossfades. It is undoable, so run it early and see how it feels.',
  },
  {
    title: '4 · Give it a voice',
    body: 'Voiceover records at the playhead. The Booth plays your video while your script scrolls in time so you can read the whole thing in one take. Narrate generates lines in a cloned voice — the wizard there sets up a free local engine for you.',
    go: { label: 'Open the Booth', panel: 'booth' },
  },
  {
    title: '5 · Sound and sparkle',
    body: 'The SFX tab has thirteen built-in effects, synthesized on your machine — audition one, then drop it on a tag point. You can generate new ones from a text description, or drop your own files in.',
    go: { label: 'Open the SFX library', panel: 'sfx' },
  },
  {
    title: '6 · Print showcase (optional)',
    body: 'Drop an STL, 3MF, OBJ or GLB in and the 3D Studio spins it into a clip. Pick a transparent backdrop and a still becomes an overlay that sits on top of your footage.',
    go: { label: 'Open the 3D Studio', panel: 'model3d' },
  },
  {
    title: '7 · Export, checked',
    body: 'Pick your format on the right and hit Export Video. Watch & Verify then checks the finished file the way a platform would — resolution, loudness, true peak, black frames — so you know it is upload-ready before you upload it.',
  },
  {
    title: '8 · Let your AI drive (the fun part)',
    body: 'Connect an assistant and it works the same timeline you do: reading your tag points, dropping effects, writing titles, exporting. You stay in the chair — it does the busywork.',
    go: { label: 'Connect your AI', panel: 'connect' },
  },
]

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
  { name: 'audio.cpp', licence: 'Apache-2.0', note: 'Optional local voice cloning and sound generation. Not bundled — you install it yourself.' },
  { name: 'XTTS-v2 (Coqui)', licence: 'CPML — non-commercial', note: 'Optional voice cloning. The model weights are non-commercial; prefer an Apache-licensed audio.cpp model for monetised videos.' },
  { name: 'Adversal', licence: 'third-party service', note: 'Optional video analysis for your assistant. Not bundled.' },
]

export function HelpModal({ open, onClose, onOpenPanel, version }: {
  open: boolean; onClose: () => void
  onOpenPanel: (panel: HelpPanel) => void
  version: string
}) {
  const [tab, setTab] = useState<'tour' | 'credits'>('tour')
  const [step, setStep] = useState(0)
  if (!open) return null
  const s = TOUR[step]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal help-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Welcome aboard</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="conn-clients">
            <button className={`recipe-chip ${tab === 'tour' ? 'on' : ''}`} onClick={() => setTab('tour')}>Take the tour</button>
            <button className={`recipe-chip ${tab === 'credits' ? 'on' : ''}`} onClick={() => setTab('credits')}>Credits &amp; licences</button>
          </div>

          {tab === 'tour' ? (
            <section className="help-tour">
              <div className="help-dots">
                {TOUR.map((_, i) => <button key={i} className={`help-dot ${i === step ? 'on' : ''}`} onClick={() => setStep(i)} title={`Step ${i + 1}`} />)}
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <div className="help-actions">
                <button disabled={step === 0} onClick={() => setStep(step - 1)}>← Back</button>
                {step < TOUR.length - 1
                  ? <button className="primary" onClick={() => setStep(step + 1)}>Next →</button>
                  : <button className="primary" onClick={onClose}>Start editing</button>}
                {s.go && <button onClick={() => { onOpenPanel(s.go!.panel); onClose() }}>{s.go.label}</button>}
              </div>
              <p className="hint">Nothing here is a wrong turn — every edit is undoable with Ctrl+Z, and nothing touches your original files.</p>
            </section>
          ) : (
            <>
              <section>
                <h3>Thanks</h3>
                <p className="hint" style={{ lineHeight: 1.6 }}>
                  VidHelm is built by <b>RandoTechNerd</b>. Special thanks to <b>inventinside</b>, now a contributor on GitHub, whose feedback drove a good chunk of what this app can do — the ideas kept coming and the app kept growing because of them.
                </p>
                <p className="hint">Found something rough, or want it to do something it doesn’t? Open an issue on GitHub — that is exactly how the list above got written.</p>
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
                <p className="hint">MIT licensed — use it, change it, ship it. Full text and the third-party notices live in the repository.</p>
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

/** A verbose hint collapsed behind a small (i) — click to expand, click again to tuck away. */
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
