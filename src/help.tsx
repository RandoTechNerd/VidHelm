// Help: the header's Help menu, a getting-started page, plus the credits and the third-party
// licences that ship inside VidHelm. Opened from the "?" in the header (or by an agent via
// open_panel help).
import { useEffect, useState, type ReactNode } from 'react'
import { IcChat, IcChevron, IcClose, IcCoffee, IcDiscord, IcExternal, IcGithub, IcGlobe, IcInfo, IcInstagram, IcMail, IcPlay, IcYoutube } from './icons'

export type HelpPanel = 'media' | 'sfx' | 'booth' | 'narration' | 'thumbnail' | 'settings' | 'connect' | 'model3d'
export type HelpTab = 'start' | 'credits'

// Where to find the people behind VidHelm. These used to be a row of bare icons in the header,
// then sat behind an (i) right next to a look-alike (?); now they are one entry in the Help menu.
const LINKS: { label: string; sub: string; url: string; icon: ReactNode; note?: string }[] = [
  { label: 'vidhelm.com', sub: 'downloads and news', url: 'https://vidhelm.com', icon: <IcGlobe size={15} /> },
  { label: 'GitHub', sub: 'star the repo, report a bug', url: 'https://github.com/RandoTechNerd/VidHelm', icon: <IcGithub /> },
  { label: 'YouTube', sub: '@randotechnerd', url: 'https://www.youtube.com/@randotechnerd', icon: <IcYoutube /> },
  { label: 'Instagram', sub: '@randotechnerd', url: 'https://www.instagram.com/randotechnerd/', icon: <IcInstagram /> },
  { label: 'Buy me a coffee', sub: 'keeps the updates coming', url: 'https://buymeacoffee.com/randotechnerd', icon: <IcCoffee />,
    note: 'Please put "VidHelm" in the comment, there are a few projects on that page, plus any feature you want next. Requests that arrive with a coffee tend to jump the queue.' },
  { label: 'Discord', sub: 'help, ideas and show-and-tell', url: 'https://discord.gg/8fjQHDX8PQ', icon: <IcDiscord /> },
  { label: 'Email', sub: 'randotechnerd@gmail.com', url: 'mailto:randotechnerd@gmail.com', icon: <IcMail /> },
]

/** The one Help menu in the header: the chat, getting started, the community links and the
 *  credits. Mounted only while open, so it always opens on its first page. */
export function HelpMenu({ onClose, version, onChat, onStart, onCredits }: {
  onClose: () => void
  version: string
  onChat: () => void; onStart: () => void; onCredits: () => void
}) {
  const [view, setView] = useState<'menu' | 'links'>('menu')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const go = (fn: () => void) => () => { onClose(); fn() }
  const item = (icon: ReactNode, label: string, sub: string, onClick: () => void, more = false) => (
    <button role="menuitem" onClick={onClick}>
      <span className="links-ico">{icon}</span>
      <span className="links-txt"><b>{label}</b><i>{sub}</i></span>
      {more && <span className="links-more"><IcChevron /></span>}
    </button>
  )

  return (
    <div className="pop-menu help-menu" role="menu" aria-label="Help" onClick={e => e.stopPropagation()}>
      {view === 'menu' ? <>
        {item(<IcChat />, 'Ask the help chat', 'questions in plain words, and the FAQ', go(onChat))}
        {item(<IcPlay size={14} />, 'Getting started and tour', 'a first video in five moves', go(onStart))}
        {item(<IcGlobe size={15} />, 'Community and links', 'Discord, GitHub, YouTube, email', () => setView('links'), true)}
        {item(<IcInfo size={15} />, 'Credits and licences', 'who built it, and what it runs on', go(onCredits))}
      </> : <>
        <button className="pop-back" onClick={() => setView('menu')}><span className="links-back"><IcChevron /></span>Community and links</button>
        {LINKS.map(l => (
          <button key={l.url} role="menuitem" onClick={() => { window.ipcRenderer.openExternal(l.url); onClose() }}>
            <span className="links-ico">{l.icon}</span>
            <span className="links-txt">
              <b>{l.label}</b><i>{l.sub}</i>
              {l.note && <em className="links-note">{l.note}</em>}
            </span>
          </button>
        ))}
      </>}
      <div className="links-foot">VidHelm {version} · built by RandoTechNerd</div>
    </div>
  )
}

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

export function HelpModal({ open, onClose, onOpenPanel, onTour, onChat, version, startTab = 'start' }: {
  open: boolean; onClose: () => void
  onOpenPanel: (panel: HelpPanel) => void
  onTour: () => void; onChat: () => void
  version: string
  /** the page it opens on; give the modal a key that changes with it to reopen there */
  startTab?: HelpTab
}) {
  const [tab, setTab] = useState<HelpTab>(startTab)
  if (!open) return null
  const go = (fn: () => void) => () => { onClose(); fn() }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal help-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Welcome aboard</h2>
          <button className="modal-close" aria-label="Close" onClick={onClose}><IcClose /></button>
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
                  <button onClick={() => window.ipcRenderer.openExternal('https://github.com/RandoTechNerd/VidHelm/blob/main/LICENSE')}>VidHelm licence <IcExternal /></button>
                  <button onClick={() => window.ipcRenderer.openExternal('https://github.com/RandoTechNerd/VidHelm/blob/main/THIRD-PARTY-NOTICES.md')}>Third-party notices <IcExternal /></button>
                  <button onClick={() => window.ipcRenderer.openExternal('https://github.com/RandoTechNerd/VidHelm')}>GitHub <IcExternal /></button>
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
export function InfoNote({ children, label = 'What can I put here?' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="info-note">
      <button className={`info-toggle ${open ? 'on' : ''}`} onClick={() => setOpen(o => !o)} title={open ? 'Hide' : label}>
        <IcInfo /> {open ? 'Hide' : label}
      </button>
      {open && <div className="info-body">{children}</div>}
    </div>
  )
}
