/* Shared form controls that carry a little behaviour of their own. The plain ones (buttons,
   sliders, switches) are CSS primitives in App.css; see the "Shared controls" section there. */
import { useState } from 'react'
import { IcEye, IcEyeOff, IcKey } from './icons'
import { savedKeyLabel } from './uikit'

/** An API key or token. It is typed into a masked field and, once saved, shown only as its last
 *  four characters. A plain text box put the whole key into every screen recording of the panel
 *  and into the screenshots a connected AI takes of the window.
 *  The new key is committed on Enter or when the field loses focus (clicking Generate does that
 *  first), and Replace never clears the old key until a new one is actually typed. */
export function SecretField({ name, value, onChange, placeholder }: {
  /** what the key is, as the saved line says it: "fal.ai key" */
  name: string
  value?: string | null
  onChange: (v: string) => void
  placeholder: string
}) {
  const [replacing, setReplacing] = useState(false)
  const [draft, setDraft] = useState('')
  const [show, setShow] = useState(false)
  const saved = !!value && !replacing

  const close = () => { setDraft(''); setShow(false); setReplacing(false) }
  const commit = () => { const v = draft.trim(); if (v) onChange(v); close() }

  if (saved) return (
    <div className="secret-saved">
      <IcKey />
      <span>{savedKeyLabel(name, value)}</span>
      <button type="button" className="btn sm ghost" onClick={() => setReplacing(true)}>Replace</button>
      <button type="button" className="btn sm ghost" onClick={() => onChange('')}>Remove</button>
    </div>
  )
  return (
    <div className="secret-field">
      <input className="duration-input" type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false}
        placeholder={placeholder} aria-label={name} value={draft} autoFocus={replacing}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          else if (e.key === 'Escape' && value) { e.preventDefault(); close() }
        }} />
      {/* mousedown is swallowed so the field keeps focus: peeking is not committing */}
      <button type="button" className="secret-eye" title={show ? 'Hide the key' : 'Show the key while you check it'}
        aria-label={show ? 'Hide the key' : 'Show the key'} onMouseDown={e => e.preventDefault()} onClick={() => setShow(s => !s)}>
        {show ? <IcEyeOff /> : <IcEye />}
      </button>
    </div>
  )
}
