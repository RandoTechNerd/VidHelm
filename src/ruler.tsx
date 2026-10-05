/* The timeline ruler. A component of its own so that scrolling the timeline redraws only the ruler:
 * ticks are drawn for the stretch in view plus a screen either side, so a long project at full zoom
 * is a few hundred nodes instead of tens of thousands, and the editor itself does not re-render on
 * every scroll step. The numbers come from electron/timeline.ts. */
import { memo, useEffect, useMemo, useState, type DOMAttributes, type RefObject } from 'react'
import { rulerTicks, rulerLabel, tickStepFor, timecode, type TimecodeMode } from '../electron/timeline'

interface RulerProps {
  pxPerSec: number
  /** the whole scrollable width, px */
  widthPx: number
  /** the scroller's visible size, px: ticks are drawn a screen either side of it, the hover line reaches its bottom */
  viewW: number
  viewH: number
  fps: number
  mode: TimecodeMode
  scroller: RefObject<HTMLDivElement | null>
  /** scrubbing; passed stable (see Editor) or the memo is pointless */
  handlers: Pick<DOMAttributes<HTMLDivElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>
}

export const TimeRuler = memo(function TimeRuler({ pxPerSec, widthPx, viewW, viewH, fps, mode, scroller, handlers }: RulerProps) {
  // which screen-width chunk the view starts in: the tick window only moves when this does
  const span = Math.max(200, viewW)
  const [chunk, setChunk] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let raf = 0
    const read = () => { raf = 0; setChunk(Math.floor(el.scrollLeft / span)) }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(read) }
    read()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf) }
  }, [scroller, span])

  const from = Math.max(0, (chunk - 1) * span) / pxPerSec
  const to = Math.min(widthPx, (chunk + 2) * span) / pxPerSec
  const step = tickStepFor(pxPerSec)
  const ticks = useMemo(() => rulerTicks(from, to, pxPerSec), [from, to, pxPerSec])

  return (
    <div className="time-ruler" title="Drag to scrub" {...handlers}
      onMouseMove={e => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(widthPx, e.clientX - r.left))) }}
      onMouseLeave={() => setHover(null)}>
      {ticks.map(t => (
        <div key={t.t} className={`tick${t.label ? '' : ' minor'}${t.major ? ' major' : ''}`} style={{ left: t.t * pxPerSec }}>
          {/* no label at 0: the playhead head sits there */}
          {t.label && t.t > 0 && <span>{rulerLabel(t.t, step, fps)}</span>}
        </div>
      ))}
      {hover !== null && (
        <div className="ruler-ghost" style={{ transform: `translateX(${hover}px)`, height: viewH }}>
          <span className="ruler-tip">{timecode(hover / pxPerSec, mode, fps)}</span>
        </div>
      )}
    </div>
  )
})
