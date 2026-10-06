/* A clip's waveform on the timeline: full height on the sound rows, a strip along the bottom of a
 * video clip that has sound. Bars are scaled by the same gain the export applies (volume,
 * automation, fades), so turning a clip down or fading it shows. Drawn on a canvas, and only when
 * something it shows changes: zoom, trim, gain or theme, not on every editor render. The numbers
 * come from electron/peaks.ts. */
import { memo, useEffect, useRef } from 'react'
import { barPeaks, barHeight } from '../electron/peaks'

// Chromium refuses canvases much wider than this; a clip wider than it (a long take at high zoom)
// draws just the stretch around what is on screen and follows the scroll.
const MAX_CANVAS_PX = 16384
// one bar every 3 CSS px, 2 px wide: reads as a waveform at any zoom without smearing
const PITCH = 3, BAR = 2

export interface Peaks { rate: number; data: Uint8Array }

interface Props {
  peaks: Peaks
  sourceStart: number
  duration: number
  pxPerSec: number
  /** linear gain at t seconds from the clip's start, exactly as the export applies it */
  gain: (t: number) => number
  /** changes whenever anything gain() reads changes; with the props above, the only redraw triggers */
  gainKey: string
  variant: 'full' | 'under'
  /** the UI theme, so bars repaint in the new colour */
  tint: string
}

function ClipWaveInner(p: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const live = useRef(p)
  live.current = p
  // what is drawn now (CSS px from the clip's left edge), null = needs a redraw
  const drawn = useRef<[number, number] | null>(null)
  const visible = useRef(false)
  const raf = useRef(0)

  const draw = () => {
    raf.current = 0
    const cv = ref.current
    const clipEl = cv?.parentElement
    if (!cv || !clipEl || !visible.current) return
    const { peaks, sourceStart, duration, pxPerSec, gain } = live.current
    const dpr = window.devicePixelRatio || 1
    const W = Math.max(0, duration * pxPerSec)
    const H = cv.clientHeight
    if (W < 1 || H < 1) return
    let from = 0, to = W
    if (W * dpr > MAX_CANVAS_PX) {
      const scroller = cv.closest('.timeline')
      if (!scroller) return
      const sr = scroller.getBoundingClientRect(), cr = clipEl.getBoundingClientRect()
      const v0 = Math.max(0, Math.min(W, sr.left - cr.left)), v1 = Math.max(0, Math.min(W, sr.right - cr.left))
      const d = drawn.current
      if (d && v0 >= d[0] && v1 <= d[1]) return   // still covers what is on screen
      const span = Math.min(W, Math.floor(MAX_CANVAS_PX / dpr))
      from = Math.max(0, Math.min(W - span, (v0 + v1) / 2 - span / 2))
      to = from + span
    } else if (drawn.current) return
    cv.style.left = `${from}px`
    cv.style.width = `${to - from}px`
    cv.width = Math.round((to - from) * dpr)
    cv.height = Math.round(H * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, to - from, H)
    ctx.fillStyle = getComputedStyle(cv).color
    const bars = Math.max(1, Math.floor((to - from) / PITCH))
    const pk = barPeaks(peaks.data, peaks.rate, sourceStart + from / pxPerSec, sourceStart + (from + bars * PITCH) / pxPerSec, bars)
    const mid = H / 2, reach = Math.max(1, mid - 1)
    for (let b = 0; b < bars; b++) {
      if (!pk[b]) continue
      const h = barHeight(pk[b], gain((from + (b + 0.5) * PITCH) / pxPerSec)) * reach
      if (h >= 0.5) ctx.fillRect(b * PITCH, mid - h, BAR, h * 2)
    }
    drawn.current = [from, to]
  }
  const schedule = () => { if (!raf.current) raf.current = requestAnimationFrame(draw) }

  // anything it shows changed: draw again (once, on the next frame)
  useEffect(() => { drawn.current = null; schedule() }, [p.peaks, p.sourceStart, p.duration, p.pxPerSec, p.gainKey, p.variant, p.tint])   // eslint-disable-line react-hooks/exhaustive-deps

  // Draw only once on screen (a long pause-cut timeline has hundreds of clips), and follow the
  // scroll only when the clip is too wide for one canvas.
  useEffect(() => {
    const cv = ref.current
    const scroller = cv?.closest('.timeline') as HTMLElement | null
    if (!cv) return
    const io = new IntersectionObserver(entries => {
      visible.current = entries.some(e => e.isIntersecting)
      if (visible.current) schedule()
    }, { root: scroller, rootMargin: '0px 50% 0px 50%' })
    io.observe(cv.parentElement ?? cv)
    const onScroll = () => {
      const { duration, pxPerSec } = live.current
      if (visible.current && duration * pxPerSec * (window.devicePixelRatio || 1) > MAX_CANVAS_PX) schedule()
    }
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    return () => { io.disconnect(); scroller?.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf.current); raf.current = 0 }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={ref} className={`clip-wave ${p.variant}`} aria-hidden />
}

// gain() is a fresh closure every render; gainKey stands for it
export const ClipWave = memo(ClipWaveInner, (a, b) =>
  a.peaks === b.peaks && a.sourceStart === b.sourceStart && a.duration === b.duration && a.pxPerSec === b.pxPerSec
  && a.gainKey === b.gainKey && a.variant === b.variant && a.tint === b.tint)
