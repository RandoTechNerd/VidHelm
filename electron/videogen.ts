/* Video generation harness. One call, `generateClip()`, tries the best available model for the job:
 *  - a transition between two pictures (first + last frame): Veo 3.1 (Gemini, with sound) → Kling 2.1 pro → Luma Ray-2 → Kling 2.5 → Hailuo-02
 *  - bring one picture to life: Veo 3.1 (Gemini) → Veo 3.1 fast (fal, with sound) → Kling 2.5 → Kling 2.1 → Luma
 *  - a shot from text alone: Veo 3.1 (Gemini) → Veo 3.1 fast (fal) → Kling 2.5
 * Providers are keyed by secrets (GEMINI_API_KEY, FAL_KEY); nothing is called without one. Models change
 * monthly: add a row to VIDEO_MODELS and, if it needs a new input shape, a case in falInput(). */
/** Keys only; the desktop passes them straight from Settings. Kept in sync with cloud/src/videogen.ts. */
export interface Env { FAL_KEY?: string; GEMINI_API_KEY?: string }

export type Aspect = 'landscape' | 'portrait' | 'square'
export interface ClipRequest { prompt: string; image?: ArrayBuffer; lastImage?: ArrayBuffer; aspect: Aspect; seconds?: number; model?: string; audio?: boolean }
export interface ClipResult { bytes: ArrayBuffer; seconds: number; hasAudio: boolean; model: string }

export interface VideoModel {
  label: string; provider: 'gemini' | 'fal'; endpoint?: string; textEndpoint?: string
  endFrame: boolean; audio: boolean; seconds: number[]; aspects: Aspect[] | 'any'; text: boolean; usdPerSecond: number; note: string
}
export const VIDEO_MODELS: Record<string, VideoModel> = {
  'veo-3.1':     { label: 'Veo 3.1 fast (Google)', provider: 'gemini', endFrame: true, audio: true, seconds: [8], aspects: ['landscape', 'portrait'], text: true, usdPerSecond: 0.15, note: 'sound, first+last frame, best prompt following' },
  'veo-3.1-fal': { label: 'Veo 3.1 fast (fal)', provider: 'fal', endpoint: 'fal-ai/veo3.1/fast/image-to-video', textEndpoint: 'fal-ai/veo3.1/fast', endFrame: false, audio: true, seconds: [4, 6, 8], aspects: ['landscape', 'portrait'], text: true, usdPerSecond: 0.15, note: 'sound, no end frame' },
  'kling-2.1':   { label: 'Kling 2.1 pro', provider: 'fal', endpoint: 'fal-ai/kling-video/v2.1/pro/image-to-video', endFrame: true, audio: false, seconds: [5, 10], aspects: 'any', text: false, usdPerSecond: 0.09, note: 'first+last frame, any aspect, cinematic motion' },
  'kling-2.5':   { label: 'Kling 2.5 turbo pro', provider: 'fal', endpoint: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video', textEndpoint: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video', endFrame: true, audio: false, seconds: [5, 10], aspects: ['landscape'], text: true, usdPerSecond: 0.07, note: 'fast, sharp, landscape' },
  'luma-ray2':   { label: 'Luma Ray-2', provider: 'fal', endpoint: 'fal-ai/luma-dream-machine/ray-2/image-to-video', endFrame: true, audio: false, seconds: [5, 9], aspects: 'any', text: false, usdPerSecond: 0.10, note: 'keyframes, smooth morphs' },
  'hailuo-02':   { label: 'MiniMax Hailuo-02 pro', provider: 'fal', endpoint: 'fal-ai/minimax/hailuo-02/pro/image-to-video', endFrame: true, audio: false, seconds: [6], aspects: ['landscape'], text: false, usdPerSecond: 0.08, note: '1080p, first+last frame' },
}

const b64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf); let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
  return btoa(s)
}
const dataUri = (buf: ArrayBuffer) => 'data:image/jpeg;base64,' + b64(buf)
const ratio = (a: Aspect) => (a === 'portrait' ? '9:16' : a === 'square' ? '1:1' : '16:9')
// nearest allowed length; on a tie the longer one wins (a 5 s ask becomes 6 s on Veo, not 4)
const nearest = (want: number, allowed: number[]) => { const a = allowed.slice().sort((x, y) => y - x); return a.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best), a[0]) }

export const hasProvider = (env: Env, m: VideoModel) => (m.provider === 'gemini' ? !!env.GEMINI_API_KEY : !!env.FAL_KEY)
export const videoGenAvailable = (env: Env) => !!(env.GEMINI_API_KEY || env.FAL_KEY)

/** Candidate models for a request, best first. */
export function pickModels(env: Env, req: ClipRequest): string[] {
  const fits = (id: string) => {
    const m = VIDEO_MODELS[id]; if (!m || !hasProvider(env, m)) return false
    if (m.aspects !== 'any' && !m.aspects.includes(req.aspect)) return false
    if (req.lastImage && !m.endFrame) return false
    if (!req.image && !m.text) return false
    return true
  }
  const order = req.lastImage ? ['veo-3.1', 'kling-2.1', 'luma-ray2', 'kling-2.5', 'hailuo-02']
    : req.image ? ['veo-3.1', 'veo-3.1-fal', 'kling-2.5', 'kling-2.1', 'luma-ray2']
    : ['veo-3.1', 'veo-3.1-fal', 'kling-2.5']
  const list = order.filter(fits)
  if (req.model && fits(req.model)) return [req.model, ...list.filter(x => x !== req.model)]
  return list
}

export const estimateUsd = (model: string, seconds: number) => +((VIDEO_MODELS[model]?.usdPerSecond || 0.1) * seconds).toFixed(2)
/** What the FIRST model that would run charges for this request (the cap check uses it; the actual model is charged after). */
export function estimateFor(env: Env, req: ClipRequest): number {
  const id = pickModels(env, req)[0]; if (!id) return 0
  const m = VIDEO_MODELS[id]; const secs = nearest(req.seconds || (req.lastImage ? 5 : 6), m.seconds)
  return estimateUsd(id, m.provider === 'gemini' ? 8 : secs)
}

/** Longest one generateClip() call may take, across every model it falls back to. The agent bridge's
 *  generate_clip timeout (agent/timeouts.mjs) is set just above this. */
export const GEN_BUDGET_MS = 12 * 60_000

/**
 * A job was SUBMITTED (and is likely billed) but did not finish in time. It is not a failure to fall
 * back from: the job may still complete on the provider's side, so moving on to the next model would
 * pay for a second clip. The chain stops here and the caller says so.
 */
export class GenTimeout extends Error {
  model: string
  constructor(model: string) {
    super(`${VIDEO_MODELS[model]?.label || model} was still generating when the time ran out. It may still finish (and be billed) on the provider's side; check there before trying again.`)
    this.name = 'GenTimeout'; this.model = model
  }
}

/* ---- fal.ai queue runner ---------------------------------------------------------------- */
async function falRun(env: Env, endpoint: string, input: Record<string, unknown>, maxMs = 8 * 60_000, model = endpoint): Promise<ArrayBuffer | null> {
  const H = { Authorization: 'Key ' + env.FAL_KEY!, 'Content-Type': 'application/json' }
  const submit = await fetch('https://queue.fal.run/' + endpoint, { method: 'POST', headers: H, body: JSON.stringify(input) })
  if (!submit.ok) { console.error('fal submit', endpoint, submit.status, (await submit.text()).slice(0, 300)); return null }
  const q = await submit.json() as { status_url?: string; response_url?: string }
  if (!q.status_url || !q.response_url) return null
  const t0 = Date.now()
  let done = false
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 5000))
    // a network blip while polling is not a failed job: keep polling rather than fall back and pay twice
    const st = await fetch(q.status_url, { headers: { Authorization: H.Authorization } }).catch(() => null)
    const sj = (st ? await st.json().catch(() => ({})) : {}) as { status?: string }
    if (sj.status === 'COMPLETED') { done = true; break }
    if (sj.status === 'FAILED' || sj.status === 'CANCELLED') { console.error('fal job', endpoint, sj.status); return null }
  }
  // Out of time with the job still queued or running: it used to fall through to the next model
  // here, which submitted (and paid for) a second generation while the first could still finish.
  if (!done) throw new GenTimeout(model)
  const res = await fetch(q.response_url, { headers: { Authorization: H.Authorization } })
  if (!res.ok) { console.error('fal result', endpoint, res.status, (await res.text()).slice(0, 300)); return null }
  const rj = await res.json() as { video?: { url?: string } }
  if (!rj.video?.url) return null
  const v = await fetch(rj.video.url)
  return v.ok ? v.arrayBuffer() : null
}

function falInput(id: string, req: ClipRequest, seconds: number): { endpoint: string; input: Record<string, unknown> } | null {
  const m = VIDEO_MODELS[id]
  const img = req.image ? dataUri(req.image) : undefined, last = req.lastImage ? dataUri(req.lastImage) : undefined
  const neg = 'blur, distortion, warping, extra limbs, text, watermark, low quality'
  switch (id) {
    case 'veo-3.1-fal':
      return img ? { endpoint: m.endpoint!, input: { prompt: req.prompt, image_url: img, aspect_ratio: ratio(req.aspect), duration: `${seconds}s`, resolution: '720p', generate_audio: req.audio !== false, negative_prompt: neg } }
        : { endpoint: m.textEndpoint!, input: { prompt: req.prompt, aspect_ratio: ratio(req.aspect), duration: `${seconds}s`, resolution: '720p', generate_audio: req.audio !== false, negative_prompt: neg } }
    case 'kling-2.1':
      return { endpoint: m.endpoint!, input: { prompt: req.prompt, image_url: img, ...(last ? { tail_image_url: last } : {}), duration: String(seconds), aspect_ratio: ratio(req.aspect), negative_prompt: neg, cfg_scale: 0.5 } }
    case 'kling-2.5':
      return img ? { endpoint: m.endpoint!, input: { prompt: req.prompt, image_url: img, ...(last ? { tail_image_url: last } : {}), duration: String(seconds), negative_prompt: neg, cfg_scale: 0.5 } }
        : { endpoint: m.textEndpoint!, input: { prompt: req.prompt, duration: String(seconds), aspect_ratio: ratio(req.aspect), negative_prompt: neg } }
    case 'luma-ray2':
      return { endpoint: m.endpoint!, input: { prompt: req.prompt, image_url: img, ...(last ? { end_image_url: last } : {}), aspect_ratio: ratio(req.aspect), duration: `${seconds}s`, resolution: '720p' } }
    case 'hailuo-02':
      return { endpoint: m.endpoint!, input: { prompt: req.prompt, image_url: img, ...(last ? { end_image_url: last } : {}), prompt_optimizer: true } }
    default: return null
  }
}

/* ---- Google Veo 3.1 via the Gemini API ---------------------------------------------------- */
async function veoRun(env: Env, req: ClipRequest, maxMs = 8 * 60_000): Promise<ArrayBuffer | null> {
  const H = { 'x-goog-api-key': env.GEMINI_API_KEY!, 'Content-Type': 'application/json' }
  const inst: Record<string, unknown> = { prompt: req.prompt }
  if (req.image) inst.image = { inlineData: { mimeType: 'image/jpeg', data: b64(req.image) } }
  if (req.lastImage) inst.lastFrame = { inlineData: { mimeType: 'image/jpeg', data: b64(req.lastImage) } }
  const start = await fetch('https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning', {
    method: 'POST', headers: H, body: JSON.stringify({ instances: [inst], parameters: { aspectRatio: req.aspect === 'portrait' ? '9:16' : '16:9', resolution: '720p', durationSeconds: '8' } }),
  })
  if (!start.ok) { console.error('veo start', start.status, (await start.text()).slice(0, 300)); return null }
  const op = await start.json() as { name?: string }
  if (!op.name) return null
  let uri: string | null = null, done = false
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 8000))
    const st = await fetch('https://generativelanguage.googleapis.com/v1beta/' + op.name, { headers: H }).catch(() => null)
    const sj = (st ? await st.json().catch(() => ({})) : {}) as { done?: boolean; error?: unknown; response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } } }
    if (sj.error) { console.error('veo', JSON.stringify(sj.error).slice(0, 300)); return null }
    if (sj.done) { done = true; uri = sj.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri || null; break }
  }
  if (!done) throw new GenTimeout('veo-3.1')   // still running: never fall back and pay twice
  if (!uri) return null
  const v = await fetch(uri, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY! } })
  return v.ok ? v.arrayBuffer() : null
}

/**
 * Try the candidates in order; the first clip wins. A model that refused or failed hands over to the
 * next, all inside one time budget (GEN_BUDGET_MS) so the whole call has a known ceiling. A model
 * that was still working when its time ran out throws GenTimeout instead: that job may yet finish
 * and bill, so nothing else is submitted.
 */
export async function generateClip(env: Env, req: ClipRequest, budgetMs = GEN_BUDGET_MS): Promise<ClipResult | null> {
  const deadline = Date.now() + budgetMs
  for (const id of pickModels(env, req)) {
    const left = deadline - Date.now()
    if (left < 60_000) break                       // not enough time left for another model to finish
    const maxMs = Math.min(8 * 60_000, left)
    const m = VIDEO_MODELS[id]
    const seconds = nearest(req.seconds || (req.lastImage ? 5 : 6), m.seconds)
    try {
      if (m.provider === 'gemini') {
        const bytes = await veoRun(env, req, maxMs)
        if (bytes) return { bytes, seconds: 8, hasAudio: true, model: id }
        continue
      }
      const spec = falInput(id, req, seconds); if (!spec) continue
      const bytes = await falRun(env, spec.endpoint, spec.input, maxMs, id)
      if (bytes) return { bytes, seconds, hasAudio: m.audio && req.audio !== false, model: id }
    } catch (e) {
      if (e instanceof GenTimeout) throw e
      console.error('videogen', id, e)
    }
  }
  return null
}
