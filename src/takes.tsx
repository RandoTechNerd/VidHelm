// Takes & history: the transcript of the timeline, with the repeated takes grouped so you can
// keep the one you like, and a record of what got cut once you have applied it.
//
// Detection lives in electron/takes.ts (pure, tested). This file is the panel only; App.tsx owns
// the state and does the timeline surgery.
import type { Chunk, TakeGroup } from '../electron/takes'

export interface TakeAnalysis {
  chunks: Chunk[]
  groups: TakeGroup[]
  /** indices the user struck out by hand (a flub with no retake) */
  drops: number[]
  /** true once these choices have been applied to the timeline */
  applied: boolean
  /** wall-clock label for the scan, so the history says how old it is */
  scannedAt: string
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`

export const takeStats = (a: TakeAnalysis | null) => {
  if (!a) return { groups: 0, cuts: 0 }
  const cuts = a.groups.reduce((n, g) => n + g.members.length - 1, 0) + a.drops.length
  return { groups: a.groups.length, cuts }
}

export function TakesModal({ open, onClose, analysis, busy, canReapply, onScan, onApply, onSetKeep, onToggleDrop, onSeek }: {
  open: boolean
  onClose: () => void
  analysis: TakeAnalysis | null
  busy: string | null
  /** the timeline is still exactly as this analysis left it, so choices can be re-applied safely */
  canReapply: boolean
  onScan: () => void
  onApply: () => void
  onSetKeep: (groupIndex: number, member: number) => void
  onToggleDrop: (index: number) => void
  onSeek: (t: number) => void
}) {
  if (!open) return null

  const groupOf = new Map<number, { g: TakeGroup; gi: number }>()
  analysis?.groups.forEach((g, gi) => g.members.forEach(m => groupOf.set(m, { g, gi })))
  const dropped = new Set(analysis?.drops || [])
  const isCut = (i: number) => {
    const hit = groupOf.get(i)
    return dropped.has(i) || (!!hit && hit.g.keep !== i)
  }
  const { groups, cuts } = takeStats(analysis)

  // walk the transcript once, emitting a block per take group and a row for everything else
  const rows: React.ReactNode[] = []
  if (analysis) {
    let i = 0
    while (i < analysis.chunks.length) {
      const hit = groupOf.get(i)
      if (hit && hit.g.members[0] === i) {
        rows.push(
          <div className="tk-group" key={`g${hit.gi}`}>
            <div className="tk-group-head">Said {hit.g.members.length} times, keeping one</div>
            {hit.g.members.map((m, n) => (
              <div className={`tk-row ${hit.g.keep === m ? 'keep' : 'cut'}`} key={m}>
                <button className="tk-time" title="Jump the playhead here" onClick={() => onSeek(analysis.chunks[m].start)}>{fmt(analysis.chunks[m].start)}</button>
                <span className="tk-text">{analysis.chunks[m].text}</span>
                <button className={`tk-pick ${hit.g.keep === m ? 'on' : ''}`} onClick={() => onSetKeep(hit.gi, m)}
                  title={hit.g.keep === m ? 'This is the take being kept' : 'Keep this take instead'}>
                  {hit.g.keep === m ? '✓ keeping' : `use take ${n + 1}`}
                </button>
              </div>
            ))}
          </div>
        )
        i += hit.g.members.length
        continue
      }
      const c = analysis.chunks[i]
      const cut = isCut(i)
      const idx = i
      rows.push(
        <div className={`tk-row ${cut ? 'cut' : ''}`} key={idx}>
          <button className="tk-time" title="Jump the playhead here" onClick={() => onSeek(c.start)}>{fmt(c.start)}</button>
          <span className="tk-text">{c.text}</span>
          <button className="tk-drop" onClick={() => onToggleDrop(idx)} title={cut ? 'Put this line back' : 'Cut this line too'}>
            {cut ? '↺ keep' : '✕ cut'}
          </button>
        </div>
      )
      i++
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal tk-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>📋 Takes &amp; history</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {!analysis && (
            <section>
              <p className="hint" style={{ marginTop: 0 }}>
                Said a line three times and kept talking? This reads the timeline's speech on your machine
                (Whisper, nothing uploaded), groups the attempts at the same line, and keeps the best one.
                You get the full transcript either way, so it doubles as a record of what was cut.
              </p>
              <div className="conn-actions">
                <button className="primary" disabled={!!busy} onClick={onScan}>{busy || 'Scan the timeline'}</button>
              </div>
              <p className="hint">First run downloads the Whisper model once. A few minutes of footage takes a moment.</p>
            </section>
          )}

          {analysis && (
            <>
              <section>
                <div className="tk-summary">
                  <span>{analysis.chunks.length} lines</span>
                  <span>{groups} repeated {groups === 1 ? 'spot' : 'spots'}</span>
                  <span>{cuts} {cuts === 1 ? 'line' : 'lines'} to cut</span>
                  <span className="tk-when">scanned {analysis.scannedAt}</span>
                </div>
                {groups === 0 && !analysis.applied && (
                  <p className="hint" style={{ marginTop: 0 }}>No repeated takes found. You can still strike out any line by hand below.</p>
                )}
                {analysis.applied && (
                  <p className="hint" style={{ marginTop: 0 }}>
                    Applied. Greyed lines are the ones cut out of the timeline.
                    {canReapply
                      ? ' Change a choice below and it re-cuts from the same starting point.'
                      : ' The timeline has moved on since, so changing a choice needs a fresh scan (Ctrl+Z still undoes the cut).'}
                  </p>
                )}
              </section>

              <section>
                <div className="tk-list">{rows}</div>
              </section>
            </>
          )}
        </div>
        {analysis && (
          <div className="modal-foot tk-foot">
            <span>{analysis.applied ? (canReapply ? 'Choices can still be changed' : 'Re-scan to change takes') : 'Nothing has been cut yet'}</span>
            <div className="conn-actions" style={{ margin: 0 }}>
              <button onClick={onScan} disabled={!!busy}>{busy || '↻ Re-scan'}</button>
              <button className="primary" disabled={!!busy || cuts === 0 || (analysis.applied && !canReapply)}
                onClick={onApply}>
                {analysis.applied ? 'Apply these choices' : `Cut ${cuts} ${cuts === 1 ? 'line' : 'lines'}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
