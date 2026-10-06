// The Inspector's controls: typed numbers that stick, volume in dB, collapsible groups, the selection
// header, the position grid and the Sound section. Props-driven; App.tsx owns the state.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Preset, Role } from '../electron/audiochain'

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * A number field that keeps what is being typed. The old fields re-rendered the stored value on
 * every keystroke, so "1." became "1", "12" could not be typed into a field showing "0.00", and a
 * half-typed value moved the clip. This one holds a draft: Enter or leaving the field commits it
 * (clamped), Escape puts the old value back, the arrow keys step it.
 */
export function NumField({ value, onCommit, min = -Infinity, max = Infinity, step = 0.1, digits = 2, id, title, suffix }: {
  value: number; onCommit: (v: number) => void; min?: number; max?: number; step?: number; digits?: number; id?: string; title?: string; suffix?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  // the draft as typed (Escape then blur must see it gone at once), and where it goes: the commit
  // and bounds of the render it was typed in. Clicking another clip re-renders the Inspector before
  // the field loses focus, and a draft must land on the item it was typed for, never the new one.
  const live = useRef<string | null>(null)
  const target = useRef({ onCommit, min, max })
  const show = (v: number) => (Number.isFinite(v) ? String(+v.toFixed(digits)) : '')
  const commit = () => {
    const d = live.current
    live.current = null
    setDraft(null)
    if (d == null) return
    const v = parseFloat(d.replace(',', '.').replace('−', '-'))
    const t = target.current
    if (Number.isFinite(v)) t.onCommit(clamp(v, t.min, t.max))
  }
  // removed while a draft is pending (the selection changed under it): it still lands where it was typed
  useEffect(() => () => { if (live.current != null) commit() }, [])
  const set = (s: string | null) => { live.current = s; setDraft(s) }
  return (
    <span className="num-field">
      <input id={id} type="text" inputMode="decimal" className="duration-input" title={title} value={draft ?? show(value)}
        onFocus={e => e.target.select()}
        onChange={e => { if (live.current == null) target.current = { onCommit, min, max }; set(e.target.value) }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { commit(); e.currentTarget.blur() }
          else if (e.key === 'Escape') { set(null); e.currentTarget.blur() }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const base = parseFloat(live.current ?? String(value))
            const next = clamp((Number.isFinite(base) ? base : 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), min, max)
            live.current = null; setDraft(null)
            onCommit(+next.toFixed(digits))
          }
        }} />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </span>
  )
}

const DB_MIN = -60
const DB_MAX = 6

/**
 * Volume in dB on a -60..+6 slider (the left end is silence). It snaps to 0 dB within half a dB, and
 * a double-click puts it back to 0 dB. The value in and out is linear (1 = 0 dB), so the project
 * format and the export's volume math are untouched.
 */
export function DbSlider({ value, onChange, maxLinear = 2, id, title }: { value: number; onChange: (v: number) => void; maxLinear?: number; id?: string; title?: string }) {
  const dbv = value <= 0.001 ? DB_MIN : clamp(20 * Math.log10(value), DB_MIN, DB_MAX)
  return (
    <input id={id} type="range" className="db-slider" min={DB_MIN} max={DB_MAX} step={0.5} value={dbv} title={title || 'Double-click for 0 dB'}
      onChange={e => {
        let d = parseFloat(e.target.value)
        if (Math.abs(d) <= 0.5) d = 0
        onChange(d <= DB_MIN ? 0 : Math.min(maxLinear, 10 ** (d / 20)))
      }}
      onDoubleClick={() => onChange(1)}
      style={{ width: '100%', accentColor: 'var(--accent-primary)' }} />
  )
}

/** A collapsible group of property rows; the open state is the caller's so it survives a selection change. */
export function PropGroup({ title, open, onToggle, children, aside }: { title: string; open: boolean; onToggle: () => void; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={`prop-group ${open ? 'open' : ''}`}>
      <button className="prop-group-head" onClick={onToggle} aria-expanded={open}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d={open ? 'M1.5 3.5 5 7l3.5-3.5' : 'M3.5 1.5 7 5 3.5 8.5'} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span>{title}</span>
        {aside && <span className="prop-group-aside">{aside}</span>}
      </button>
      {open && <div className="prop-group-body">{children}</div>}
    </section>
  )
}

/** One labelled row: label, control, and an optional value or button at the end. */
export function PropRow({ label, htmlFor, children, end }: { label: string; htmlFor?: string; children: ReactNode; end?: ReactNode }) {
  return (
    <div className="prop-row">
      <label className="prop-label" htmlFor={htmlFor}>{label}</label>
      <div className="prop-ctl">{children}</div>
      {end !== undefined ? <div className="prop-end">{end}</div> : <span />}
    </div>
  )
}

/** Where a text sits: nine places in a 3x3 grid (centre-anchored, inside the title-safe area). */
const ANCHORS_X = [0.24, 0.5, 0.76]
const ANCHORS_Y = [0.14, 0.5, 0.86]
export function AnchorGrid({ x, y, onPick }: { x: number; y: number; onPick: (x: number, y: number) => void }) {
  const names = [['top left', 'top', 'top right'], ['left', 'centre', 'right'], ['bottom left', 'bottom', 'bottom right']]
  return (
    <div className="anchor-grid" role="group" aria-label="Place the text">
      {ANCHORS_Y.map((ay, r) => ANCHORS_X.map((ax, c) => (
        <button key={`${r}${c}`} className={Math.abs(x - ax) < 0.01 && Math.abs(y - ay) < 0.01 ? 'on' : ''} title={`Move to the ${names[r][c]}`} aria-label={names[r][c]} onClick={() => onPick(ax, ay)}><i /></button>
      )))}
    </div>
  )
}

const ROLES: { id: Role; label: string }[] = [{ id: 'voice', label: 'Voice' }, { id: 'music', label: 'Music' }, { id: 'sfx', label: 'SFX' }, { id: 'asis', label: 'As is' }]
const FIXES: { id: Preset; label: string; title: string }[] = [
  { id: 'off', label: 'Off', title: 'Played as recorded' },
  { id: 'light', label: 'Light', title: 'The right level only: no noise reduction, no levelling' },
  { id: 'studio', label: 'Studio', title: 'Clean, level and lift: room noise reduced, quiet and loud sections evened out, knocks tamed' },
]

export interface SoundView {
  role: Role
  guessed: boolean
  why: string
  /** the role's level in dB (bed, SFX match, or the predicted lift while a voice bakes) */
  levelDb: number
  fix: Preset
  /** what the line under Fix voice says */
  status: { text: string; pct?: number; tone?: 'busy' | 'warn' }
  /** other clips cut from the same file (the role and fix are the file's) */
  siblings: number
  duckDb: number; sfxDuckDb: number; bedLu: number; duck: boolean
}

/**
 * The Sound section: what this clip is (Voice, Music, SFX, As is; guessed until someone picks) and,
 * for a voice, how hard Fix voice works on it, with the one line the bake left behind.
 */
export function SoundControls({ v, onRole, onFix }: { v: SoundView; onRole: (r: Role | undefined) => void; onFix: (p: Preset) => void }) {
  const db1 = (x: number) => `${x >= 0.05 ? '+' : x <= -0.05 ? '−' : ''}${Math.abs(x).toFixed(1)} dB`
  const roleLine = v.role === 'music' ? `Set ${v.bedLu} LU under the voice (${db1(v.levelDb)})${v.duck && v.duckDb > 0 ? `, dips ${v.duckDb} dB while someone speaks` : ''}.`
    : v.role === 'sfx' ? `Its loudest moment set to the voice level (${db1(v.levelDb)})${v.duck && v.sfxDuckDb > 0 ? `, dips ${v.sfxDuckDb} dB under speech` : ''}.`
    : v.role === 'asis' ? 'Played exactly as recorded, never ducked.'
    : ''
  return (
    <div className="sound-controls">
      <div className="prop-row">
        <span className="prop-label">Sound</span>
        <div className="prop-ctl chips" role="radiogroup" aria-label="What this sound is">
          {ROLES.map(r => (
            <button key={r.id} role="radio" aria-checked={v.role === r.id} className={`chip ${v.role === r.id ? 'on' : ''}`} onClick={() => onRole(r.id)}>{r.label}</button>
          ))}
        </div>
        <span />
      </div>
      <p className="hint">
        {v.guessed ? <>Guessed: {v.why}. </> : <>Set by you. <button className="link-btn" onClick={() => onRole(undefined)}>Guess again</button> </>}
        {v.siblings > 0 && <>Applies to all {v.siblings + 1} clips from this file.</>}
      </p>
      {v.role === 'voice' ? (
        <>
          <div className="prop-row">
            <span className="prop-label">Fix voice</span>
            <div className="prop-ctl seg" role="radiogroup" aria-label="Fix voice">
              {FIXES.map(f => <button key={f.id} role="radio" aria-checked={v.fix === f.id} title={f.title} className={v.fix === f.id ? 'on' : ''} onClick={() => onFix(f.id)}>{f.label}</button>)}
            </div>
            <span />
          </div>
          <div className={`fix-line ${v.status.tone || ''}`}>
            <span>{v.status.text}</span>
            {v.status.pct != null && <span className="fix-bar"><span style={{ width: `${clamp(v.status.pct, 0, 100)}%` }} /></span>}
          </div>
        </>
      ) : <p className="fix-line">{roleLine}</p>}
    </div>
  )
}
