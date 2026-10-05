/* Help chat: ask about VidHelm without leaving the edit. Online it asks VidHelm Cloud
   (help.vidhelm.com/api/help/chat, a small Claude model primed with electron/helpdesk.ts); offline, or if the
   service is busy, it answers from that same guide on this machine. Replies can carry
   [[open:x]] tags, which become buttons that open the panel being talked about.
   The FAQ tab and the "talk to a person" row work with no network at all, so anyone who
   downloads VidHelm always has a way to get unstuck. */
import { useEffect, useRef, useState } from 'react'
import { localAnswer, parseActions, ACTION_LABELS, FAQ, SUPPORT, type HelpAction, type HelpContext } from '../electron/helpdesk'
import { IcClose, IcSend, IcDiscord, IcMail } from './icons'

export const HELP_CHAT_URL = 'https://help.vidhelm.com/api/help/chat'

interface Msg { role: 'user' | 'assistant'; text: string; actions?: HelpAction[]; offline?: boolean }

const STARTERS = ['How do I make a vertical Short?', 'How do I remove the pauses?', 'How do I connect Claude?', 'How do I add captions?']
const HELLO = 'Hi! Ask me anything about VidHelm: where something is, how to do a task, or why something looks wrong.'

async function ask(history: Msg[], ctx: HelpContext): Promise<Msg> {
  const last = history[history.length - 1].text
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 25000)
    const r = await fetch(HELP_CHAT_URL, {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: ctx, messages: history.slice(-10).map(m => ({ role: m.role, content: m.text })) }),
    })
    clearTimeout(timer)
    if (r.ok) {
      const j = await r.json() as { reply?: string }
      if (j.reply) { const p = parseActions(j.reply); return { role: 'assistant', text: p.text, actions: p.actions } }
    }
    if (r.status === 429) return { role: 'assistant', text: 'That is a lot of questions in a row! Give it a minute, then ask again.' }
  } catch { /* offline, blocked or timed out: fall through to the built-in guide */ }
  const hit = localAnswer(last)
  return hit
    ? { role: 'assistant', text: hit.answer, actions: hit.action ? [hit.action] : [], offline: true }
    : { role: 'assistant', text: 'I could not reach the help service, and the built-in guide has nothing on that. Try different words, check the FAQ tab, or ask a person on Discord.', actions: ['tour'], offline: true }
}

export function HelpChat({ open, onClose, onAction, context }: {
  open: boolean; onClose: () => void; onAction: (a: HelpAction) => void; context: HelpContext
}) {
  const [tab, setTab] = useState<'ask' | 'faq'>('ask')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (open && tab === 'ask') setTimeout(() => inputRef.current?.focus(), 30) }, [open, tab])
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [msgs, busy])

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || busy) return
    setTab('ask')
    const history = [...msgs, { role: 'user' as const, text: q }]
    setMsgs(history); setDraft(''); setBusy(true)
    const reply = await ask(history, context)
    setMsgs(m => [...m, reply]); setBusy(false)
  }

  if (!open) return null
  return (
    <aside className="help-chat" aria-label="Help"
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') onClose() }}>
      <div className="hc-head">
        <div className="hc-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'ask'} className={tab === 'ask' ? 'on' : ''} onClick={() => setTab('ask')}>Ask</button>
          <button role="tab" aria-selected={tab === 'faq'} className={tab === 'faq' ? 'on' : ''} onClick={() => setTab('faq')}>FAQ</button>
        </div>
        {tab === 'ask' && msgs.length > 0 && <button className="hc-link" onClick={() => setMsgs([])} title="Start a new conversation">New chat</button>}
        <button className="hdr-btn icon" onClick={onClose} title="Close (Esc)" aria-label="Close"><IcClose /></button>
      </div>

      {tab === 'ask' ? (
        <>
          <div className="hc-list" ref={listRef}>
            <div className="hc-msg assistant"><div className="hc-bubble">{HELLO}</div></div>
            {msgs.length === 0 && (
              <div className="hc-starters">
                {STARTERS.map(q => <button key={q} onClick={() => send(q)}>{q}</button>)}
                <button onClick={() => setTab('faq')}>Browse the FAQ</button>
              </div>
            )}
            {msgs.map((m, n) => (
              <div key={n} className={`hc-msg ${m.role}`}>
                <div className="hc-bubble">{m.text}</div>
                {!!m.actions?.length && (
                  <div className="hc-actions">{m.actions.map(a => <button key={a} onClick={() => onAction(a)}>{ACTION_LABELS[a]}</button>)}</div>
                )}
                {m.offline && <div className="hc-note">From the built-in guide (help service not reachable)</div>}
              </div>
            ))}
            {busy && <div className="hc-msg assistant"><div className="hc-bubble hc-typing"><i /><i /><i /></div></div>}
          </div>

          <form className="hc-input" onSubmit={e => { e.preventDefault(); send(draft) }}>
            <textarea ref={inputRef} rows={1} value={draft} placeholder="Ask a question…" maxLength={1500}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft) } }} />
            <button type="submit" disabled={busy || !draft.trim()} aria-label="Send"><IcSend /></button>
          </form>
        </>
      ) : (
        <div className="hc-list hc-faq">
          {FAQ.map(sec => (
            <section key={sec.title}>
              <h4>{sec.title}</h4>
              {sec.items.map(it => (
                <details key={it.q}>
                  <summary>{it.q}</summary>
                  <p>{it.a}</p>
                  {it.action && <div className="hc-actions"><button onClick={() => onAction(it.action!)}>{ACTION_LABELS[it.action]}</button></div>}
                </details>
              ))}
            </section>
          ))}
          <section>
            <h4>Still stuck?</h4>
            <p className="hc-faq-note">Real people answer on Discord, usually fastest. Email works too. Say which VidHelm version you have (at the bottom of the Help menu, the ? at the top right) and what you clicked.</p>
          </section>
        </div>
      )}

      <div className="hc-contact">
        <span>Talk to a person</span>
        <button onClick={() => window.ipcRenderer.openExternal(SUPPORT.discord)} title="Join the VidHelm Discord and ask in the help channel"><IcDiscord /> Discord</button>
        <button onClick={() => window.ipcRenderer.openExternal(`mailto:${SUPPORT.email}?subject=${encodeURIComponent('VidHelm help')}`)} title={SUPPORT.email}><IcMail /> Email</button>
      </div>
    </aside>
  )
}
