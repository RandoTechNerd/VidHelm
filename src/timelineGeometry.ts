export type TimedFade = {
  start: number
  duration: number
  fadeIn: number
  fadeOut: number
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** Shared by the stage preview and export-equivalent UI timing. */
export function fadeFactor(item: TimedFade, time: number) {
  const into = time - item.start
  const toEnd = item.start + item.duration - time
  let opacity = 1
  if (item.fadeIn > 0) opacity = Math.min(opacity, into / item.fadeIn)
  if (item.fadeOut > 0) opacity = Math.min(opacity, toEnd / item.fadeOut)
  return clamp(opacity, 0, 1)
}

/** Pixel geometry for all timeline blocks, including their visible fade regions. */
export function timelineBlockLayout(item: TimedFade, pixelsPerSecond: number) {
  const scale = Math.max(0, pixelsPerSecond)
  const duration = Math.max(0, item.duration)
  return {
    left: item.start * scale,
    width: duration * scale,
    fadeInWidth: Math.min(duration, Math.max(0, item.fadeIn)) * scale,
    fadeOutWidth: Math.min(duration, Math.max(0, item.fadeOut)) * scale,
  }
}

/** Convert a pointer delta to a non-negative timeline start, with pixel-based snapping. */
export function timelineDragStart(
  originalStart: number,
  deltaPixels: number,
  pixelsPerSecond: number,
  snapTimes: number[],
  snapThresholdPixels = 6,
) {
  const scale = Math.max(0.001, pixelsPerSecond)
  let next = Math.max(0, originalStart + deltaPixels / scale)
  const threshold = Math.max(0, snapThresholdPixels) / scale
  for (const snap of snapTimes) {
    if (Number.isFinite(snap) && Math.abs(next - snap) < threshold) { next = Math.max(0, snap); break }
  }
  return next
}

/** Resize a timeline item while preserving its opposite edge and a usable duration. */
export function timelineResize(
  item: Pick<TimedFade, 'start' | 'duration'>,
  deltaPixels: number,
  pixelsPerSecond: number,
  side: 'left' | 'right',
  minimumDuration = 0.3,
) {
  const scale = Math.max(0.001, pixelsPerSecond)
  const delta = deltaPixels / scale
  const minimum = Math.max(0, minimumDuration)
  if (side === 'right') return { start: item.start, duration: Math.max(minimum, item.duration + delta) }

  const end = item.start + item.duration
  const start = clamp(item.start + delta, 0, Math.max(0, end - minimum))
  return { start, duration: end - start }
}

/** Scale preview text from a corner handle without allowing unusable font sizes. */
export function textResizeFontSize(
  originalFontSize: number,
  originalHandleDistance: number,
  handleDistance: number,
  minimum = 8,
  maximum = 400,
) {
  const boundedOriginal = clamp(originalFontSize, minimum, maximum)
  if (!Number.isFinite(originalHandleDistance) || originalHandleDistance <= 0) return boundedOriginal
  const scale = Math.max(0, handleDistance) / originalHandleDistance
  return clamp(Math.round(originalFontSize * scale), minimum, maximum)
}
