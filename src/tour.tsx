/* First-run tour: dims the window and spotlights the real controls one at a time, so the
   tour teaches where things ARE rather than describing them in a dialog. Opens by itself the
   first time VidHelm starts (localStorage TOUR_KEY), and from Help any time after. */
import { useEffect, useLayoutEffect, useState, useCallback } from 'react'

export const TOUR_KEY = 'vh_tour_v1'
export const tourSeen = () => { try { return !!localStorage.getItem(TOUR_KEY) } catch { return true } }
const markSeen = () => { try { localStorage.setItem(TOUR_KEY, new Date().toISOString()) } catch { /* private storage */ } }

interface Step { target?: string; title: string; body: string; pad?: number }

const STEPS: Step[] = [
  { title: 'Welcome to VidHelm', body: 'A quick look around: eight stops, about thirty seconds. Use the arrow keys or the buttons, and press Esc to skip. You can replay this from Help at any time.' },
  { target: '.sidebar.left', title: 'Your media', body: 'Drag footage, music, images or 3D models here (or straight onto the timeline). Sound FX, the tab next door, has effects you can audition and drop in.' },
  { target: '.orientation-switch', title: 'Pick the shape first', body: 'Landscape for YouTube, Portrait for Shorts, Reels and TikTok, Square for feeds. The preview and the export both follow it.', pad: 4 },
  { target: '.timeline-area', title: 'The timeline', body: 'Text, B-roll, video, voice and music, and sound effects each have a row. Drag to move, drag edges to trim. Press M while it plays to drop a tag point on a beat that matters.' },
  { target: '.timeline-actions .tool-group', title: 'Editing tools', body: 'Split, Text, Voiceover and Captions, then the time-savers: Booth to read a script in one take, Cut Pauses to strip dead air, Takes to keep your best line. Ctrl+Z undoes anything.', pad: 4 },
  { target: '.sidebar.right', title: 'Export, Tags, Inspector', body: 'Export settings live here. Tags lists your tag points. Inspector shows the controls for whatever clip or text you select.' },
  { target: '.hdr-connect', title: 'Bring an AI co-pilot', body: 'Connect an assistant such as Claude and it edits this timeline with you: effects on every tag, titles, your whole routine from one sentence. The panel writes the setup command for your machine.', pad: 4 },
  { target: '.hdr-chat', title: 'Stuck? Help is one click away', body: 'Ask a question in plain words, browse the FAQ (how to edit, how to connect your AI), or reach a real person on Discord or by email. Press Done and it opens for you.', pad: 4 },
]

interface Rect { top: number; left: number; width: number; height: number }

export function Tour({ open, onClose, onFinish }: { open: boolean; onClose: () => void; onFinish?: () => void }) {
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [vw, setVw] = useState(() => window.innerWidth)
  const [vh, setVh] = useState(() => window.innerHeight)
  const step = STEPS[i]

  const finish = useCallback(() => { markSeen(); setI(0); onClose() }, [onClose])
  // Done on the last stop opens Help, so the tour ends where people go when they get stuck
  const next = useCallback(() => { if (i < STEPS.length - 1) setI(i + 1); else { finish(); onFinish?.() } }, [i, finish, onFinish])
  const back = useCallback(() => setI(n => Math.max(0, n - 1)), [])

  // measure the spotlighted control (it may be hidden in expanded view: the card then centres)
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      setVw(window.innerWidth); setVh(window.innerHeight)
      const el = step.target ? document.querySelector(step.target) as HTMLElement | null : null
      const r = el?.getBoundingClientRect()
      if (!r || r.width === 0) { setRect(null); return }
      const pad = step.pad ?? 6
      setRect({ top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, step])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); finish() }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back() }
    }
    window.addEventListener('keydown', onKey, true)   // capture: the editor's own shortcuts stay quiet
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, next, back, finish])

  if (!open) return null

  // card beside the spotlight: below if it fits, else above, else to the side with more room
  const CW = 340, CH = 190, GAP = 12, M = 12
  let cardStyle: React.CSSProperties
  if (!rect) cardStyle = { left: (vw - CW) / 2, top: Math.max(M, (vh - CH) / 2) }
  else {
    const below = rect.top + rect.height + GAP, above = rect.top - GAP - CH
    let top: number, left: number
    if (below + CH <= vh - M) { top = below; left = rect.left + rect.width / 2 - CW / 2 }
    else if (above >= M) { top = above; left = rect.left + rect.width / 2 - CW / 2 }
    else {
      top = rect.top + rect.height / 2 - CH / 2
      left = rect.left > vw - (rect.left + rect.width) ? rect.left - GAP - CW : rect.left + rect.width + GAP
    }
    cardStyle = { left: Math.min(Math.max(M, left), vw - CW - M), top: Math.min(Math.max(M, top), vh - CH - M) }
  }

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="VidHelm tour">
      <div className="tour-catch" onClick={e => e.stopPropagation()} />
      {rect
        ? <div className="tour-spot" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />
        : <div className="tour-dim" />}
      <div className="tour-card" style={{ ...cardStyle, width: CW }}>
        <div className="tour-step">{i + 1} of {STEPS.length}</div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-foot">
          <div className="tour-dots">{STEPS.map((_, n) => <button key={n} className={n === i ? 'on' : ''} onClick={() => setI(n)} aria-label={`Step ${n + 1}`} />)}</div>
          {i < STEPS.length - 1 && <button className="tour-skip" onClick={finish}>Skip</button>}
          {i > 0 && <button className="tour-btn" onClick={back}>Back</button>}
          <button className="tour-btn primary" onClick={next}>{i === 0 ? 'Show me' : i < STEPS.length - 1 ? 'Next' : 'Done'}</button>
        </div>
      </div>
    </div>
  )
}
