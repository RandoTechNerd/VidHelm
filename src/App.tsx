import { useState, useRef, useEffect, useCallback, useMemo, Component, type ReactNode } from 'react'
import './App.css'
import { VidHelmMark, IcSave, IcOpen, IcCloud, IcRecipe, IcCube, IcSparkle, IcBot, IcSun, IcMoon, IcHelp, IcRefresh, IcFolder, IcPlus, IcBooth, IcVoice, IcCut, IcList, IcCheck, IcEye, IcChat, IcMissing } from './icons'
import { Tour, tourSeen } from './tour'
import { HelpChat } from './helpchat'
import type { HelpAction } from '../electron/helpdesk'
import { SfxPanel, MarkerPanel, KaraokeBooth, NarrationModal, RecipeSection, ThumbnailModal, ConnectModal, DEFAULT_RECIPE, recipeActive, newMarker, saveTake, type Marker, type SfxItem, type RecipeSettings } from './extras'
import { Model3DModal, KEY_GREEN, KEY_MAGENTA, type Model3DApi } from './model3d'
import { HelpModal, InfoNote, type HelpPanel } from './help'
import { TakesModal, takeStats, type TakeAnalysis } from './takes'
import { groupTakes, removalRanges, removedSeconds, chunksFromWords, wordsOf } from '../electron/takes'
import { snapToGrid, describeSnap } from '../electron/grid'
import { fitBpm } from '../electron/score'
import { layoutReport, presetFor, fitFontSize } from '../electron/textlayout'
import { THEMES, THEME_FONTS, CAPTION_Y as THEME_CAP_Y, chooseTheme, phrasesFromWords, captionFrame, captionCss, captionPx, fontFaceCss, type CaptionSpec, type CapWord, type ThemeFont, type CapCue } from '../electron/styletheme'
import { planProxy, isHdr } from '../electron/playable'
import { spanForPhrase, sentenceSpans, type Word as SpeechWord, type Span } from '../electron/speech'
import { planBroll, snapToWords, describePlan, type BrollAsset, type Placement } from '../electron/broll'
import { looksLikeThumbPhoto } from '../electron/thumbpick'
import { resolveProfile, describeProfile, type PerfProfile, type Tier, type TierPreference } from '../electron/capability'
import { tickStepFor, contentWidth, collectSnapTargets, nearestTarget, snapMove, trimTo, clampToSource, maxDurationFrom, moveReadout, trimReadout, stripTiles, stripFits, shiftWords, offSpeechNote } from '../electron/timeline'
import { TimeRuler } from './ruler'

interface MediaFile {
  id: string
  name: string
  path: string
  type: 'video' | 'audio' | 'image'
  duration: number
  hasVideo: boolean
  hasAudio: boolean
  chromaKey?: string   // 3D renders made on a key colour: removed on export, keyed in preview
  // A watchable stand-in for footage the preview cannot decode (phone HEVC, 10-bit, HDR, huge
  // frames). The preview plays it; a Standard export reads it only when it is at least as big and
  // as smooth as the export itself (see exportSource), otherwise, and at High quality, the original.
  proxyPath?: string
  proxyWidth?: number  // the copy's real frame size and rate, as make-proxy measured them
  proxyHeight?: number
  proxyFps?: number
  proxyPct?: number    // 0-100 while it is being made
  proxyNote?: string   // why it needed one, shown in the bin
  hdr?: boolean        // HLG/PQ source: export tone-maps it, or the colour comes out flat
  fps?: number         // the source's own frame rate (a 30 fps copy of 30 fps footage loses nothing)
  relPath?: string     // where it sat inside the project folder when saved, so a moved folder relinks
  offline?: boolean    // the file is not where the project says and nothing matched: relink or remove it
}

interface TimelineClip {
  id: string
  mediaId: string
  type: 'video' | 'audio' | 'image'
  trackId: 'v1' | 'v2' | 'a1' | 'a2'   // video · b-roll (picture only, over v1) · voice/music · SFX
  start: number       // seconds on timeline
  duration: number    // seconds
  sourceStart: number // seconds into source
  volume: number      // 0.0 - 2.0 (flat gain when no automation points)
  fadeIn: number      // seconds
  fadeOut: number     // seconds
  // Audio-only ramps, independent of the picture. A pause cut wants a hard cut on
  // the picture but never a hard cut on the WAVEFORM: splicing mid-cycle leaves a
  // step, and a step is a click. Undefined = follow fadeIn/fadeOut.
  aFadeIn?: number
  aFadeOut?: number
  volumePoints?: { t: number; v: number }[] // automation: t = seconds from clip start, v = gain 0..2
}

interface AppSettings {
  brand: { enabled: boolean; logoPath: string | null; position: 'tl' | 'tr' | 'bl' | 'br' | 'center'; sizePct: number; margin: number; opacity: number; showMode: 'whole' | 'intro' | 'outro'; windowSec: number; fade: number }
  intro: { segment: 'first' | 'last'; seconds: number; fade: number; treatment: 'ripple' | 'overlay' }
  audio: { optimize: boolean; noiseReduction: boolean }
  /** theme: a theme id or the creator's words ("futuristic tech"); 'classic' = the plain style below. tweak: words on top ("but blue") */
  caption: { fontSize: number; color: string; position: 'lower' | 'top' | 'center'; box: boolean; boxOpacity: number; model: 'tiny' | 'base' | 'small'; language: string; mode: 'phrase' | 'word'; theme: string; tweak: string }
  silence: { minPause: number; thresholdDb: number; pad: number; smooth: boolean; transition: number; detectBy: 'auto' | 'audio' | 'motion'; freezeDb: number }
  narration: { command: string }
  sfxGen: { command: string; freesoundToken?: string; favorites?: string[] }
  /** AI video generation keys (fal.ai for Kling / Luma / Veo fast, Gemini for Veo 3.1 with sound). */
  aiGen: { falKey?: string; geminiKey?: string }
  workspace: { root: string | null; autoLoad: boolean }
  /** how hard to work this machine. 'auto' follows what was detected at startup. */
  performance: { preference: TierPreference }
  recipe: RecipeSettings
}

const DEFAULT_SETTINGS: AppSettings = {
  brand: { enabled: false, logoPath: null, position: 'br', sizePct: 16, margin: 40, opacity: 0.85, showMode: 'whole', windowSec: 5, fade: 0.5 },
  intro: { segment: 'first', seconds: 5, fade: 0.6, treatment: 'ripple' },
  audio: { optimize: true, noiseReduction: false },
  caption: { fontSize: 44, color: '#ffffff', position: 'lower', box: true, boxOpacity: 0.5, model: 'tiny', language: 'en', mode: 'phrase', theme: 'creator', tweak: '' },
  silence: { minPause: 0.8, thresholdDb: -30, pad: 0.12, smooth: true, transition: 0.12, detectBy: 'auto', freezeDb: -50 },
  narration: { command: '' },
  sfxGen: { command: '' },
  aiGen: {},
  performance: { preference: 'auto' },
  workspace: { root: null, autoLoad: true },
  recipe: { text: DEFAULT_RECIPE, introAudioPath: null },
}

// Every agent command carries an id. StrictMode's double mount, and, in dev, hot reloads
// that leave the previous module's listener registered, meant one command could be executed
// several times (two tags from a single add_tag). The guard hangs off window so it is shared
// by every module instance that survives a reload, not just the current one.
const handledAgentCmds: Set<number> = ((window as any).__vhHandledCmds ??= new Set<number>())

// Preview-side chroma key. The export does the real thing with FFmpeg's colorkey; this is
// the same idea as an SVG filter so what you see on the stage matches what you render.
// The alpha row measures how much the key channel dominates, then the transfer turns that
// into a hard cut with a soft edge.
const keyFilterFor = (hex: string) => (hex.toLowerCase() === KEY_MAGENTA ? 'vh-key-magenta' : 'vh-key-green')
const ChromaKeyFilters = () => (
  <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
    <defs>
      <filter id="vh-key-green" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  -1 1 -1 0 0" result="dom" />
        <feComponentTransfer in="dom" result="mask"><feFuncA type="linear" slope="-14" intercept="1.35" /></feComponentTransfer>
        <feComposite in="SourceGraphic" in2="mask" operator="in" />
      </filter>
      <filter id="vh-key-magenta" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  1 -1 1 0 0" result="dom" />
        <feComponentTransfer in="dom" result="mask"><feFuncA type="linear" slope="-14" intercept="1.9" /></feComponentTransfer>
        <feComposite in="SourceGraphic" in2="mask" operator="in" />
      </filter>
    </defs>
  </svg>
)

// Everything in the header except these moves the window (see electron/dragMath.ts)
const HDR_CONTROLS = 'button, a, input, select, label, [role="button"]'

// What the app accepts. FFmpeg decodes far more than the browser does, so these lists are
// only a first guess, ffprobe has the final say (see importFiles), which means an unusual
// but valid file still imports, and a mislabelled one is refused with a reason.
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'f4v', 'mpg', 'mpeg', 'mpe', 'm2v', 'ts', 'm2ts', 'mts', 'vob', '3gp', '3g2', 'ogv', 'mxf', 'asf', 'divx', 'rm', 'rmvb', 'y4m'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'wave', 'aac', 'm4a', 'm4b', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'aifc', 'caf', 'ac3', 'eac3', 'dts', 'amr', 'mka', 'mp2', 'au', 'ape', 'wv', 'ra', 'weba'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'ico', 'ppm', 'pgm', 'tga', 'dds', 'exr'])
const MODEL_EXT = new Set(['stl', '3mf', 'obj', 'glb', 'gltf'])
const PAGE_EXT = new Set(['html', 'htm'])
const ACCEPT_ATTR = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT, ...MODEL_EXT, ...PAGE_EXT].map(e => '.' + e).join(',')
const extOf = (name: string) => (name.split('.').pop() || '').toLowerCase()

// Friendlier explanations for things people drop by mistake
const WRONG_TYPE: Record<string, string> = {
  svg: 'SVG vectors can’t be rendered by the export engine, save it as a PNG first.',
  pdf: 'PDFs aren’t media, export the page as a PNG or MP4 first.',
  psd: 'Photoshop files aren’t supported, export a flattened PNG or JPG.',
  ai: 'Illustrator files aren’t supported, export a PNG.',
  zip: 'That’s an archive, unzip it and drop the media inside.',
  rar: 'That’s an archive, unpack it and drop the media inside.',
  '7z': 'That’s an archive, unpack it and drop the media inside.',
  txt: 'That’s a text file, not media.',
  docx: 'That’s a document, not media.',
  pptx: 'That’s a slide deck, export it as images or a video first.',
  xlsx: 'That’s a spreadsheet, not media.',
  exe: 'That’s a program, not media.',
  gcode: 'G-code is print instructions, not a model, drop the STL/3MF instead.',
  step: 'STEP CAD files aren’t supported yet, export an STL, 3MF or OBJ.',
  stp: 'STEP CAD files aren’t supported yet, export an STL, 3MF or OBJ.',
  f3d: 'Fusion files aren’t supported, export an STL, 3MF or OBJ.',
  blend: 'Blender files aren’t supported, export a GLB, OBJ or STL.',
  srt: 'Subtitle files aren’t imported, use the Captions button instead.',
}

// ffprobe is the authority on what can be decoded, with one catch: it cheerfully reads a
// text file as "ansi video" (the tty demuxer) and subtitles as streams. Those are filtered
// out here so a stray .txt can't land on the timeline as a 0.04s clip.
// width/height are as DISPLAYED (a rotated phone clip comes back upright) and rotation is the
// clockwise turn that took; the whole probe goes to makeProxy, which needs it to keep the copy upright.
type Probe = { duration: number; hasVideo: boolean; hasAudio: boolean; ok?: boolean; error?: string; format?: string; videoCodec?: string; pixFmt?: string; colorTransfer?: string; width?: number; height?: number; fps?: number; rotation?: number }
const JUNK_FORMAT = /(^|,)(tty|ansi|image2pipe|srt|ass|ssa|webvtt|lrc|microdvd|subviewer|jacosub|mpsub|pjs|realtext|sami|vplayer)(,|$)/
// iPhone photos. The preview could show some, but the exporter cannot decode them, so a HEIC on
// the timeline only failed at the end of an export. Refused at the door instead, with the way out.
const NO_EXPORT_STILL: Record<string, string> = {
  heic: 'HEIC photos can’t be exported yet: save it as a JPG or PNG first (on an iPhone, Settings > Camera > Formats > Most Compatible takes JPGs from now on).',
  heif: 'HEIF photos can’t be exported yet: save it as a JPG or PNG first.',
}
const classifyMedia = (name: string, meta: Probe | null): { type: 'video' | 'audio' | 'image' } | { reject: string } => {
  const ext = extOf(name)
  if (WRONG_TYPE[ext]) return { reject: WRONG_TYPE[ext] }
  if (NO_EXPORT_STILL[ext]) return { reject: NO_EXPORT_STILL[ext] }
  const knownImage = IMAGE_EXT.has(ext)
  const knownAV = VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)
  if (!meta) return { reject: 'could not be read' }
  if (meta.ok === false || JUNK_FORMAT.test(meta.format || '') || meta.videoCodec === 'ansi') {
    // The exporter reads pictures with the same FFmpeg, so one ffprobe cannot read would only fail
    // at export time (it used to be let in because the preview might still show it).
    if (knownImage) return { reject: 'couldn’t be read (a damaged picture, or a kind the export can’t decode): save it as a PNG or JPG first' }
    return { reject: knownAV ? 'couldn’t be read (damaged, or an unsupported codec)' : 'not a video, audio, image or 3D file' }
  }
  if (!meta.hasVideo && !meta.hasAudio) return { reject: 'there’s no video or audio inside it' }
  const isStill = knownImage || /image2|_pipe/.test(meta.format || '')
  if (!isStill && !knownAV && !meta.hasAudio && (meta.duration || 0) < 0.1) return { reject: 'not a video, audio, image or 3D file' }
  return { type: isStill ? 'image' : meta.hasVideo ? 'video' : 'audio' }
}

const CAPTION_LANGS: [string, string][] = [['en', 'English (fast)'], ['auto', 'Auto-detect'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['ko', 'Korean'], ['it', 'Italian']]

const CAPTION_Y: Record<'lower' | 'top' | 'center', number> = { lower: 0.86, top: 0.12, center: 0.5 }

interface TextClip {
  id: string
  text: string
  start: number
  duration: number
  x: number           // 0..1 relative to frame
  y: number           // 0..1
  fontSize: number    // px referenced at 1080p height
  color: string
  fadeIn: number
  fadeOut: number
  box?: boolean       // background bar behind text
  boxOpacity?: number // 0..1
  boxColor?: string
  /** a style-theme font (public/fonts); unset = the default sans */
  font?: ThemeFont
  /** outline width as a fraction of the font size */
  outline?: number
  outlineColor?: string
  /** a themed caption: its style, the words that asked for it, and word timings in seconds from the cue's start */
  caption?: { spec: CaptionSpec; theme: string; words?: CapWord[] }
}

/* style-theme fonts for the preview (the export reads the same files from disk) */
let themeFontsInjected = false
function injectThemeFonts() {
  if (themeFontsInjected || typeof document === 'undefined') return
  themeFontsInjected = true
  const st = document.createElement('style')
  st.textContent = fontFaceCss(f => `./fonts/${f}`)
  document.head.appendChild(st)
  // fetch them now, so the first caption in a new theme does not flash in the fallback font
  if (document.fonts) for (const f of Object.values(THEME_FONTS)) document.fonts.load(`${f.bold ? 700 : 400} 40px '${f.family}'`).catch(() => {})
}
injectThemeFonts()
const themeRequest = (cs: { theme?: string; tweak?: string }) => `${cs.theme || 'creator'} ${cs.tweak || ''}`.trim()
/** A themed caption cue as a timeline text item. */
function captionClip(p: CapCue, spec: CaptionSpec, theme: string, outW: number, outH: number): TextClip {
  return { id: rid(), text: p.text, start: p.start, duration: Math.max(0.3, p.end - p.start), x: 0.5, y: THEME_CAP_Y[spec.position],
    fontSize: Math.round(captionPx(spec, outW, outH) / outH * 1080), color: spec.color, fadeIn: 0, fadeOut: 0,
    caption: { spec, theme, words: (p.words || []).map(w => ({ s: +(w.s - p.start).toFixed(3), e: +(w.e - p.start).toFixed(3), t: w.t })) } }
}
/** A themed caption in the preview, drawn from the same per-frame description the export follows. */
function CaptionLayer({ t, time, groupBase, outW, outH, stageH, selected, onSelect }: { t: TextClip; time: number; groupBase: number; outW: number; outH: number; stageH: number; selected: boolean; onSelect: () => void }) {
  const spec = t.caption!.spec
  const cue = { start: t.start, end: t.start + t.duration, text: t.text, words: t.caption!.words?.map(w => ({ s: t.start + w.s, e: t.start + w.e, t: w.t })) }
  const fr = captionFrame(cue, spec, time, groupBase)
  if (!fr) return null
  const px = captionPx(spec, outW, outH) * stageH / outH
  const css = captionCss(spec, px) as React.CSSProperties
  if (spec.motion === 'glitch') css.textShadow = `${(-fr.glitch * px).toFixed(1)}px 0 0 ${spec.shadowColor}`
  const place: React.CSSProperties = spec.position === 'top' ? { top: '7%' } : spec.position === 'center' ? { top: '50%', transform: 'translateY(-50%)' } : { bottom: spec.position === 'lower' ? '20%' : '7%' }
  return (
    <div className={`cap-layer ${selected ? 'editing' : ''}`} style={place} onMouseDown={e => { e.stopPropagation(); onSelect() }} title="Themed caption: edit the words in the timeline">
      <span className="cap-text" style={{ ...css, opacity: fr.opacity, transform: `scale(${fr.scale}) rotate(${-fr.tilt}deg)` }}>
        {fr.pieces.map((p, i) => <span key={i} style={{ color: p.color, visibility: p.hidden ? 'hidden' : 'visible' }}>{p.t}{i < fr.pieces.length - 1 ? ' ' : ''}</span>)}
      </span>
    </div>
  )
}

type OrientationKey = 'landscape' | 'portrait' | 'square'
type ResolutionKey = '4K' | '1440p' | '1080p' | '720p'

const ORIENTATIONS: Record<OrientationKey, { label: string; sub: string; ratio: number; dims: Record<ResolutionKey, [number, number]> }> = {
  landscape: { label: 'Landscape', sub: '16:9', ratio: 16 / 9, dims: { '4K': [3840, 2160], '1440p': [2560, 1440], '1080p': [1920, 1080], '720p': [1280, 720] } },
  portrait:  { label: 'Portrait',  sub: '9:16', ratio: 9 / 16, dims: { '4K': [2160, 3840], '1440p': [1440, 2560], '1080p': [1080, 1920], '720p': [720, 1280] } },
  square:    { label: 'Square',    sub: '1:1',  ratio: 1,      dims: { '4K': [2160, 2160], '1440p': [1440, 1440], '1080p': [1080, 1080], '720p': [720, 720] } },
}

// The frame format arrives from agents ("4k", "2160p", "vertical") and from project files
// (hand-edited, older, cloud-imported). Anything off these lists used to reach the dims lookup
// below as undefined and unmount the whole editor, so every entry point normalises first.
const RES_ALIASES: Record<string, ResolutionKey> = {
  '4k': '4K', '2160p': '4K', '2160': '4K', 'uhd': '4K',
  '1440p': '1440p', '1440': '1440p', '2k': '1440p', 'qhd': '1440p',
  '1080p': '1080p', '1080': '1080p', 'fhd': '1080p',
  '720p': '720p', '720': '720p', 'hd': '720p',
}
const ORIENT_ALIASES: Record<string, OrientationKey> = {
  landscape: 'landscape', horizontal: 'landscape', wide: 'landscape', '16:9': 'landscape',
  portrait: 'portrait', vertical: 'portrait', '9:16': 'portrait',
  square: 'square', '1:1': 'square',
}
const normResolution = (v: unknown): ResolutionKey | null => RES_ALIASES[String(v ?? '').trim().toLowerCase()] ?? null
const normOrientation = (v: unknown): OrientationKey | null => ORIENT_ALIASES[String(v ?? '').trim().toLowerCase()] ?? null
const normFps = (v: unknown): 24 | 30 | 60 | null => {
  const n = Number(String(v ?? '').trim().replace(/\s*fps$/i, ''))
  return n === 24 || n === 30 || n === 60 ? n : null
}
const frameDims = (o: OrientationKey, r: ResolutionKey): [number, number] => ORIENTATIONS[o]?.dims[r] ?? ORIENTATIONS.landscape.dims['1080p']

// One stacking rule for the preview and the export: by track (b-roll over the A-roll), then
// array order within a track, later on top. Array.sort is stable, so nothing else reorders them.
// The export used to break ties by start time, so an overlay appended at the playhead (a 3D
// render) dropped UNDER the next cut in the render while the preview showed it on top.
const TRACK_LAYER: Record<string, number> = { v1: 0, v2: 1, a1: 2, a2: 3 }
const layerOrder = <T extends { trackId: string }>(list: T[]): T[] => [...list].sort((a, b) => TRACK_LAYER[a.trackId] - TRACK_LAYER[b.trackId])
// A drag edge snaps to anything within this many screen pixels (Alt drags freely)
const SNAP_PX = 8
// Clip heights on the picture rows (.track height minus the clip's 3px inset each side in App.css):
// filmstrip frames are sized to these so they keep their 16:9 shape.
const STRIP_TILE_H: Record<string, number> = { v1: 46, v2: 34 }
/** A media item's own length when trims must stay inside it; undefined for stills and unknown lengths. */
const footageLength = (m?: { type: string; duration: number }) => m && m.type !== 'image' && m.duration > 0 ? m.duration : undefined
// drag payload for an item pulled out of the Media panel onto the timeline
const MEDIA_DRAG = 'application/x-vidhelm-media'

// Icons
const IconExport = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
const IconPlus = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
const IconAudio = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
const IconFolder = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
const IconScissors = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
const IconTrash = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
const IconPlay = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>
const IconPause = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>
const IconText = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>
const IconMic = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg>
const IconExpand = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
const IconVolume = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
const IconUndo = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
const IconRedo = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
const IconChevron = ({ open }: { open: boolean }) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}><path d="m9 18 6-6-6-6"/></svg>
const IconCaptions = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 13h2M7 10h2M13 10h4M13 13h4"/></svg>
const IconInfo = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-5M12 8h.01"/></svg>

// Everything that used to sit as a row of bare icons in the header, now behind the (i)
const LINKS: { label: string; sub: string; url: string; icon: React.ReactNode; note?: string }[] = [
  { label: 'vidhelm.com', sub: 'downloads and news', url: 'https://vidhelm.com',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> },
  { label: 'GitHub', sub: 'star the repo, report a bug', url: 'https://github.com/RandoTechNerd/VidHelm',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-1.94c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.67.41.35.77 1.05.77 2.12v3.15c0 .3.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg> },
  { label: 'YouTube', sub: '@randotechnerd', url: 'https://www.youtube.com/@randotechnerd',
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.3 31.3 0 0 0 0 12a31.3 31.3 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.3 31.3 0 0 0 24 12a31.3 31.3 0 0 0-.5-5.8zM9.5 15.5v-7L15.8 12l-6.3 3.5z"/></svg> },
  { label: 'Instagram', sub: '@randotechnerd', url: 'https://www.instagram.com/randotechnerd/',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg> },
  { label: 'Buy me a coffee', sub: 'keeps the updates coming', url: 'https://buymeacoffee.com/randotechnerd',
    icon: <span style={{ fontSize: 15 }}>☕</span>,
    note: 'Please put "VidHelm" in the comment, there are a few projects on that page, plus any feature you want next. Requests that arrive with a coffee tend to jump the queue.' },
  { label: 'Discord', sub: 'help, ideas and show-and-tell', url: 'https://discord.gg/8fjQHDX8PQ',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18.2 18.2 0 0 0-5.6 0L8.6 3a19.5 19.5 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18a19.7 19.7 0 0 0 6 3l1.3-2a12.7 12.7 0 0 1-2-1l.5-.4a14 14 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.6 19.6 0 0 0 6-3c.5-5.1-.8-9.5-3.6-13.6ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z"/></svg> },
  { label: 'Email', sub: 'randotechnerd@gmail.com', url: 'mailto:randotechnerd@gmail.com',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg> },
]

const IconGear = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>

// Inline volume-automation editor: draggable line of gain points over a clip's duration.
function VolumeGraph({ points, duration, base, onChange }: { points: { t: number; v: number }[]; duration: number; base: number; onChange: (pts: { t: number; v: number }[]) => void }) {
  const ref = useRef<SVGSVGElement>(null)
  const W = 240, H = 90
  const pts = points.length ? [...points].sort((a, b) => a.t - b.t) : []
  const toX = (t: number) => (t / Math.max(0.001, duration)) * W
  const toY = (v: number) => H - (v / 2) * H
  const fromEvt = (e: MouseEvent | React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const t = clamp(((e.clientX - r.left) / r.width) * duration, 0, duration)
    const v = clamp((1 - (e.clientY - r.top) / r.height) * 2, 0, 2)
    return { t, v }
  }
  const addPoint = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'circle') return
    const p = fromEvt(e)
    onChange([...pts, p].sort((a, b) => a.t - b.t))
  }
  const dragPoint = (e: React.MouseEvent, i: number) => {
    e.stopPropagation()
    const move = (m: MouseEvent) => {
      const p = fromEvt(m)
      const next = pts.map((x, j) => j === i ? p : x).sort((a, b) => a.t - b.t)
      onChange(next)
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  const line = pts.length
    ? `M ${toX(0)} ${toY(pts[0].v)} ` + pts.map(p => `L ${toX(p.t)} ${toY(p.v)}`).join(' ') + ` L ${toX(duration)} ${toY(pts[pts.length - 1].v)}`
    : `M 0 ${toY(base)} L ${W} ${toY(base)}`
  return (
    <svg ref={ref} className="vol-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onClick={addPoint}>
      <line x1="0" y1={toY(1)} x2={W} y2={toY(1)} className="vg-unity" />
      <path d={line} className="vg-line" />
      {pts.map((p, i) => (
        <circle key={i} cx={toX(p.t)} cy={toY(p.v)} r="5" className="vg-pt" onMouseDown={(e) => dragPoint(e, i)} onDoubleClick={(e) => { e.stopPropagation(); onChange(pts.filter((_, j) => j !== i)) }} />
      ))}
    </svg>
  )
}

const rid = () => Math.random().toString(36).substr(2, 9)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
// Build a VALID file:// URL from a Windows path. Backslashes -> forward slashes, and every
// segment after the drive letter is percent-encoded (so spaces like "Claude Play" and #/? work).
const fileUrl = (p?: string | null) => p
  ? 'file:///' + p.replace(/\\/g, '/').split('/').map((seg, i) => i === 0 ? seg : encodeURIComponent(seg)).join('/')
  : ''
const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}.${Math.floor((s % 1) * 10)}`
const fmtEta = (s: number) => s >= 60 ? `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}` : `${Math.ceil(s)}s`

/** One bin entry from an ffprobe result. Every way media comes in goes through here, so none of
 *  them can forget the HDR flag again (without it the export skips the tone map: grey, flat). */
const mediaFromProbe = (name: string, path: string, type: MediaFile['type'], m: Probe, extra: Partial<MediaFile> = {}): MediaFile => ({
  id: rid(), name, path, type,
  duration: type === 'image' ? 5 : (m.duration || 5),
  hasVideo: m.hasVideo || type === 'image',
  hasAudio: m.hasAudio,
  hdr: isHdr({ colorTransfer: m.colorTransfer }),
  ...(m.fps ? { fps: m.fps } : {}),
  ...extra,
})

// Paths. Windows first, but nothing here assumes the backslash.
const baseName = (p: string) => p.split(/[\\/]/).pop() || p
// a drive or filesystem root keeps its separator: "C:" alone means the current directory on drive C
const dirName = (p: string) => { const d = p.replace(/[\\/][^\\/]*$/, ''); return /^[A-Za-z]:$/.test(d) ? d + '\\' : (d || '/') }
const pathKey = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const joinPath = (dir: string, rel: string) => { const sep = dir.includes('\\') ? '\\' : '/'; return dir.replace(/[\\/]+$/, '') + sep + rel.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep) }
/** p relative to dir when it sits inside it, else null */
const relInside = (dir: string, p: string) => { const d = pathKey(dir) + '\\'; return pathKey(p).startsWith(d) ? p.replace(/\//g, '\\').slice(d.length) : null }
// What scan-project lists (MEDIA_RE in electron/main.ts). A file of one of these types that is
// missing from its folder's listing is gone; anything else can only be judged by probing it.
const LISTED_EXT = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', '3gp', 'ogv', 'mxf', 'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'caf', 'ac3', 'mka', 'png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'])

/** A rejection from the main process as a readable line: no "Error invoking remote method" wrapper. */
const errText = (e: unknown) => {
  const s = String((e as { message?: string })?.message ?? e ?? 'unknown error')
    .replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Error:\s*)+/, '').replace(/\s+/g, ' ').trim()
  return s.length > 320 ? '...' + s.slice(-320) : (s || 'unknown error')
}
/** export-video's rejection ("Export failed: <reason>" then, on following lines, the end of
 *  ffmpeg's log or the list behind a count) split into the reason, one line for a toast, and the
 *  detail, for the log or an agent. Flattening it all into one line put ffmpeg's last words in the
 *  toast instead of the reason. */
const exportFailure = (e: unknown): { reason: string; detail: string } => {
  const raw = String((e as { message?: string })?.message ?? e ?? '')
    .replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Error:\s*)+/, '').trim()
  const [head = '', ...rest] = raw.split(/\r?\n/)
  const reason = head.replace(/^Export failed:\s*/i, '').trim() || 'unknown error'
  const detail = rest.join('\n').trim()
  return { reason: reason.length > 300 ? reason.slice(0, 300) + '...' : reason, detail: detail.length > 1500 ? '...' + detail.slice(-1500) : detail }
}
/** The toast for a failed export: the reason, plus the names when the reason is a count of them. */
const exportFailureText = (f: { reason: string; detail: string }) =>
  `Export failed: ${f.reason}${/^\d+ clips cannot be read$/.test(f.reason) && f.detail ? '\n' + f.detail.split('\n').slice(0, 4).join('\n') : ''}`

// ---- unsaved work ----
// The part of a project that is the user's work. Proxy paths, sizes, progress and the HDR flag
// are derived from the files and rebuilt on every open, so they never make a project "unsaved".
type DocFields = { mediaBin: MediaFile[]; clips: TimelineClip[]; texts: TextClip[]; markers: Marker[]; orientation: OrientationKey; resolution: ResolutionKey; fps: 24 | 30 | 60; masterVolume: number; exportQuality: 'medium' | 'high' }
const docKeyOf = (d: DocFields) => JSON.stringify([
  d.mediaBin.map(m => [m.id, m.path, m.name, m.type, m.duration, m.chromaKey ?? null]),
  d.clips, d.texts, d.markers, d.orientation, d.resolution, d.fps, d.masterVolume, d.exportQuality,
])
interface Autosave { savedAt: number; dir: string | null; name: string | null; file: string | null; data: any }
const AUTOSAVE_PREFIX = 'vh-autosave:'
const LAST_PROJECT_KEY = 'vh-last-project'
const autosaveKey = (dir: string | null) => AUTOSAVE_PREFIX + (dir ? pathKey(dir) : '_untitled')
const autosaveLocal = (a: Autosave) => { wroteSlots.add(autosaveKey(a.dir)); try { localStorage.setItem(autosaveKey(a.dir), JSON.stringify(a)) } catch { /* storage full or blocked: the file copy, or the next manual save, still covers it */ } }
// Main-process handlers this build may not have yet (an older main): asked once, then left alone
const missingIpc = new Set<string>()
async function optionalInvoke(channel: string, ...args: unknown[]): Promise<any> {
  if (missingIpc.has(channel)) return undefined
  try { return await window.ipcRenderer.invoke(channel, ...args) }
  catch (e) { if (/No handler registered/i.test(String((e as Error)?.message || e))) missingIpc.add(channel); return undefined }
}
/** Autosave: <project>/project.vidhelm.autosave.json (or the app-data folder when no project
 *  folder is open) through the main process; this machine's local storage if that is not there. */
// The live slots this session has written, so leaving a project with nothing unsaved (undone back
// to the save) can clear a copy that would otherwise look like lost work next time
const wroteSlots = new Set<string>()
async function writeAutosave(a: Autosave) {
  wroteSlots.add(autosaveKey(a.dir))
  const r = await optionalInvoke('autosave-write', { dir: a.dir, data: a })
  if (r?.path) { try { localStorage.removeItem(autosaveKey(a.dir)) } catch { /* fine */ } return }
  autosaveLocal(a)
}
async function readAutosave(dir: string | null): Promise<Autosave | null> {
  let best: Autosave | null = null
  const r = await optionalInvoke('autosave-read', { dir })
  if (r?.data?.data) best = r.data as Autosave
  try {
    const s = localStorage.getItem(autosaveKey(dir))
    const a = s ? JSON.parse(s) as Autosave : null
    if (a?.data && (!best || a.savedAt > best.savedAt)) best = a
  } catch { /* unreadable: ignore */ }
  return best
}
async function clearAutosave(dir: string | null) {
  await optionalInvoke('autosave-clear', { dir })
  try { localStorage.removeItem(autosaveKey(dir)) } catch { /* fine */ }
}
// Unsaved work the human said "Not now" to. The live slot above is rewritten by this session's
// autosave within 30 s of the first edit, so anything left for later is moved out of it first,
// into a slot of its own that only Restore or Discard ever removes.
const PENDING_TAG = ':pending:'
const pendingKey = (a: Autosave) => autosaveKey(a.dir) + PENDING_TAG + a.savedAt
function readPending(dir: string | null): Autosave[] {
  const out: Autosave[] = []
  try {
    const head = autosaveKey(dir) + PENDING_TAG
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith(head)) continue
      try { const a = JSON.parse(localStorage.getItem(k) || 'null') as Autosave | null; if (a?.data) out.push(a) } catch { /* unreadable: skip it */ }
    }
  } catch { /* storage blocked: nothing set aside */ }
  return out.sort((a, b) => b.savedAt - a.savedAt)
}
function dropPending(a: Autosave) { try { localStorage.removeItem(pendingKey(a)) } catch { /* fine */ } }
/** Move a live autosave into its own pending slot. False when it could not be kept (storage full),
 *  in which case it stays where it was. */
async function setAsideAutosave(a: Autosave): Promise<boolean> {
  try { localStorage.setItem(pendingKey(a), JSON.stringify(a)) } catch { return false }
  await clearAutosave(a.dir)
  return true
}
// The latest document, kept outside React so the autosave timer and the crash screen can save it
const liveDoc: { current: Autosave | null; dirty: boolean } = { current: null, dirty: false }
function setLiveDoc(a: Autosave | null, dirty: boolean) { liveDoc.current = a; liveDoc.dirty = dirty }
function autosaveNow() {
  const a = liveDoc.current
  if (a && liveDoc.dirty) void writeAutosave({ ...a, savedAt: Date.now() })
}

/** If something in the editor throws while rendering, React unmounts everything: a blank window,
 *  a dead agent bridge, and the work gone. This keeps a recovery copy and a way back instead. */
class CrashGuard extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) { return { error: errText(e) } }
  componentDidCatch(e: unknown) {
    console.error('VidHelm crashed while drawing', e)
    const a = liveDoc.current
    if (a && liveDoc.dirty) { const snap = { ...a, savedAt: Date.now() }; autosaveLocal(snap); void writeAutosave(snap) }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash-screen">
        <div>
          <h1>Something went wrong</h1>
          <p>VidHelm hit an error while drawing the editor{liveDoc.dirty ? ', and kept a copy of your unsaved work. Reload and it offers to restore it.' : '. Your saved projects are untouched.'}</p>
          <p className="crash-detail">{this.state.error}</p>
          <button className="primary" onClick={() => window.location.reload()}>Reload VidHelm</button>
        </div>
      </div>
    )
  }
}

// Opacity of a clip at time t given its fades (used for preview + mirrors export)
function fadeFactor(c: { start: number; duration: number; fadeIn: number; fadeOut: number }, t: number) {
  const into = t - c.start
  const toEnd = c.start + c.duration - t
  let o = 1
  if (c.fadeIn > 0) o = Math.min(o, into / c.fadeIn)
  if (c.fadeOut > 0) o = Math.min(o, toEnd / c.fadeOut)
  return clamp(o, 0, 1)
}

// Same, for AUDIO: uses the audio-only ramps when a cut set them, so the picture
// can cut hard while the waveform still ramps. Mirrors clipAudioChain in electron/exportgraph.ts,
// including its floor: every clip end ramps for at least DEPOP, and so does a start that is not
// the file's own beginning (sourceStart > 0), however the clip was made.
function audioFadeFactor(c: { start: number; duration: number; fadeIn: number; fadeOut: number; aFadeIn?: number; aFadeOut?: number; sourceStart?: number }, t: number) {
  const fadeIn = Math.max(c.aFadeIn ?? c.fadeIn ?? 0, (Number(c.sourceStart) || 0) > 0 ? DEPOP : 0)
  const fadeOut = Math.max(c.aFadeOut ?? c.fadeOut ?? 0, DEPOP)
  return fadeFactor({ start: c.start, duration: c.duration, fadeIn, fadeOut }, t)
}

// Interpolated gain at an absolute time, following the clip's volume automation line.
function gainAt(c: TimelineClip, tAbs: number) {
  const pts = c.volumePoints
  if (!pts || pts.length === 0) return c.volume ?? 1
  const rel = tAbs - c.start
  const P = [...pts].sort((a, b) => a.t - b.t)
  if (rel <= P[0].t) return P[0].v
  if (rel >= P[P.length - 1].t) return P[P.length - 1].v
  for (let i = 1; i < P.length; i++) {
    if (rel <= P[i].t) { const a = P[i - 1], b = P[i]; const f = (rel - a.t) / ((b.t - a.t) || 1); return a.v + (b.v - a.v) * f }
  }
  return c.volume ?? 1
}

// Remove timeline range [s,e] and ripple everything after it left. Used to cut silent dead space.
// If `transition` > 0, surviving edges get a short fade for a smoother seam.
// Twelve milliseconds: far too short to hear as a fade, long enough that the
// waveform reaches zero before the splice. Without it a cut lands mid-cycle and
// the step reads as a click ("poofs" between phrases).
const DEPOP = 0.012

// Tag points ride along when time is removed: after the cut they shift left by its length, and a
// tag inside the removed stretch lands on the join (or goes, when a whole head or tail is trimmed
// off). Tagging first and cutting second is the documented workflow, so tags must not drift.
function rippleMarkers(markers: Marker[], s: number, e: number, dropInside = false): Marker[] {
  const len = e - s
  const out: Marker[] = []
  for (const m of markers) {
    if (m.t < s) out.push(m)
    else if (m.t >= e) out.push({ ...m, t: +(m.t - len).toFixed(4) })
    else if (!dropInside) out.push({ ...m, t: s })
  }
  return out
}

function removeRange(clips: TimelineClip[], texts: TextClip[], s: number, e: number, transition: number, markers: Marker[] = [], dropTagsInside = false) {
  const len = e - s
  const td = Math.max(0, Math.min(transition, len, 0.3))
  const outClips: TimelineClip[] = []
  for (const c of clips) {
    const cs = c.start, ce = c.start + c.duration
    if (ce <= s) { outClips.push(c); continue }
    if (cs >= e) { outClips.push({ ...c, start: cs - len }); continue }
    const left = s - cs, right = ce - e
    // Both halves used to sit end to end, each with its own fade. Video composites over a black
    // base, so fading A out and B in at the very same instant dips through black: on a talking
    // head with a hundred pause cuts that reads as the picture blinking at you all the way
    // through. Overlap them instead and let B dissolve in ON TOP of A, which never sees black.
    const overlap = Math.max(0, Math.min(td, left - 0.05, e - cs))
    // The picture keeps whatever the transition setting asked for (including 0, and
    // including the deliberate no-fadeOut under an overlap so it never dips through
    // black). The AUDIO always gets at least DEPOP either side of the join.
    if (left > 0.05) outClips.push({
      ...c, duration: left,
      fadeOut: overlap > 0 ? 0 : (td > 0 ? td : c.fadeOut),
      aFadeOut: Math.max(DEPOP, overlap > 0 ? 0 : (td > 0 ? td : c.fadeOut)),
    })
    if (right > 0.05) outClips.push({
      ...c, id: rid(),
      start: s - overlap,
      duration: right + overlap,
      sourceStart: c.sourceStart + (e - cs) - overlap,   // pull the source back so motion stays continuous
      fadeIn: overlap > 0 ? overlap : (td > 0 ? td : c.fadeIn),
      aFadeIn: Math.max(DEPOP, overlap > 0 ? overlap : (td > 0 ? td : c.fadeIn)),
      volumePoints: undefined,
    })
  }
  const outTexts: TextClip[] = []
  for (const t of texts) {
    const ts = t.start, te = t.start + t.duration
    if (te <= s) { outTexts.push(t); continue }
    if (ts >= e) { outTexts.push({ ...t, start: ts - len }); continue }
    const left = s - ts, right = te - e
    if (left > 0.05) outTexts.push({ ...t, duration: left })
    if (right > 0.05) outTexts.push({ ...t, id: rid(), start: s, duration: right })
  }
  return { clips: outClips, texts: outTexts, markers: rippleMarkers(markers, s, e, dropTagsInside) }
}

function Editor() {
  const [mediaBin, setMediaBin] = useState<MediaFile[]>([])
  const [clips, setClips] = useState<TimelineClip[]>([])
  const [texts, setTexts] = useState<TextClip[]>([])
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [exportProgress, setExportProgress] = useState<number | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null) // clip or text id
  const [orientation, setOrientation] = useState<OrientationKey>('landscape')
  const [resolution, setResolution] = useState<ResolutionKey>('1080p')
  const [fps, setFps] = useState<24 | 30 | 60>(30)
  const [masterVolume, setMasterVolume] = useState(1)
  const [customExportPath, setCustomExportPath] = useState<string | null>(null)
  const [exportQuality, setExportQuality] = useState<'medium' | 'high'>('high')
  const [lastExport, setLastExport] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  // What the hardware turned out to be, measured once at startup in the main process.
  const [machine, setMachine] = useState<{ cpu?: string; detected?: Tier; reasons?: string[]; specs?: { cores: number; memGB: number; hwEncoder: boolean; benchMs: number } } | null>(null)
  // The profile actually in force: the user's choice if they made one, otherwise what was detected.
  const perf: PerfProfile = resolveProfile(settings.performance?.preference, machine?.detected)
  const [showSettings, setShowSettings] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [showModel3D, setShowModel3D] = useState(false)
  const [showAiClip, setShowAiClip] = useState(false)
  const [aiClipBusy, setAiClipBusy] = useState(false)
  // Long jobs an agent can start twice (a retry after the bridge timed out while the first run was
  // still going): each one is refused while it runs. Refs, not state, so two requests arriving in
  // the same tick both see the first one start.
  const busyRef = useRef({ aiClip: false, captions: false, score: false })
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiFrom, setAiFrom] = useState('')
  const [aiTo, setAiTo] = useState('')
  const [aiSeconds, setAiSeconds] = useState(5)
  const [model3DPath, setModel3DPath] = useState<string | null>(null)
  const [boothScript, setBoothScript] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const [showLinks, setShowLinks] = useState(false)
  const [projects, setProjects] = useState<{ name: string; path: string; media: number; saved: boolean; modified: number }[]>([])
  const [currentProject, setCurrentProject] = useState<{ dir: string; name: string } | null>(null)
  // Where Save writes when no project folder is open: the single project file it was opened from
  // or last saved as. A folder project and a file project are never both "current", so opening a
  // file can no longer make the next Save overwrite the folder project that was open before it.
  const [saveFile, setSaveFile] = useState<string | null>(null)
  // A small in-app question (Save / Don't save / Cancel and friends), answered through a promise
  const [ask, setAsk] = useState<{ title: string; body: string; choices: { id: string; label: string; primary?: boolean }[]; resolve: (id: string) => void } | null>(null)
  const askPending = useRef<((id: string) => void) | null>(null)
  const askChoice = (q: { title: string; body: string; choices: { id: string; label: string; primary?: boolean }[] }) =>
    new Promise<string>(resolve => {
      askPending.current?.('cancel')   // a newer question replaces one still open: that one counts as Cancel
      const done = (id: string) => { if (askPending.current === done) askPending.current = null; setAsk(null); resolve(id) }
      askPending.current = done
      setAsk({ ...q, resolve: done })
    })
  // while it is up, the editor's shortcuts stay quiet; Esc means Cancel (or Not now), never Discard
  useEffect(() => {
    if (!ask) return
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key !== 'Escape') return
      const c = ask.choices.find(x => x.id === 'cancel' || x.id === 'later')
      if (c) { e.preventDefault(); ask.resolve(c.id) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ask])
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => { window.ipcRenderer.agentStatus?.().then(s => setAppVersion(s?.appVersion || '')).catch(() => {}) }, [])
  const [scrubbing, setScrubbing] = useState(false)
  const scrubRaf = useRef(0)
  const model3dApi = useRef<Model3DApi | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; mediaId: string } | null>(null)
  const [qcReport, setQcReport] = useState<any>(null)
  const [qcRunning, setQcRunning] = useState(false)
  const [showQC, setShowQC] = useState(false)
  const [captioning, setCaptioning] = useState<string | null>(null) // status text while transcribing
  const [captionPct, setCaptionPct] = useState<number | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, { sig: string; n: number; path: string }>>({})
  const thumbsRef = useRef<Record<string, { sig: string; n: number; path: string }>>({})
  const [collapsed, setCollapsed] = useState<{ text: boolean; video: boolean; broll: boolean; audio: boolean; sfx: boolean }>({ text: false, video: false, broll: false, audio: false, sfx: false })
  const [markers, setMarkers] = useState<Marker[]>([])
  const [showBooth, setShowBooth] = useState(false)
  const [showNarration, setShowNarration] = useState(false)
  const [showThumbnail, setShowThumbnail] = useState(false)
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([])
  const notify = (text: string, ms = 7000) => { const id = rid(); setToasts(t => [...t, { id, text }]); setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), ms) }
  const [sidebarTab, setSidebarTab] = useState<'media' | 'sfx'>('media')
  const [silenceBusy, setSilenceBusy] = useState<string | null>(null)
  // Takes & history: the transcript, the repeat groups, and enough snapshots to let the user
  // change their mind about which take to keep without re-scanning.
  // Text you can type straight onto the picture. Without this the only way to change the words
  // was a box far down the right sidebar, which nobody finds.
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const editRef = useRef<HTMLDivElement | null>(null)
  const editTextRef = useRef<string>('')   // what to seed the editable div with
  const [showTakes, setShowTakes] = useState(false)
  const [takes, setTakes] = useState<TakeAnalysis | null>(null)
  const [takesBusy, setTakesBusy] = useState<string | null>(null)
  const takeSnap = useRef<{ before: string; after: string } | null>(null)
  const takesRef = useRef<TakeAnalysis | null>(null); takesRef.current = takes
  // the speech the scan was read from (speechKey), so a stale scan can never cut the wrong seconds
  const takesAt = useRef<string | null>(null)
  const [eta, setEta] = useState<number | null>(null)
  const exportStartRef = useRef(0)
  const settingsLoaded = useRef(false)

  const runQualityCheck = async (filePath: string) => {
    setQcRunning(true)
    setShowQC(true)
    setQcReport(null)
    try { setQcReport(await window.ipcRenderer.qualityCheck(filePath)) }
    catch (e) { console.error(e); setQcReport({ error: 'Quality check failed' }) }
    setQcRunning(false)
  }

  const [pxPerSec, setPxPerSec] = useState(40)
  const [timelineH, setTimelineH] = useState(300)
  const [expanded, setExpanded] = useState(false)
  const [rightTab, setRightTab] = useState<'export' | 'tags' | 'inspect'>('export')
  const [showTour, setShowTour] = useState(false)
  const [showChat, setShowChat] = useState(false)
  // the UI theme is a per-machine look, not part of a project or the shared settings file
  const [uiTheme, setUiTheme] = useState<'dark' | 'light'>(() => { try { return localStorage.getItem('vh-ui-theme') === 'light' ? 'light' : 'dark' } catch { return 'dark' } })
  const [isRecording, setIsRecording] = useState(false)

  const timelineRef = useRef<HTMLDivElement>(null)
  const [tlView, setTlView] = useState({ w: 1200, h: 300 })
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageH, setStageH] = useState(400)
  const videoEls = useRef<Map<string, HTMLVideoElement>>(new Map())
  const audioEls = useRef<Map<string, HTMLAudioElement>>(new Map())
  const recorderRef = useRef<{ rec: MediaRecorder; chunks: Blob[]; startTime: number } | null>(null)
  const draggingRef = useRef(false)
  // What a timeline drag shows while it runs: which item is moving, the snap guide (seconds, null
  // when nothing snapped) and the time readout that follows the pointer.
  const [drag, setDrag] = useState<{ id: string; snap: number | null; hud: { x: number; y: number; text: string } } | null>(null)
  // A trim handle that just hit the end of its footage glows red briefly, so the stop reads as a wall
  const [limitHit, setLimitHit] = useState<{ id: string; side: 'left' | 'right' } | null>(null)
  const limitTimer = useRef(0)
  // Where each dragged caption sat the first time it was grabbed, taken as where its speech is. Any
  // change to the clips (a cut, a trim, a move) can shift that speech, so they start over then.
  const capHeardAt = useRef(new Map<string, number>())
  useEffect(() => { capHeardAt.current.clear() }, [clips])
  // the current saveProject, for handlers registered once (keyboard, the close-window prompt)
  const saveRef = useRef<(as?: boolean) => Promise<boolean>>(async () => false)

  // Undo/redo history over the editable document (clips + texts + tag points, since cuts move tags).
  // Changes are coalesced: a snapshot is taken ~450ms after the last edit,
  // so a drag or a slider sweep collapses into a single undo step.
  const history = useRef<{ clips: TimelineClip[]; texts: TextClip[]; markers: Marker[] }[]>([{ clips: [], texts: [], markers: [] }])
  const histIndex = useRef(0)
  const skipRecord = useRef(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const [w, h] = frameDims(orientation, resolution)
  const totalDuration = (() => {
    const ends = [...clips.map(c => c.start + c.duration), ...texts.map(t => t.start + t.duration)]
    return ends.length ? Math.max(...ends) : 0
  })()

  const selClip = clips.find(c => c.id === selectedId) || null
  const selText = texts.find(t => t.id === selectedId) || null

  // A clip's <video> used to be created only once the clip was on screen, and then had to seek
  // into the middle of a long file. Until that seek decodes the element paints nothing, which is
  // the black flash you see at cuts. Mount them a beat early instead, hidden and silent, so the
  // frame is ready before it is needed.
  const PREROLL = 1.2
  // v1 first, then v2, so the DOM stacking order matches the export's overlay order: b-roll
  // covers the A-roll picture, never the other way round. Same helper as exportClips.
  const previewVideoClips = layerOrder(clips
    .filter(c => (c.trackId === 'v1' || c.trackId === 'v2') && currentTime >= c.start - PREROLL && currentTime < c.start + c.duration))
  const activeVideoClips = previewVideoClips.filter(c => currentTime >= c.start)
  const activeTexts = texts.filter(t => currentTime >= t.start && currentTime < t.start + t.duration)
  const activeKey = activeVideoClips.map(c => c.id).join(',')

  // ---- effects ----
  // Ask the main process what this machine can take. The heavy defaults (which Whisper model,
  // how many frames to decode, how many ffmpeg jobs at once) come from the answer, so a thin
  // laptop is not asked to do the accuracy-first work a workstation was tuned for.
  useEffect(() => {
    let alive = true
    void window.ipcRenderer.machineProfile().then(r => {
      if (alive && r && !('error' in r)) setMachine({ cpu: r.cpu, detected: r.detected, reasons: r.reasons, specs: r.specs })
    }).catch(() => { /* detection is a nicety: balanced defaults apply if it fails */ })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const handleProgress = (_e: any, percent: number) => {
      const pct = Math.max(0, Math.min(100, percent || 0))
      setExportProgress(pct)
      if (pct > 1 && pct < 100 && exportStartRef.current) {
        const elapsed = (Date.now() - exportStartRef.current) / 1000
        setEta((elapsed * (100 - pct)) / pct)
      } else if (pct >= 100) setEta(null)
    }
    window.ipcRenderer.on('export-progress', handleProgress)
    const handleTranscribe = (_e: any, p: { stage: string; pct: number }) => {
      setCaptioning(p.stage === 'download' ? 'Downloading model' : 'Transcribing')
      setCaptionPct(p.pct)
    }
    window.ipcRenderer.on('transcribe-progress', handleTranscribe)
    const handleProxy = (_e: unknown, d: { filePath: string; pct: number }) =>
      setMediaBin(prev => prev.map(m => m.path === d.filePath ? { ...m, proxyPct: d.pct >= 100 ? m.proxyPct : d.pct } : m))
    window.ipcRenderer.on('proxy-progress', handleProxy)
    return () => { window.ipcRenderer.off('export-progress', handleProgress); window.ipcRenderer.off('transcribe-progress', handleTranscribe); window.ipcRenderer.off('proxy-progress', handleProxy) }
  }, [])

  useEffect(() => {
    if (!stageRef.current) return
    const ro = new ResizeObserver(entries => setStageH(entries[0].contentRect.height))
    ro.observe(stageRef.current)
    return () => ro.disconnect()
  }, [])
  // The timeline's visible size: the lanes and the ruler are at least this wide, and the ruler's
  // hover line reaches its bottom. Measured, because reading clientWidth during render is a frame late.
  useEffect(() => {
    const el = timelineRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTlView(v => (v.w === el.clientWidth && v.h === el.clientHeight ? v : { w: el.clientWidth, h: el.clientHeight })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Playback clock
  useEffect(() => {
    if (!isPlaying) return
    if (totalDuration <= 0) { setIsPlaying(false); return }
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setCurrentTime(t => {
        const next = t + dt
        if (next >= totalDuration) { setIsPlaying(false); return totalDuration }
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, totalDuration])

  // Sync preview video layers
  useEffect(() => {
    const map = videoEls.current
    map.forEach((el, id) => { if (!activeVideoClips.find(c => c.id === id)) el.pause() })
    // park the not-yet-visible ones on their first frame so the decoder is warm
    previewVideoClips.filter(c => currentTime < c.start).forEach(c => {
      const el = map.get(c.id)
      if (!el) return
      el.volume = 0
      if (!el.paused) el.pause()
      if (Math.abs(el.currentTime - c.sourceStart) > 0.05) el.currentTime = c.sourceStart
    })
    activeVideoClips.forEach(c => {
      const media = mediaBin.find(m => m.id === c.mediaId)
      if (media?.type !== 'video') return
      const el = map.get(c.id)
      if (!el) return
      el.volume = clamp(gainAt(c, currentTime) * masterVolume * audioFadeFactor(c, currentTime), 0, 1)
      const target = c.sourceStart + (currentTime - c.start)
      if (isPlaying) {
        if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target
        if (el.paused) el.play().catch(() => {})
      } else {
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target
      }
    })
  }, [currentTime, isPlaying, activeKey, clips, masterVolume, mediaBin])

  // Manage hidden audio elements for audio-track clips
  useEffect(() => {
    const map = audioEls.current
    const audioClips = clips.filter(c => c.trackId === 'a1' || c.trackId === 'a2')
    audioClips.forEach(c => {
      const media = mediaBin.find(m => m.id === c.mediaId)
      if (media && !map.has(c.id)) map.set(c.id, new Audio(fileUrl(media.path)))
    })
    for (const [id, el] of map) { if (!audioClips.find(c => c.id === id)) { el.pause(); map.delete(id) } }
  }, [clips, mediaBin])

  useEffect(() => {
    const map = audioEls.current
    clips.filter(c => c.trackId === 'a1' || c.trackId === 'a2').forEach(c => {
      const el = map.get(c.id)
      if (!el) return
      const active = currentTime >= c.start && currentTime < c.start + c.duration
      el.volume = clamp(gainAt(c, currentTime) * masterVolume * audioFadeFactor(c, currentTime), 0, 1)
      if (active && isPlaying) {
        const target = c.sourceStart + (currentTime - c.start)
        if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target
        if (el.paused) el.play().catch(() => {})
      } else if (!el.paused) el.pause()
    })
  }, [currentTime, isPlaying, clips, masterVolume])

  useEffect(() => () => { audioEls.current.forEach(el => el.pause()) }, [])

  // Record history snapshots (debounced/coalesced)
  useEffect(() => {
    if (skipRecord.current) { skipRecord.current = false; return }
    const handle = setTimeout(() => {
      const snap = { clips, texts, markers }
      const top = history.current[histIndex.current]
      if (JSON.stringify(top) === JSON.stringify(snap)) return
      history.current = history.current.slice(0, histIndex.current + 1)
      history.current.push(snap)
      if (history.current.length > 100) history.current.shift()
      histIndex.current = history.current.length - 1
      setCanUndo(histIndex.current > 0)
      setCanRedo(false)
    }, 450)
    return () => clearTimeout(handle)
  }, [clips, texts, markers])

  const applyHistory = (i: number) => {
    const snap = history.current[i]
    if (!snap) return
    skipRecord.current = true
    setClips(snap.clips)
    setTexts(snap.texts)
    setMarkers(snap.markers || [])
    setSelectedId(null)
    histIndex.current = i
    setCanUndo(i > 0)
    setCanRedo(i < history.current.length - 1)
  }
  const undo = () => { if (histIndex.current > 0) applyHistory(histIndex.current - 1) }
  const redo = () => { if (histIndex.current < history.current.length - 1) applyHistory(histIndex.current + 1) }

  // Keyboard shortcuts (ignored while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+S saves (Ctrl+Shift+S asks where), from anywhere, including while typing in a field
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveRef.current(e.shiftKey); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return
      if (e.code === 'Space') { e.preventDefault(); if (totalDuration > 0) setIsPlaying(p => !p) }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedId) { e.preventDefault(); deleteSelected() } }
      else if (e.key.toLowerCase() === 's') { if (selClip) { e.preventDefault(); splitAtPlayhead() } }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setCurrentTime(t => Math.max(0, t - (e.shiftKey ? 1 : 1 / 30))) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setCurrentTime(t => Math.min(totalDuration, t + (e.shiftKey ? 1 : 1 / 30))) }
      else if (e.key === 'Home') { e.preventDefault(); setCurrentTime(0) }
      else if (e.key.toLowerCase() === 'm') { e.preventDefault(); setMarkers(m => [...m, newMarker(currentTime)]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [totalDuration, selectedId, selClip, currentTime])

  // Load persistent settings (brand kit, intro defaults, audio) once
  useEffect(() => {
    window.ipcRenderer.getSettings().then((s: AppSettings) => {
      if (s) setSettings({ ...DEFAULT_SETTINGS, ...s, brand: { ...DEFAULT_SETTINGS.brand, ...s.brand }, intro: { ...DEFAULT_SETTINGS.intro, ...s.intro }, audio: { ...DEFAULT_SETTINGS.audio, ...s.audio }, workspace: { ...DEFAULT_SETTINGS.workspace, ...s.workspace }, recipe: { ...DEFAULT_SETTINGS.recipe, ...s.recipe } })
      settingsLoaded.current = true
    }).catch(() => { settingsLoaded.current = true })
  }, [])

  // Persist settings whenever they change (after initial load)
  useEffect(() => {
    if (!settingsLoaded.current) return
    window.ipcRenderer.setSettings(settings).catch(() => {})
  }, [settings])

  // Releasing the mouse anywhere ends a header window-drag (main ignores strays)
  useEffect(() => {
    const end = () => window.ipcRenderer.windowDragEnd?.()
    window.addEventListener('mouseup', end)
    window.addEventListener('blur', end)
    return () => { window.removeEventListener('mouseup', end); window.removeEventListener('blur', end) }
  }, [])

  // Theme lives on <html> so modals and popovers outside the app tree pick it up too; the
  // native window buttons are painted by Electron, so they are told the header colours.
  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme
    try { localStorage.setItem('vh-ui-theme', uiTheme) } catch { /* private storage */ }
    window.ipcRenderer.setWindowTheme?.(uiTheme)
  }, [uiTheme])
  // the first time VidHelm opens, the tour runs by itself (once the window has laid out)
  useEffect(() => {
    if (tourSeen() || (window as unknown as { __vhWeb?: boolean }).__vhWeb) return
    const t = setTimeout(() => setShowTour(true), 600)
    return () => clearTimeout(t)
  }, [])
  // picking something on the timeline brings its controls up
  useEffect(() => { if (selectedId) setRightTab('inspect') }, [selectedId])

  // Dismiss the links popover on any click elsewhere (its own clicks stop propagation)
  useEffect(() => {
    if (!showLinks) return
    const close = () => setShowLinks(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [showLinks])

  // Close the right-click context menu on any outside click
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [ctxMenu])

  // Generate timeline filmstrip thumbnails for video clips (debounced; regenerates when trimmed)
  useEffect(() => { thumbsRef.current = thumbs }, [thumbs])
  useEffect(() => {
    const vids = clips.filter(c => (c.trackId === 'v1' || c.trackId === 'v2') && mediaBin.find(m => m.id === c.mediaId)?.type === 'video')
    if (!vids.length) return
    const handle = setTimeout(() => {
      // One ffmpeg per clip, all at once, means ninety processes the moment a long video is cut.
      // That pegs the machine, starves the app's own event loop and stalls anything else running
      // (an export, for one). A couple at a time fills the strip in just as fast in practice,
      // and how many is a couple depends on the machine (see electron/capability.ts).
      const queue = [...vids]
      let active = 0
      const pump = () => {
        while (active < perf.thumbnailWorkers && queue.length) {
          const c = queue.shift()!
          active++
          void makeStrip(c).finally(() => { active--; pump() })
        }
      }
      const makeStrip = async (c: TimelineClip) => {
        const media = mediaBin.find(m => m.id === c.mediaId)
        if (!media || media.offline) return
        // While a proxy is building, pulling frames from the 4K HEVC original would queue a dozen
        // slow ffmpeg jobs behind it. Wait: the strip regenerates from the proxy once it lands.
        if (media.proxyPct !== undefined) return
        // The strip is stretched across the clip, so the frame count decides each frame's shape.
        // Ask for as many 16:9 frames as fit the clip's row height (b-roll is shorter), and keep a
        // strip through a zoom step until stretching it would visibly distort it (stripFits).
        const widthPx = c.duration * pxPerSec
        const tileH = STRIP_TILE_H[c.trackId] ?? STRIP_TILE_H.v1
        const sig = `${Math.round(c.sourceStart * 2)}:${Math.round(c.duration * 2)}:${media.proxyPath ? 'p' : 'o'}`
        const have = thumbsRef.current[c.id]
        if (have?.sig === sig && stripFits(have.n, widthPx, tileH)) return
        const n = stripTiles(widthPx, tileH)
        // the proxy is small and h264: far quicker to pull frames from than a 4K HEVC original
        const r = await window.ipcRenderer.makeThumbnails({ filePath: media.proxyPath || media.path, sourceStart: c.sourceStart, duration: c.duration, count: n })
        const p = r?.path
        if (p) setThumbs(prev => ({ ...prev, [c.id]: { sig, n, path: p } }))
      }
      pump()
    }, 400)
    return () => clearTimeout(handle)
  }, [clips, mediaBin, pxPerSec, perf.thumbnailWorkers])

  // ---- media import ----
  const importFiles = useCallback(async (files: File[]): Promise<MediaFile[]> => {
    const added: MediaFile[] = []
    const probes = new Map<string, Probe>()
    const skipped: string[] = []
    for (const file of files) {
      const ext = extOf(file.name)
      try {
        const path = window.ipcRenderer.getPathForFile(file)

        // 3D models open in the studio instead of landing on the timeline
        if (MODEL_EXT.has(ext)) { setModel3DPath(path); setShowModel3D(true); continue }
        if (PAGE_EXT.has(ext)) {
          const r = await window.ipcRenderer.extractModel(path)
          if (r.path) { setModel3DPath(r.path); setShowModel3D(true); notify(`Found a 3D model in ${file.name} (${r.how}), opening the 3D Studio.`) }
          else skipped.push(`${file.name} - ${r.error || 'no 3D model inside that page'}`)
          continue
        }

        // ffprobe decides: it reads far more formats than any extension list knows about
        const meta = await window.ipcRenderer.getMetadata(path).catch(() => null)
        const verdict = classifyMedia(file.name, meta)
        if ('reject' in verdict) { skipped.push(`${file.name} - ${verdict.reject}`); continue }
        const m = meta as Probe   // a non-reject verdict means the probe succeeded
        const entry = mediaFromProbe(file.name, path, verdict.type, m)
        probes.set(entry.id, m)
        added.push(entry)
      } catch (err) {
        console.error(err)
        skipped.push(`${file.name} - ${WRONG_TYPE[ext] || 'could not be imported'}`)
      }
    }
    if (added.length) { setMediaBin(prev => [...prev, ...added]); void ensureProxies(added, probes) }
    if (skipped.length) notify(`Skipped ${skipped.length} file${skipped.length > 1 ? 's' : ''}:\n\n${skipped.slice(0, 5).map(s => '• ' + s).join('\n')}${skipped.length > 5 ? `\n• …and ${skipped.length - 5} more` : ''}`, 11000)
    return added
  }, [])

  // Footage the preview cannot decode (phone HEVC, 10-bit, HDR, very large frames) gets a
  // watchable stand-in built in the background. The original stays the master: an export reads the
  // copy only when it is as big and as smooth as the export (exportSource), so the copy's real size
  // and frame rate are kept with it. Cached in userData, so it happens once per file.
  const ensureProxies = useCallback(async (items: MediaFile[], probes: Map<string, Probe>) => {
    for (const m of items) {
      if (m.type !== 'video') continue
      const info = probes.get(m.id)
      if (!info) continue
      const plan = planProxy({ ...info, hasVideo: true })
      if (!plan.needed) continue
      setMediaBin(prev => prev.map(x => x.id === m.id ? { ...x, proxyPct: 0, proxyNote: plan.reason } : x))
      const r = await window.ipcRenderer.makeProxy({ filePath: m.path, info: { ...info, hasVideo: true }, maxWidth: perf.proxyMaxWidth, maxFps: perf.proxyMaxFps })
      if (r.path) {
        // width/height/fps arrive from newer main processes; without them the copy is preview-only
        const dims = r as { width?: number; height?: number; fps?: number }
        const num = (v: unknown) => typeof v === 'number' && v > 0 ? v : undefined
        setMediaBin(prev => prev.map(x => x.id === m.id ? { ...x, proxyPath: r.path, proxyWidth: num(dims.width), proxyHeight: num(dims.height), proxyFps: num(dims.fps), proxyPct: undefined } : x))
        if (!r.cached) notify(`${m.name}: ${plan.reason}, so VidHelm made a preview copy to edit with. High quality exports read the original; Standard ones use the copy only when it already matches the export's size and frame rate.`, 9000)
      } else {
        setMediaBin(prev => prev.map(x => x.id === m.id ? { ...x, proxyPath: undefined, proxyWidth: undefined, proxyHeight: undefined, proxyFps: undefined, proxyPct: undefined, proxyNote: 'preview unavailable' } : x))
        notify(`${m.name}: ${plan.reason}, and the preview copy could not be made (${r.error || 'unknown error'}). Editing still works, the preview will stay blank.`, 11000)
      }
    }
  }, [perf.proxyMaxWidth, perf.proxyMaxFps])

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) await importFiles(Array.from(e.target.files))
    e.target.value = ''
  }

  /** Which track a piece of media may go on: picture lives on video or b-roll, sound on voice/music or SFX. */
  const trackFor = (media: MediaFile, want?: TimelineClip['trackId']): TimelineClip['trackId'] => {
    const isAudio = media.type === 'audio'
    if (want && (isAudio ? want === 'a1' || want === 'a2' : want === 'v1' || want === 'v2')) return want
    return isAudio ? 'a1' : 'v1'
  }
  const placeOnTimeline = (media: MediaFile, at: number, track?: TimelineClip['trackId']) => {
    const trackId = trackFor(media, track)
    setClips(prev => [...prev, {
      id: rid(), mediaId: media.id, type: media.type,
      trackId,
      start: Math.max(0, at), duration: media.duration, sourceStart: 0,
      // b-roll is picture only (its sound is never mixed); a couple of frames of dissolve each end
      // keep a hard picture-only cut from strobing, as place_broll does
      volume: 1.0, fadeIn: trackId === 'v2' ? Math.min(0.12, media.duration / 6) : 0, fadeOut: trackId === 'v2' ? Math.min(0.12, media.duration / 6) : 0,
    }])
  }

  const addToTimeline = (media: MediaFile) => {
    const isAudio = media.type === 'audio'
    const track = clips.filter(c => c.trackId === (isAudio ? 'a1' : 'v1'))
    const at = isAudio ? currentTime : (track.length ? Math.max(...track.map(c => c.start + c.duration)) : 0)
    placeOnTimeline(media, at)
  }

  // Add a media item as an intro at the very front, using the configured intro defaults.
  const addAsIntro = (media: MediaFile) => {
    const { segment, seconds, fade, treatment } = settings.intro
    const dur = Math.min(Math.max(0.5, seconds), media.type === 'image' ? seconds : media.duration)
    const sourceStart = segment === 'last' && media.type !== 'image' ? Math.max(0, media.duration - dur) : 0
    const isAudio = media.type === 'audio'
    const intro: TimelineClip = {
      id: rid(), mediaId: media.id, type: media.type, trackId: isAudio ? 'a1' : 'v1',
      start: 0, duration: dur, sourceStart, volume: 1, fadeIn: fade, fadeOut: fade,
    }
    if (treatment === 'ripple') {
      setClips(prev => [intro, ...prev.map(c => ({ ...c, start: c.start + dur }))])
      setTexts(prev => prev.map(t => ({ ...t, start: t.start + dur })))
      setMarkers(prev => prev.map(m => ({ ...m, t: m.t + dur })))   // tags stay on their beats
    } else {
      setClips(prev => [intro, ...prev])
    }
    setSelectedId(intro.id)
    setCurrentTime(0)
  }

  // ---- SFX / booth / narration ----
  // Drop a library sound onto the SFX track at the playhead (imports it into the bin on first use)
  const placeSfx = async (item: SfxItem) => {
    let media = mediaBin.find(m => m.path === item.path)
    if (!media) {
      media = { id: rid(), name: `${item.name} ✦`, path: item.path, type: 'audio', duration: item.duration, hasVideo: false, hasAudio: true }
      setMediaBin(prev => [...prev, media!])
    }
    setClips(prev => [...prev, { id: rid(), mediaId: media!.id, type: 'audio', trackId: 'a2', start: currentTime, duration: item.duration, sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 }])
  }

  // A finished karaoke-booth take lands on the voice track at its start time
  const boothRecorded = async (path: string, startAt: number) => {
    const metadata = await window.ipcRenderer.getMetadata(path)
    const media: MediaFile = { id: rid(), name: `Take ${new Date().toLocaleTimeString()}`, path, type: 'audio', duration: metadata.duration || 1, hasVideo: false, hasAudio: true }
    setMediaBin(prev => [...prev, media])
    setClips(prev => [...prev, { id: rid(), mediaId: media.id, type: 'audio', trackId: 'a1', start: startAt, duration: media.duration, sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 }])
  }

  // Generated narration lines: pin to tag points when there are enough, otherwise lay back-to-back
  const narrationGenerated = async (files: string[], lines: string[]) => {
    const sorted = [...markers].sort((a, b) => a.t - b.t)
    const useTags = sorted.length >= files.length
    let cursor = 0
    const newMedia: MediaFile[] = []
    const newClips: TimelineClip[] = []
    for (let i = 0; i < files.length; i++) {
      const meta = await window.ipcRenderer.getMetadata(files[i])
      const media: MediaFile = { id: rid(), name: lines[i]?.slice(0, 26) || `line ${i + 1}`, path: files[i], type: 'audio', duration: meta.duration || 1, hasVideo: false, hasAudio: true }
      const start = useTags ? sorted[i].t : cursor
      cursor = start + media.duration
      newMedia.push(media)
      newClips.push({ id: rid(), mediaId: media.id, type: 'audio', trackId: 'a1', start, duration: media.duration, sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 })
    }
    setMediaBin(prev => [...prev, ...newMedia])
    setClips(prev => [...prev, ...newClips])
    setShowNarration(false)
  }

  // ---- start recipe ----
  /** images in the bin that look like the creator's own thumbnail photo */
  const thumbPhotos = () => mediaBin.filter(m => m.type === 'image' && looksLikeThumbPhoto(m.name)).map(m => m.path)
  /** thumbnails follow the caption theme; classic captions fall back to the channel look */
  const thumbTheme = () => settings.caption.theme === 'classic' ? 'randotechnerd' : themeRequest(settings.caption)
  const firstVideo = () => {
    const c = clips.filter(x => x.trackId === 'v1').sort((a, b) => a.start - b.start)
      .map(x => mediaBin.find(m => m.id === x.mediaId)).find(m => m?.type === 'video')
    return c || mediaBin.find(m => m.type === 'video') || null
  }

  // Place the configured intro audio at 0:00 on the voice track (skips if it's already there)
  const applyIntroAudio = async (): Promise<string> => {
    const p = settings.recipe.introAudioPath
    if (!p) return 'intro-audio: no file chosen (Settings → Start Recipe)'
    let media = mediaBin.find(m => m.path === p)
    if (!media) {
      const meta = await window.ipcRenderer.getMetadata(p).catch(() => null)
      if (!meta) return 'intro-audio: file unreadable'
      media = { id: rid(), name: p.split(/[\\/]/).pop() || 'intro', path: p, type: 'audio', duration: meta.duration || 2, hasVideo: false, hasAudio: true }
      setMediaBin(prev => [...prev, media!])
    }
    if (clips.some(c => c.mediaId === media!.id && c.start < 0.01)) return 'intro-audio: already placed'
    setClips(prev => [...prev, { id: rid(), mediaId: media!.id, type: 'audio', trackId: 'a1', start: 0, duration: media!.duration, sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0.2 }])
    return `intro-audio: placed ${media.name} at 0:00`
  }

  // Run the app-native steps of the start recipe; AI-facing lines are reported for the agent/chat
  const runRecipe = async () => {
    if (totalDuration <= 0 && !mediaBin.some(m => m.type === 'video')) {
      notify('🚀 Start Recipe needs footage first, drag a video into the Media Bin (or ask your AI to load one), then hit Recipe again.', 9000)
      return
    }
    const active = recipeActive(settings.recipe.text)
    const notes: string[] = []
    if (active['cut-pauses']) {
      if (totalDuration > 0) { const r = await runCutDeadSpace(); notes.push(r.error ? `cut-pauses: ${r.error}` : `cut-pauses: removed ${r.removed} (${r.seconds}s)`) }
      else notes.push('cut-pauses: timeline empty')
    }
    if (active['intro-audio']) notes.push(await applyIntroAudio())
    if (active['logo']) {
      if (settings.brand.logoPath) { setSettings(s => ({ ...s, brand: { ...s.brand, enabled: true } })); notes.push('logo: watermark enabled') }
      else notes.push('logo: none set (Settings → Brand Kit)')
    }
    const aiSteps = ['titles', 'subtitle', 'captions'].filter(k => active[k])
    if (aiSteps.length) notes.push(`for your AI (or do manually): ${aiSteps.join(', ')}`)
    if (active['thumbnail']) { if (firstVideo()) { setShowThumbnail(true); notes.push('thumbnail: picker opened') } else notes.push('thumbnail: skipped (no video)') }
    notify('Start Recipe:\n\n' + notes.map(n => '• ' + n).join('\n'))
  }

  // ---- agent bridge executor ----
  // Commands arrive from electron/main.ts (HTTP bridge -> 'agent-command'), run against live state,
  // and reply on 'agent-response'. The ref keeps the handler closure fresh across renders.
  const agentExec = useRef<(cmd: any) => Promise<any>>(async () => ({}))
  agentExec.current = async (cmd: any) => {
    const findMedia = (ref: string) => mediaBin.find(m => m.id === ref) || mediaBin.find(m => m.name.toLowerCase().includes(String(ref).toLowerCase()))
    // Word anchors. Any time-taking command may say at:"<spoken words>" (or
    // at:"end:<spoken words>") instead of a number, and the time is read off
    // the transcript: text, SFX, tags and cuts land on the moment a word is
    // said rather than on a number somebody estimated.
    if (typeof cmd.at === 'string' && cmd.at.trim()) {
      const m = cmd.at.match(/^(start|end)\s*:\s*(.+)$/i)
      const edge = m ? m[1].toLowerCase() : 'start', phrase = (m ? m[2] : cmd.at).trim()
      const sp = await readSpeech(cmd.model)
      if (sp.error || !sp.words) return { error: sp.error || 'no speech to anchor on' }
      const hit = spanForPhrase(sp.words, phrase, { after: cmd.after, before: cmd.before })
      if (!hit) return { error: `could not find "${phrase}" in the speech (try find_word to see what was heard)` }
      const t = +(edge === 'end' ? hit.end : hit.start).toFixed(3)
      if (['add_text', 'update_text', 'add_clip', 'update_clip'].includes(cmd.action)) cmd.start = t
      else cmd.t = t
      cmd.anchored = { at: cmd.at, t, heard: hit.text }
    }
    switch (cmd.action) {
      case 'get_state':
        return {
          format: { orientation, resolution, fps, width: w, height: h },
          duration: totalDuration, currentTime, isPlaying,
          mediaBin: mediaBin.map(m => ({ id: m.id, name: m.name, type: m.type, duration: m.duration, path: m.path, chromaKey: m.chromaKey, ...(m.offline ? { offline: true } : {}) })),
          unsaved: isDirty(), project: currentProject?.name || (saveFile ? baseName(saveFile) : null),
          clips: clips.map(c => ({ id: c.id, track: c.trackId, media: mediaBin.find(m => m.id === c.mediaId)?.name, start: +c.start.toFixed(3), duration: +c.duration.toFixed(3), sourceStart: +c.sourceStart.toFixed(3), volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, automationPoints: c.volumePoints?.length || 0 })),
          texts: texts.map(t => ({ id: t.id, text: t.text, start: +t.start.toFixed(3), duration: +t.duration.toFixed(3), x: t.x, y: t.y, fontSize: t.fontSize, color: t.color, ...(t.font ? { font: t.font } : {}), ...(t.caption ? { caption: chooseTheme(t.caption.theme).theme.id } : {}) })),
          theme: (() => { const cs = settings.caption; if (cs.theme === 'classic') return { id: 'classic', note: 'Plain manual captions. set_theme to switch to a theme.' }; const c = chooseTheme(themeRequest(cs)); return { request: themeRequest(cs), id: c.theme.id, name: c.theme.name, feel: { transitions: c.theme.transition, music: c.theme.music, sfx: c.theme.sfx } } })(),
          tags: [...markers].sort((a, b) => a.t - b.t).map(m => ({ id: m.id, t: +m.t.toFixed(3), label: m.label })),
          startRecipe: { instructions: settings.recipe.text, active: Object.entries(recipeActive(settings.recipe.text)).filter(([, v]) => v).map(([k]) => k), introAudioPath: settings.recipe.introAudioPath, note: "The user's standing workflow (like start G-code). # lines are OFF. Lines like 'titles 5' are for YOU to do in chat." },
          // so you can see what the heavy jobs will default to before you ask for them
          machine: {
            tier: perf.tier,
            chose: settings.performance?.preference === 'auto' || !settings.performance?.preference ? 'detected' : 'set by the user',
            cpu: machine?.cpu,
            summary: describeProfile(perf, machine?.detected, settings.performance?.preference),
            speechModel: perf.speechModel, framingFps: perf.framingFps,
            note: perf.tier === 'low'
              ? 'This machine is on the lighter defaults. Speech is read with the quick model, so double-check anything that hangs on an exact word. The user can raise it in Settings.'
              : undefined,
          },
        }
      case 'generate_clip': {
        if (!settings.aiGen?.falKey && !settings.aiGen?.geminiKey) return { error: 'no AI video key yet: ask the human to add a fal.ai key in the ✨ AI clip panel (fal.ai → Keys)' }
        const resolve = (ref?: string) => { if (!ref) return undefined; const m = findMedia(ref); return m ? m.path : ref }
        let fromPath = resolve(cmd.from), fromTime = typeof cmd.at === 'number' ? cmd.at : undefined
        if (cmd.from === 'playhead') { const f = frameUnderPlayhead(); if (!f) return { error: 'nothing under the playhead' }; fromPath = f.path; fromTime = f.time }
        if (!cmd.prompt && !fromPath) return { error: 'prompt or from required' }
        const r = await generateAiClip({ prompt: cmd.prompt || 'bring this picture to life, subtle realistic motion', fromPath, fromTime, toPath: resolve(cmd.to), seconds: cmd.seconds, model: cmd.model, place: cmd.place })
        if ('error' in r) return r
        return { ...r, note: 'In the Media Bin' + (cmd.place === false ? '' : ' and at the end of v1') + '. A transition (from + to) morphs the first picture into the second.' }
      }
      case 'add_media': {
        const ext = extOf(cmd.path || '')
        // 3D models (and HTML pages carrying one) open in the studio rather than the timeline
        if (MODEL_EXT.has(ext) || PAGE_EXT.has(ext)) {
          let p: string = cmd.path
          if (PAGE_EXT.has(ext)) {
            const r = await window.ipcRenderer.extractModel(cmd.path)
            if (!r.path) return { error: r.error || 'no 3D model found inside that page' }
            p = r.path
          }
          setModel3DPath(p); setShowModel3D(true)
          return { ok: true, opened: '3D Studio', path: p, note: 'the human poses it there and renders a turntable clip into the bin' }
        }
        const meta = await window.ipcRenderer.getMetadata(cmd.path).catch(() => null)
        const verdict = classifyMedia(cmd.path, meta)
        if ('reject' in verdict) return { error: `cannot use ${cmd.path}: ${verdict.reject}` }
        const type: MediaFile['type'] = verdict.type
        const m = meta as Probe   // a non-reject verdict means the probe succeeded
        const media = mediaFromProbe(baseName(cmd.path) || 'media', cmd.path, type, m, {
          ...(type === 'image' ? { duration: cmd.duration || 5 } : {}),
          chromaKey: typeof cmd.chromaKey === 'string' ? cmd.chromaKey : undefined,
        })
        setMediaBin(prev => [...prev, media])
        void ensureProxies([media], new Map([[media.id, m]]))
        if (cmd.place !== false) {
          const isAudio = media.type === 'audio'
          const track = clips.filter(c => c.trackId === (isAudio ? 'a1' : 'v1'))
          const at = typeof cmd.start === 'number' ? cmd.start : (track.length ? Math.max(...track.map(c => c.start + c.duration)) : 0)
          setClips(prev => [...prev, { id: rid(), mediaId: media.id, type: media.type, trackId: isAudio ? 'a1' : 'v1', start: at, duration: media.duration, sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 }])
        }
        return { ok: true, mediaId: media.id, name: media.name, type: media.type, duration: media.duration }
      }
      case 'add_clip': {
        const media = findMedia(cmd.media)
        if (!media) return { error: `media not found: ${cmd.media}` }
        if (cmd.track && !['v1', 'v2', 'a1', 'a2'].includes(cmd.track)) return { error: `track must be v1 (video), v2 (b-roll), a1 (voice/music) or a2 (sfx), not "${cmd.track}"` }
        const trackId = trackFor(media, cmd.track)
        if (cmd.track && trackId !== cmd.track) return { error: `${media.name} is ${media.type === 'audio' ? 'sound, so it goes on a1 or a2' : 'a picture, so it goes on v1 or v2'}` }
        // without a duration it runs to the end of the file from its in-point, not a whole file's length past it
        const len = footageLength(media), from = Math.max(0, Number(cmd.sourceStart) || 0)
        if (len !== undefined && from >= len) return { error: `sourceStart ${from} is past the end of ${media.name} (${len.toFixed(3)} s)` }
        const dur = cmd.duration ?? (len !== undefined ? len - from : media.duration)
        if (len !== undefined && from + dur > len + 1e-3) return { error: `${media.name} is ${len.toFixed(3)} s long: from sourceStart ${from} the clip can last at most ${(len - from).toFixed(3)} s` }
        const clip: TimelineClip = { id: rid(), mediaId: media.id, type: media.type, trackId, start: cmd.start ?? 0, duration: dur, sourceStart: from, volume: cmd.volume ?? 1, fadeIn: cmd.fadeIn ?? 0, fadeOut: cmd.fadeOut ?? 0 }
        setClips(prev => [...prev, clip])
        return { ok: true, clipId: clip.id, track: trackId }
      }
      case 'update_clip': {
        if (!clips.find(c => c.id === cmd.clipId)) return { error: `clip not found: ${cmd.clipId}` }
        if (cmd.trackId !== undefined && !['v1', 'v2', 'a1', 'a2'].includes(cmd.trackId)) return { error: `trackId must be v1, v2, a1 or a2, not "${cmd.trackId}"` }
        const patch: Partial<TimelineClip> = {}
        for (const k of ['start', 'duration', 'sourceStart', 'volume', 'fadeIn', 'fadeOut', 'trackId'] as const) if (cmd[k] !== undefined) (patch as any)[k] = cmd[k]
        // A trim past the footage froze the preview and rendered black in the export: refused with the
        // numbers that would fit, rather than quietly changed into something the agent did not ask for
        if (patch.duration !== undefined || patch.sourceStart !== undefined) {
          const c0 = clips.find(c => c.id === cmd.clipId)!
          const media = mediaBin.find(m => m.id === c0.mediaId)
          const next = { ...c0, ...patch }
          const len = footageLength(media)
          if (!(Number(next.sourceStart) >= 0)) return { error: `sourceStart must be 0 or more (got ${next.sourceStart})` }
          if (len !== undefined && next.sourceStart + next.duration > len + 1e-3) {
            return { error: `${media!.name} is ${len.toFixed(3)} s long: from sourceStart ${(+next.sourceStart).toFixed(3)} the clip can last at most ${maxDurationFrom(next.sourceStart, len).toFixed(3)} s (asked for ${(+next.duration).toFixed(3)})` }
          }
        }
        setClips(prev => prev.map(c => c.id === cmd.clipId ? { ...c, ...patch } : c))
        return { ok: true }
      }
      case 'delete_item':
        setClips(c => c.filter(x => x.id !== cmd.id))
        setTexts(t => t.filter(x => x.id !== cmd.id))
        setMarkers(m => m.filter(x => x.id !== cmd.id))
        return { ok: true }
      case 'split_clip': {
        const c0 = clips.find(c => c.id === cmd.clipId)
        if (!c0) return { error: `clip not found: ${cmd.clipId}` }
        const t = cmd.t
        if (t <= c0.start || t >= c0.start + c0.duration) return { error: `t=${t} outside clip [${c0.start}, ${c0.start + c0.duration}]` }
        const off = t - c0.start
        // hard cut on the picture, but ramp the waveform or the join clicks
        const a = { ...c0, id: rid(), duration: off, fadeOut: 0, aFadeOut: DEPOP }
        const b = { ...c0, id: rid(), start: t, duration: c0.duration - off, sourceStart: c0.sourceStart + off, fadeIn: 0, aFadeIn: DEPOP }
        setClips(prev => { const i = prev.findIndex(c => c.id === c0.id); const n = [...prev]; n.splice(i, 1, a, b); return n })
        return { ok: true, left: a.id, right: b.id }
      }
      case 'set_theme': {
        // "make it fun" / "futuristic tech captions but green": a baseline look plus the tweak
        const req = String(cmd.theme ?? cmd.request ?? '').trim()
        if (!req) return { current: themeRequest(settings.caption), themes: THEMES.map(t => ({ id: t.id, name: t.name, blurb: t.blurb })) }
        const choice = chooseTheme(req)
        setSettings(s => ({ ...s, caption: { ...s.caption, theme: req === 'classic' ? 'classic' : req, tweak: '' } }))
        const changed = req === 'classic' || cmd.restyle === false ? { captions: 0, titles: 0 } : restyleCaptions(req, cmd.titles !== false)
        return { ok: true, theme: choice.theme.id, name: choice.theme.name, blurb: choice.theme.blurb, tweaks: choice.tweaks, restyled: changed,
          feel: { transitions: choice.theme.transition, music: choice.theme.music, sfx: choice.theme.sfx },
          note: choice.fallback ? `Nothing in "${req}" matched a theme, so this is the Bold creator default with any tweaks applied. Themes: ${THEMES.map(t => t.id).join(', ')}.` : 'New captions, titles (add_text presets) and thumbnails use this look. Lean your music/sfx/transition choices toward "feel".' }
      }
      case 'make_captions': {
        const req = cmd.theme ? String(cmd.theme) : undefined
        // one run at a time: a retry while the first is still transcribing would land both sets
        if (busyRef.current.captions) return { error: 'Captions are already being made. Wait for that run to finish (get_state shows them once they land) rather than starting another.' }
        if (req) setSettings(s => ({ ...s, caption: { ...s.caption, theme: req, tweak: '' } }))
        // the old captions go in the same update that adds the new ones (generateCaptions), so a
        // run that lands late can never stack its captions on top of another run's
        const made = await generateCaptions(req, { replace: cmd.replace !== false })
        const choice = chooseTheme(req || themeRequest(settings.caption))
        return made ? { ok: true, captions: made, theme: (req || settings.caption.theme) === 'classic' ? 'classic' : choice.theme.id } : { error: 'No captions made (no speech, or no audio on the timeline).' }
      }
      case 'add_text': {
        // design rules as code: a preset supplies the lane a title / lower third /
        // caption / end card lives in, and the size always shrinks to fit the frame
        const body = cmd.text || 'text'
        const pre = presetFor(cmd.preset, body, w, h)
        const fontSize = cmd.fontSize ?? pre.fontSize ?? fitFontSize(body, 64, 0.9, w, h)
        const t: TextClip = { id: rid(), text: body, start: cmd.start ?? currentTime, duration: cmd.duration ?? pre.duration ?? 3, x: cmd.x ?? pre.x ?? 0.5, y: cmd.y ?? pre.y ?? 0.5, fontSize, color: cmd.color || pre.color || '#ffffff', fadeIn: cmd.fadeIn ?? pre.fadeIn ?? 0.3, fadeOut: cmd.fadeOut ?? pre.fadeOut ?? 0.3, box: cmd.box ?? pre.box, boxOpacity: cmd.boxOpacity ?? pre.boxOpacity }
        // titles wear the active theme (fonts, colours, outline, box) unless told otherwise
        const themedTitle = cmd.theme !== false && settings.caption.theme !== 'classic' && (cmd.theme || (cmd.preset && cmd.preset !== 'caption'))
        if (themedTitle && !cmd.font) {
          const ti = chooseTheme(typeof cmd.theme === 'string' ? cmd.theme : themeRequest(settings.caption)).title
          t.font = ti.font; t.outline = ti.box ? 0 : ti.outline; t.outlineColor = ti.outlineColor
          if (!cmd.color) t.color = ti.color
          if (cmd.box === undefined) { t.box = ti.box; if (ti.box) { t.boxColor = ti.boxColor; t.boxOpacity = ti.boxOpacity } }
          if (ti.uppercase) t.text = t.text.toUpperCase()
        }
        if (cmd.font && THEME_FONTS[cmd.font as ThemeFont]) t.font = cmd.font
        setTexts(prev => [...prev, t])
        const rep = layoutReport([...texts, t], w, h)
        const mine = rep.notes.filter(n => n.includes(`"${t.id}"`))
        return { ok: true, textId: t.id, fontSize, start: t.start, ...(cmd.anchored ? { anchored: cmd.anchored } : {}), ...(mine.length ? { warnings: mine } : {}) }
      }
      case 'find_word': {
        if (!cmd.text) return { error: 'text required' }
        const sp = await readSpeech(cmd.model)
        if (sp.error || !sp.words) return { error: sp.error || 'no speech' }
        const q = wordsOf(cmd.text)
        const anchors: { start: number; end: number; text: string }[] = []
        for (let i = 0; q.length && i + q.length <= sp.words.length; i++) {
          const win = sp.words.slice(i, i + q.length)
          if (win.every((x, k) => (wordsOf(x.text)[0] || '') === q[k])) {
            anchors.push({ start: +win[0].start.toFixed(3), end: +win[win.length - 1].end.toFixed(3), text: win.map(x => x.text.trim()).join(' ') })
          }
        }
        if (!anchors.length) {
          const fuzzy = spanForPhrase(sp.words, cmd.text, { after: cmd.after, before: cmd.before })
          if (fuzzy) anchors.push({ start: +fuzzy.start.toFixed(3), end: +fuzzy.end.toFixed(3), text: fuzzy.text })
        }
        if (!anchors.length) return { error: `"${cmd.text}" was not heard` }
        return { ok: true, count: anchors.length, anchors, note: 'Place things on a word instead of a number: pass at:"<words>" (or at:"end:<words>") to add_text, add_tag, place_sfx, split_clip, add_clip or transport. after/before pick between repeats.' }
      }
      case 'snap_to_grid': {
        const vis = clips.filter(c => c.trackId === 'v1' || c.trackId === 'v2')
        if (!vis.length && !markers.length) return { error: 'nothing on the picture tracks or no tags to snap' }
        const boundaries = [...new Set(vis.flatMap(c => [+c.start.toFixed(3), +(c.start + c.duration).toFixed(3)]))]
        const bpm = cmd.bpm || fitBpm(boundaries).bpm
        const gridClips = clips.map(c => ({ id: c.id, trackId: c.trackId, start: c.start, duration: c.duration, sourceStart: c.sourceStart, sourceDuration: mediaBin.find(m => m.id === c.mediaId)?.duration }))
        const r = snapToGrid(gridClips, markers.map(m => ({ id: m.id, t: m.t })), {
          bpm, phase: cmd.phase, cutDivision: cmd.cutDivision, tagDivision: cmd.tagDivision,
          tolerance: cmd.tolerance, tagTolerance: cmd.tagTolerance, snapCuts: cmd.snapCuts, snapTags: cmd.snapTags,
        })
        const report = { bpm: r.bpm, phase: r.phase, cutStep: r.cutStep, tagStep: r.tagStep, moves: r.moves, skipped: r.skipped, summary: describeSnap(r) }
        if (cmd.dryRun) return { ok: true, dryRun: true, ...report, note: 'Nothing moved; drop dryRun to apply.' }
        setClips(prev => prev.map(c => { const g = r.clips.find(x => x.id === c.id); return g ? { ...c, start: g.start, duration: g.duration, sourceStart: g.sourceStart } : c }))
        setMarkers(prev => prev.map(m => { const g = r.markers.find(x => x.id === m.id); return g ? { ...m, t: g.t } : m }))
        return { ok: true, ...report, note: 'Joins were ROLLED onto the grid (the cut moved, nothing downstream shifted, runtime unchanged) and tags slid onto bar lines. Call make_score with this bpm and every hit lands exactly.' }
      }
      case 'capture_site': {
        if (!cmd.url) return { error: 'url required' }
        const r = await window.ipcRenderer.captureSite({ url: cmd.url, width: cmd.width, height: cmd.height, theme: cmd.theme, script: cmd.script, settle: cmd.settle, seconds: cmd.seconds, fps: cmd.fps, outPath: cmd.outPath })
        if (r.error || !r.path) return r
        if (cmd.place === false) return { ok: true, kind: r.kind, path: r.path, width: r.width, height: r.height, seconds: r.seconds }
        const isVideo = r.kind === 'video'
        let host = cmd.url
        try { host = new URL(cmd.url).hostname || cmd.url } catch {}
        const media: MediaFile = { id: rid(), name: `${host} ${isVideo ? 'capture' : 'shot'}`, path: r.path, type: isVideo ? 'video' : 'image', duration: isVideo ? (r.seconds || 5) : (cmd.duration || 5), hasVideo: true, hasAudio: false }
        setMediaBin(prev => [...prev, media])
        const track = clips.filter(c => c.trackId === 'v1')
        const at = typeof cmd.start === 'number' ? cmd.start : (track.length ? Math.max(...track.map(c => c.start + c.duration)) : 0)
        const clip: TimelineClip = { id: rid(), mediaId: media.id, type: media.type, trackId: 'v1', start: at, duration: media.duration, sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 }
        setClips(prev => [...prev, clip])
        return { ok: true, kind: r.kind, path: r.path, mediaId: media.id, clipId: clip.id, start: at, duration: media.duration }
      }
      case 'update_text': {
        if (!texts.find(t => t.id === cmd.textId)) return { error: `text not found: ${cmd.textId}` }
        const patch: Partial<TextClip> = {}
        for (const k of ['text', 'start', 'duration', 'x', 'y', 'fontSize', 'color', 'fadeIn', 'fadeOut', 'box', 'boxOpacity', 'boxColor', 'font', 'outline', 'outlineColor'] as const) if (cmd[k] !== undefined) (patch as any)[k] = cmd[k]
        setTexts(prev => prev.map(t => t.id === cmd.textId ? { ...t, ...patch } : t))
        return { ok: true }
      }
      case 'add_tag': {
        const m = newMarker(cmd.t ?? currentTime, cmd.label || '')
        setMarkers(prev => [...prev, m])
        return { ok: true, tagId: m.id }
      }
      case 'update_tag': {
        if (!markers.find(m => m.id === cmd.tagId)) return { error: `tag not found: ${cmd.tagId}` }
        setMarkers(prev => prev.map(m => m.id === cmd.tagId ? { ...m, ...(cmd.t !== undefined ? { t: cmd.t } : {}), ...(cmd.label !== undefined ? { label: cmd.label } : {}) } : m))
        return { ok: true }
      }
      case 'list_sfx': {
        const lib = await window.ipcRenderer.sfxLibrary()
        return { sfx: lib.items.map(i => ({ name: i.name, duration: i.duration, builtin: i.builtin })) }
      }
      case 'place_sfx': {
        const lib = await window.ipcRenderer.sfxLibrary()
        const item = lib.items.find(i => i.name.toLowerCase() === String(cmd.name).toLowerCase())
        if (!item) return { error: `sfx not found: ${cmd.name}. Available: ${lib.items.map(i => i.name).join(', ')}` }
        let media = mediaBin.find(m => m.path === item.path)
        if (!media) { media = { id: rid(), name: `${item.name} ✦`, path: item.path, type: 'audio', duration: item.duration, hasVideo: false, hasAudio: true }; setMediaBin(prev => [...prev, media!]) }
        const clip: TimelineClip = { id: rid(), mediaId: media.id, type: 'audio', trackId: 'a2', start: cmd.t ?? currentTime, duration: item.duration, sourceStart: 0, volume: cmd.volume ?? 1, fadeIn: 0, fadeOut: 0 }
        setClips(prev => [...prev, clip])
        return { ok: true, clipId: clip.id, at: clip.start }
      }
      case 'stage_rect': {
        const r = stageRef.current?.getBoundingClientRect()
        if (!r) return { error: 'no stage' }
        const dpr = window.devicePixelRatio || 1
        return { x: Math.round(r.x * dpr), y: Math.round(r.y * dpr), w: Math.round(r.width * dpr), h: Math.round(r.height * dpr), dpr }
      }
      case 'cut_pauses': return await runCutDeadSpace()
      case 'find_repeats': {
        const r = await scanTakes()
        if (r.error) return r
        setShowTakes(true)
        // hand back the actual words so the assistant can judge the takes itself
        const a = r.analysis || takesRef.current
        return {
          ok: true, lines: r.lines, groups: (a?.groups || []).map((g, i) => ({
            group: i,
            keep: g.members.indexOf(g.keep),
            takes: g.members.map(m => ({ member: g.members.indexOf(m), at: +a!.chunks[m].start.toFixed(2), seconds: +(a!.chunks[m].end - a!.chunks[m].start).toFixed(2), text: a!.chunks[m].text })),
          })),
          hint: 'Pick a take per group with apply_takes { keep: [{ group, member }] }, or drop extra lines with drop: [lineIndex]. Nothing is cut until you call it.',
        }
      }
      case 'apply_takes': {
        const a = takesRef.current
        if (!a) return { error: 'call find_repeats first' }
        let next = a
        // "0:2, 1:0" = group 0 keeps its 3rd take, group 1 keeps its 1st. Arrays work too, for
        // anything driving the plain HTTP bridge.
        const pairs: { group: number; member: number }[] = Array.isArray(cmd.keep)
          ? cmd.keep
          : typeof cmd.keep === 'string'
            ? (cmd.keep as string).split(',').map((p: string) => p.split(':').map((n: string) => parseInt(n.trim(), 10)))
                .filter((pair: number[]) => Number.isInteger(pair[0]) && Number.isInteger(pair[1]))
                .map((pair: number[]) => ({ group: pair[0], member: pair[1] }))
            : []
        if (pairs.length) {
          next = { ...next, groups: next.groups.map((g, i) => {
            const pick = pairs.find(k => k.group === i)
            const m = pick ? g.members[pick.member] : undefined
            return m === undefined ? g : { ...g, keep: m }
          }) }
        }
        const dropList: number[] = Array.isArray(cmd.drop)
          ? cmd.drop
          : typeof cmd.drop === 'string' ? (cmd.drop as string).split(',').map((n: string) => parseInt(n.trim(), 10)) : []
        if (dropList.length) next = { ...next, drops: dropList.filter(i => Number.isInteger(i) && i >= 0 && i < next.chunks.length) }
        takesRef.current = next
        setTakes(next)
        return applyTakes(next)
      }
      // ---- b-roll ----
      case 'scan_broll': {
        // the convention: a `broll` sub-folder inside the open project. Forward slash on purpose,
        // Node normalises it on Windows and it survives JSON round-trips without escaping.
        const folder = cmd.folder || (currentProject ? `${currentProject.dir}/broll` : null)
        if (!folder) return { error: 'pass folder, or open a project first' }
        const r = await window.ipcRenderer.scanBroll({ folder, refresh: !!cmd.refresh, tiles: perf.sheetTiles })
        if (r.error && !r.assets?.length) return { error: r.error }
        const assets = (r.assets || []).filter((a: any) => !a.error)
        brollRef.current = { folder, assets: assets as BrollAsset[] }
        return {
          ok: true, folder, count: assets.length,
          assets: assets.map((a: any) => ({ id: a.id, seconds: a.duration, size: `${a.width}x${a.height}`, hasAudio: a.hasAudio, usable: `${a.bestStart}-${a.bestEnd}s`, sheet: a.sheet, labels: a.labels })),
          needsLabels: r.needsLabels || [],
          hint: (r.needsLabels || []).length
            ? 'Open each `sheet` image, then call label_broll with what is actually in it (short nouns: "coffee beans", "grinder", "pouring"). Labels are what plan_broll matches against.'
            : 'Everything is labelled. plan_broll next.',
        }
      }
      case 'label_broll': {
        const folder = cmd.folder || brollRef.current?.folder
        if (!folder) return { error: 'call scan_broll first' }
        if (!cmd.id) return { error: 'id required (the file name from scan_broll)' }
        const r = await window.ipcRenderer.labelBroll({ folder, id: cmd.id, labels: cmd.labels, description: cmd.description, bestStart: cmd.bestStart, bestEnd: cmd.bestEnd, maxUses: cmd.maxUses })
        if (r.error) return r
        if (brollRef.current) brollRef.current.assets = brollRef.current.assets.map(a => a.id === cmd.id ? { ...a, ...r.saved } : a)
        return { ok: true, id: cmd.id, saved: r.saved }
      }
      case 'plan_broll': {
        if (!brollRef.current?.assets.length) return { error: 'call scan_broll first' }
        const labelled = brollRef.current.assets.filter(a => (a.labels || []).length || a.description)
        if (!labelled.length) return { error: 'none of the b-roll is labelled yet: look at the contact sheets and call label_broll' }
        const sp = await readSpeech(cmd.model)
        if (sp.error || !sp.sentences) return { error: sp.error || 'no speech' }
        // "0-12, 300-330" from an MCP client, or real objects from the plain HTTP bridge
        const protect: { start: number; end: number }[] = Array.isArray(cmd.protect)
          ? cmd.protect
          : typeof cmd.protect === 'string'
            ? cmd.protect.split(',').map((r: string) => r.split('-').map((n: string) => parseFloat(n.trim())))
                .filter((r: number[]) => r.length === 2 && r.every(n => Number.isFinite(n)))
                .map((r: number[]) => ({ start: r[0], end: r[1] }))
            : []
        const { placements, skipped } = planBroll(sp.sentences, labelled, {
          minDuration: cmd.minDuration, maxDuration: cmd.maxDuration, gapBetween: cmd.gapBetween,
          coverage: cmd.coverage, protectStart: cmd.protectStart, minScore: cmd.minScore,
          protect, totalDuration,
        })
        const snapped = snapToWords(placements, sp.sentences, sp.words || [])
        // remember which speech this was planned against: place_broll refuses it once that moves
        brollPlanRef.current = { placements: snapped, at: speechKey() }
        return {
          ok: true,
          placements: snapped.map(pl => ({ at: +pl.start.toFixed(2), seconds: +(pl.end - pl.start).toFixed(2), clip: pl.name, on: pl.matched.join(' '), line: pl.text, score: pl.score })),
          skipped: skipped.slice(0, 8),
          summary: describePlan(snapped, totalDuration),
          hint: 'Nothing is on the timeline yet. place_broll puts it there; pass drop:[index] to leave one out.',
        }
      }
      case 'place_broll': {
        const plan = brollPlanRef.current?.placements
        if (!plan?.length) return { error: 'call plan_broll first' }
        // a plan is a list of timeline times; after a cut or a moved clip they point at other words
        if (brollPlanRef.current!.at !== speechKey()) return { error: 'the timeline changed since plan_broll (a cut, a moved or trimmed clip), so those times now land on different words. Run plan_broll again, then place_broll.' }
        const drop = new Set<number>(Array.isArray(cmd.drop) ? cmd.drop : typeof cmd.drop === 'string' ? cmd.drop.split(',').map((n: string) => parseInt(n.trim(), 10)) : [])
        const keep = plan.filter((_, i) => !drop.has(i))
        const made: any[] = []
        for (const pl of keep) {
          const media = await ensureMedia(pl.path)
          if (!media) { made.push({ clip: pl.name, error: 'could not read that file' }); continue }
          const dur = +(pl.end - pl.start).toFixed(3)
          // a couple of frames of dissolve at each end: a hard cut on picture-only b-roll can
          // strobe, and anything longer starts reading as a transition effect
          const fade = Math.min(0.12, dur / 6)
          setClips(prev => [...prev, {
            id: rid(), mediaId: media.id, type: media.type, trackId: 'v2' as const,
            start: pl.start, duration: dur, sourceStart: pl.sourceStart,
            volume: 0, fadeIn: fade, fadeOut: fade,
          }])
          made.push({ at: +pl.start.toFixed(2), seconds: dur, clip: pl.name, on: pl.matched.join(' ') })
        }
        brollPlanRef.current = null   // placed: a second place_broll would stack duplicate cutaways
        return { ok: true, placed: made.length, cutaways: made, note: 'b-roll is picture only: the audio underneath is untouched' }
      }

      // ---- precise speech ----
      case 'analyze_speech': {
        const sp = await readSpeech(cmd.model, !!cmd.refresh)
        if (sp.error) return { error: sp.error }
        return {
          ok: true, words: sp.words!.length, sentences: sp.sentences!.length,
          model: speechRef.current?.model,
          transcript: sp.sentences!.map((x, i) => `${i}  ${x.start.toFixed(2)}-${x.end.toFixed(2)}  ${x.text}`),
        }
      }
      case 'find_phrase': {
        if (!cmd.text) return { error: 'text required' }
        const sp = await readSpeech(cmd.model)
        if (sp.error || !sp.words) return { error: sp.error || 'no speech' }
        const hit = spanForPhrase(sp.words, cmd.text, { after: cmd.after, before: cmd.before })
        if (!hit) return { error: `not found: "${cmd.text}"` }
        const cutOut = cmd.refine === false ? hit.cutOut : await refine(hit.cutOut, 'after')
        const cutIn = cmd.refine === false ? hit.cutIn : await refine(hit.cutIn, 'before')
        return {
          ok: true, heard: hit.text, kept: hit.trimmed,
          dropped: hit.text === hit.trimmed ? null : hit.text.slice(hit.trimmed.length).trim(),
          start: +cutIn.toFixed(3), end: +cutOut.toFixed(3),
          note: 'end sits past the last word of the thought and before whatever came next, snapped to the waveform',
        }
      }
      case 'cut_at_phrase': {
        if (!cmd.text) return { error: 'text required' }
        const sp = await readSpeech(cmd.model)
        if (sp.error || !sp.words) return { error: sp.error || 'no speech' }
        const hit = spanForPhrase(sp.words, cmd.text, { after: cmd.after, before: cmd.before })
        if (!hit) return { error: `not found: "${cmd.text}"` }
        const mode = cmd.mode || 'end'
        const at = mode === 'start'
          ? (cmd.refine === false ? hit.cutIn : await refine(hit.cutIn, 'before'))
          : (cmd.refine === false ? hit.cutOut : await refine(hit.cutOut, 'after'))
        if (mode === 'split') {
          const hits = clips.filter(c => at > c.start && at < c.start + c.duration)
          if (!hits.length) return { error: `nothing to split at ${at.toFixed(2)}s` }
          setClips(prev => {
            const next = [...prev]
            for (const c0 of hits) {
              const off = at - c0.start
              // hard cut on the picture, but ramp the waveform or the join clicks (as split_clip)
              const a = { ...c0, id: rid(), duration: off, fadeOut: 0, aFadeOut: DEPOP }
              const b = { ...c0, id: rid(), start: at, duration: c0.duration - off, sourceStart: c0.sourceStart + off, fadeIn: 0, aFadeIn: DEPOP }
              const i = next.findIndex(c => c.id === c0.id)
              next.splice(i, 1, a, b)
            }
            return next
          })
          return { ok: true, at: +at.toFixed(3), kept: hit.trimmed, split: hits.length }
        }
        const range = mode === 'start' ? { start: 0, end: at } : { start: at, end: totalDuration }
        if (range.end - range.start <= 0.05) return { error: 'nothing to remove there' }
        // trimming a whole head or tail drops the tags that were in it rather than piling them on the join
        const out = removeRange(clips, texts, range.start, range.end, 0, markers, true)
        setClips(out.clips)
        setTexts(out.texts)
        setMarkers(out.markers)
        return {
          ok: true, at: +at.toFixed(3), kept: hit.trimmed,
          dropped: hit.text === hit.trimmed ? null : hit.text.slice(hit.trimmed.length).trim(),
          removed: +(range.end - range.start).toFixed(2),
          note: mode === 'start' ? 'everything before the phrase is gone' : 'everything after the phrase is gone',
        }
      }
      case 'plan_framing': {
        const fv = firstVideo()
        const v = cmd.path ? { path: cmd.path } : (fv && { path: fv.proxyPath || fv.path })
        if (!v) return { error: 'no video on the timeline' }
        // "3@0.72, 9.5@0.35" from an MCP client, or real objects from the plain HTTP bridge
        const hints: { t: number; cx: number; weight?: number }[] = Array.isArray(cmd.hints)
          ? cmd.hints
          : typeof cmd.hints === 'string'
            ? cmd.hints.split(',').map((h: string) => h.split('@').map((n: string) => parseFloat(n.trim())))
                .filter((h: number[]) => h.length === 2 && h.every(n => Number.isFinite(n)))
                .map((h: number[]) => ({ t: h[0], cx: Math.min(1, Math.max(0, h[1])) }))
            : []
        return await window.ipcRenderer.planFraming({
          filePath: v.path, sourceStart: cmd.sourceStart, duration: cmd.duration,
          fps: cmd.fps ?? perf.framingFps, hints, aspect: cmd.aspect,
        })
      }
      case 'look_through': {
        const fv = firstVideo()
        const v = cmd.path ? { path: cmd.path } : (fv && { path: fv.proxyPath || fv.path })
        if (!v) return { error: 'no video on the timeline' }
        const r = await window.ipcRenderer.visualIndex({
          filePath: v.path, interval: cmd.interval, maxFrames: cmd.maxFrames,
          perSheet: cmd.perSheet, cols: cmd.cols, tileWidth: cmd.tileWidth,
          sourceStart: cmd.sourceStart, duration: cmd.duration,
        })
        return r
      }
      // ---- sound effects: search the free libraries, or model one ----
      case 'search_sfx': {
        if (!cmd.query) return { error: 'query required' }
        const r = await window.ipcRenderer.sfxSearch({
          query: cmd.query, token: settings.sfxGen.freesoundToken || undefined,
          safeOnly: cmd.safeOnly, maxSeconds: cmd.maxSeconds, pageSize: cmd.limit,
        })
        if (r.error) return r
        sfxHitsRef.current = r.results || []
        return {
          ok: true, query: r.query, found: r.count,
          results: (r.results || []).map((h: any, i: number) => ({
            index: i, name: h.name, seconds: h.seconds, from: h.provider, by: h.author,
            licence: h.license, credit: h.needsAttribution ? 'required' : 'none needed',
          })),
          notes: r.notes,
          hint: 'download_sfx { index } saves one into the user’s sound folder and records any credit it needs.',
        }
      }
      case 'download_sfx': {
        const hits = sfxHitsRef.current
        if (!hits?.length) return { error: 'call search_sfx first' }
        const idx = Number(cmd.index ?? 0)
        const hit = hits[idx]
        if (!hit) return { error: `no result ${idx}; there were ${hits.length}` }
        const r = await window.ipcRenderer.sfxDownload(hit)
        if (r.error) return r
        return {
          ok: true, name: r.name, seconds: r.seconds, path: r.path,
          attribution: r.attribution,
          note: r.attribution
            ? 'This one needs crediting: it has been written into CREDITS.txt next to the file, and belongs in the video description.'
            : 'No credit required.',
        }
      }
      case 'make_score': {
        // Cut-synced music: every visual boundary becomes a whoosh, every tag
        // point an impact with the bed ducked under it, and the tempo is fitted
        // to the cuts the user already made. Tag points are the shared language:
        // tag the moments that matter BEFORE calling this, they are the hits.
        const vis = clips.filter(c => c.trackId === 'v1' || c.trackId === 'v2')
        const cutSet = new Set<number>()
        for (const c of vis) { cutSet.add(+c.start.toFixed(3)); cutSet.add(+(c.start + c.duration).toFixed(3)) }
        const cuts = [...cutSet].sort((a, b) => a - b)
        const hits = markers.map(m => +m.t.toFixed(3))
        if (totalDuration <= 0) return { error: 'timeline is empty, nothing to score' }
        // one at a time: a retry while the first render still runs would place two beds on a1
        if (busyRef.current.score) return { error: 'A score is already being rendered. Wait for it to land on a1 (get_state shows it) rather than starting another.' }
        busyRef.current.score = true
        let r: Awaited<ReturnType<typeof window.ipcRenderer.scoreRender>>
        try {
          r = await window.ipcRenderer.scoreRender({
            cuts, hits, duration: totalDuration,
            bpm: cmd.bpm, seed: cmd.seed, intensity: cmd.intensity, style: cmd.style, name: cmd.name,
          })
        } finally { busyRef.current.score = false }
        if (r.error || !r.path) return r
        const wavPath = r.path, wavName = r.name || 'score', wavSecs = r.seconds || totalDuration
        let placed = null
        if (cmd.place !== false) {
          let media = mediaBin.find(m => m.path === wavPath)
          if (!media) { media = { id: rid(), name: `${wavName} \u266b`, path: wavPath, type: 'audio', duration: wavSecs, hasVideo: false, hasAudio: true }; setMediaBin(prev => [...prev, media!]) }
          const clip: TimelineClip = { id: rid(), mediaId: media!.id, type: 'audio', trackId: 'a1', start: 0, duration: wavSecs, sourceStart: 0, volume: cmd.volume ?? 1, fadeIn: 0, fadeOut: 0.4 }
          setClips(prev => [...prev, clip])
          placed = clip.id
        }
        return {
          ok: true, path: wavPath, seconds: wavSecs, bpm: r.bpm, style: r.style || 'electronic', pockets: r.pockets,
          whooshes: r.whooshes, impacts: r.impacts,
          grooveAt: r.grooveAt, calmsAt: r.calmsAt, droneAt: r.droneAt,
          clipId: placed,
          note: placed
            ? `Scored ${cuts.length} cuts and ${hits.length} tag points at ${r.bpm} BPM (${r.style || 'electronic'}), placed on a1. A different seed is a different take; intensity chill/standard/epic changes how hard it hits; style cinematic swaps the kit for strings, cello, taiko and choir with a silence pocket before every drop. Re-run after editing, the score is derived from the cuts.`
            : 'Rendered into the sound library (score/), not placed.',
        }
      }
      case 'make_sfx': {
        if (!cmd.recipe) {
          const list = await window.ipcRenderer.sfxRecipes()
          return { error: 'recipe required', available: list.recipes }
        }
        const r = await window.ipcRenderer.sfxRender({
          recipe: cmd.recipe, seed: cmd.seed, intensity: cmd.intensity, duration: cmd.duration,
        })
        if (r.error) return r
        return {
          ok: true, recipe: cmd.recipe, seconds: r.seconds, path: r.path, about: r.about,
          note: 'Rendered into the sound library. Pass a different seed for another take of the same sound.',
        }
      }
      case 'set_recipe': {
        // The Start Recipe is settings, and settings are owned by the running app: it loads them
        // at startup and writes the whole file back whenever they change. Editing that file from
        // outside looks like it worked and is then silently overwritten the next time the app
        // saves, which is exactly how a carefully written workflow went missing. So changes come
        // through here, and get persisted by the same path the GUI uses.
        const cur = settings.recipe.text || ''
        const mode = cmd.mode || 'append'
        if (!cmd.text && mode !== 'show') return { error: 'text required (or mode: "show")' }
        if (mode === 'show') return { ok: true, text: cur, lines: cur.split('\n').length }
        const next = mode === 'replace' ? String(cmd.text)
          : mode === 'prepend' ? `${cmd.text}\n${cur}`
          : `${cur}\n${cmd.text}`
        setSettings(s => ({ ...s, recipe: { ...s.recipe, text: next } }))
        return { ok: true, mode, lines: next.split('\n').length, note: 'saved into settings the same way the GUI does, so it survives a restart' }
      }
      case 'run_recipe': { await runRecipe(); return { ok: true } }
      case 'sample_frames': {
        const sf = firstVideo()
        const v = cmd.path ? { path: cmd.path } : (sf && { path: sf.proxyPath || sf.path })
        if (!v) return { error: 'no video on the timeline' }
        if (cmd.rank) return await window.ipcRenderer.rankFrames({ filePath: v.path, count: Math.max(12, (cmd.count || 8) * 3), keep: cmd.count || 8 })
        return await window.ipcRenderer.sampleFrames({ filePath: v.path, count: cmd.count || 8 })
      }
      case 'compose_thumbnail': {
        // real pictures first: the creator's photo, else the best real frame, else a placeholder
        if (!cmd.outPath) return { error: 'outPath required' }
        const fv = firstVideo()
        const v = cmd.path ? { path: cmd.path, name: 'video' } : (fv && { path: fv.path, name: fv.name })
        const photo = cmd.imagePath || (cmd.t === undefined && !cmd.placeholder ? thumbPhotos()[0] : undefined)
        let t = cmd.t as number | undefined
        let why = ''
        if (!photo && v && t === undefined && !cmd.placeholder) {
          const r = await window.ipcRenderer.rankFrames({ filePath: v.path, count: 24, keep: 1 })
          if (r.frames?.length) { t = r.frames[0].t; why = r.frames[0].why }
        }
        const res = await window.ipcRenderer.composeThumbnail({ filePath: photo || cmd.placeholder ? null : v?.path, t: t ?? 1, imagePath: photo || null, subtitle: cmd.subtitle,
          logoPath: cmd.logoPath ?? settings.brand.logoPath, outPath: cmd.outPath, theme: cmd.theme || thumbTheme() })
        return { ...res, ...(res.source === 'frame' ? { frameAt: t, ...(why ? { why } : {}) } : {}), ...(res.source === 'photo' ? { photo } : {}),
          ...(res.nudge ? { tellTheCreator: res.nudge } : {}) }
      }
      case 'ui': {
        if (cmd.panel === 'booth') setShowBooth(cmd.open !== false)
        else if (cmd.panel === 'narration') setShowNarration(cmd.open !== false)
        else if (cmd.panel === 'sfx') setSidebarTab('sfx')
        else if (cmd.panel === 'media') setSidebarTab('media')
        else if (cmd.panel === 'settings') setShowSettings(cmd.open !== false)
        else if (cmd.panel === 'thumbnail') setShowThumbnail(cmd.open !== false)
        else if (cmd.panel === 'connect') setShowConnect(cmd.open !== false)
        else if (cmd.panel === 'model3d') { if (cmd.path) setModel3DPath(cmd.path); setShowModel3D(cmd.open !== false) }
        else if (cmd.panel === 'help') setShowHelp(cmd.open !== false)
        else if (cmd.panel === 'takes') setShowTakes(cmd.open !== false)
        else return { error: `unknown panel: ${cmd.panel}. Use booth | narration | sfx | media | settings | thumbnail | connect | model3d (optional path) | help | takes` }
        return { ok: true, panel: cmd.panel }
      }
      case 'render_3d': {
        const api = model3dApi.current
        if (!showModel3D || !api?.loaded()) return { error: 'no model open, call open_panel { panel: "model3d", path } first' }
        const r = cmd.still ? await api.still({ transparent: cmd.transparent }) : await api.record({ seconds: cmd.seconds, transparent: cmd.transparent })
        if (r.error) return { error: r.error }
        return {
          ok: true, path: r.path, kind: cmd.still ? 'still' : 'turntable',
          placement: cmd.transparent ? `transparent overlay placed at ${currentTime.toFixed(2)}s on the video track, it composites over the clip beneath it` : 'appended to the video track',
        }
      }
      case 'open_project': {
        const root = settings.workspace.root
        if (!root) return { error: 'no project folder set, the human picks one in Settings → Project folder' }
        const r = await window.ipcRenderer.listProjects(root)
        const list = r.projects || []
        if (!cmd.name) return { ok: true, root, projects: list.map(p => ({ name: p.name, media: p.media, saved: p.saved })), current: currentProject?.name || null }
        const want = String(cmd.name).toLowerCase()
        const hit = list.find(p => p.name.toLowerCase() === want) || list.find(p => p.name.toLowerCase().includes(want))
        if (!hit) return { error: `no project called "${cmd.name}". Available: ${list.map(p => p.name).join(', ') || '(none yet)'}` }
        // Opening replaces the timeline. Never throw away the human's unsaved work on an agent's say-so.
        const leaving = currentProject?.dir ?? null
        const sameProject = !!leaving && pathKey(leaving) === pathKey(hit.path)
        const discard = isDirty() && !!cmd.force
        if (isDirty() && !cmd.force) {
          if (!cmd.save) return { error: `unsaved changes in ${currentProject?.name || 'the current project'}: ask the human, then call again with force:true (discards them) or save:true (saves them first, then opens).` }
          if (!currentProject && !saveFile) return { error: 'The current work has never been saved anywhere, so save:true would need the human to pick a file. Ask them to press Save first.' }
          if (!(await saveProject())) return { error: 'Saving the current project failed, so nothing was opened.' }
        }
        // Reopening the open project: its autosave is this session's own, now saved, discarded or
        // stale (undone back to the save), so it is not "unsaved work from an earlier session"
        if (sameProject) await clearAutosave(leaving)
        // An earlier session's unsaved work in the target is the human's question (restore or
        // discard), not the agent's, so the open waits for them rather than burying it
        const opened = await openProjectFolder(hit.path, hit.name, { skipConfirm: true, askRecover: false })
        if (!opened) return { error: `could not open ${hit.name}` }
        if (opened.unsaved) return { error: `${hit.name} has unsaved changes from ${new Date(opened.unsaved.savedAt).toLocaleString()} that an earlier session never saved. Only the human can say whether to restore them: ask them to choose ${hit.name} in the project list in the Media panel, which offers Restore or Discard, then carry on. Nothing was opened.` }
        if (discard && !sameProject) await clearAutosave(leaving)   // force: discarded on purpose, so not offered back later
        return { ok: true, opened: hit.name, folder: hit.path, mediaInFolder: hit.media }
      }
      case 'booth_script': {
        if (typeof cmd.script !== 'string' || !cmd.script.trim()) return { error: 'script (string) required, one line per beat' }
        setBoothScript(cmd.script.trim())
        if (cmd.open !== false) setShowBooth(true)
        return { ok: true, lines: cmd.script.trim().split('\n').filter((l: string) => l.trim()).length }
      }
      case 'seek': setCurrentTime(clamp(cmd.t ?? 0, 0, Math.max(totalDuration, cmd.t ?? 0))); return { ok: true }
      case 'play': setIsPlaying(cmd.playing !== false); return { ok: true }
      case 'set_format': {
        // check everything first, change nothing unless it all makes sense
        const o = cmd.orientation !== undefined ? normOrientation(cmd.orientation) : orientation
        const r = cmd.resolution !== undefined ? normResolution(cmd.resolution) : resolution
        const f = cmd.fps !== undefined ? normFps(cmd.fps) : fps
        const bad = [
          !o && `orientation must be landscape, portrait or square (got "${cmd.orientation}")`,
          !r && `resolution must be 4K, 1440p, 1080p or 720p (got "${cmd.resolution}")`,
          !f && `fps must be 24, 30 or 60 (got "${cmd.fps}")`,
        ].filter(Boolean)
        if (bad.length || !o || !r || !f) return { error: bad.join('; '), format: { orientation, resolution, fps, width: w, height: h } }
        setOrientation(o); setResolution(r); setFps(f)
        const [fw, fh] = frameDims(o, r)
        return { ok: true, format: { orientation: o, resolution: r, fps: f, width: fw, height: fh } }
      }
      case 'prepare_analysis': {
        // Hands a video-analysis service (Adversal and friends) something to chew on, and
        // reports which stretches of the timeline are not marked yet so a second pass only
        // looks at what is new. Timestamps that come back are mapped with toTimeline below.
        const pad = typeof cmd.gapPad === 'number' ? Math.max(1, cmd.gapPad) : 10
        const minGap = typeof cmd.minGap === 'number' ? Math.max(1, cmd.minGap) : 5
        const total = Math.max(totalDuration, 0)

        // stretches already accounted for by a tag point, merged into runs
        const covered: { start: number; end: number }[] = []
        for (const m of [...markers].sort((a, b) => a.t - b.t)) {
          const span = { start: Math.max(0, m.t - pad), end: Math.min(total, m.t + pad) }
          const last = covered[covered.length - 1]
          if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
          else covered.push(span)
        }
        const gaps: { start: number; end: number }[] = []
        let cursor = 0
        for (const c of covered) {
          if (c.start - cursor >= minGap) gaps.push({ start: +cursor.toFixed(2), end: +c.start.toFixed(2) })
          cursor = Math.max(cursor, c.end)
        }
        if (total - cursor >= minGap) gaps.push({ start: +cursor.toFixed(2), end: +total.toFixed(2) })
        const tagList = [...markers].sort((a, b) => a.t - b.t).map(m => ({ t: +m.t.toFixed(2), label: m.label || '' }))
        const coveredSeconds = +covered.reduce((n, c) => n + (c.end - c.start), 0).toFixed(1)

        const scope = cmd.scope === 'clip' ? 'clip' : 'timeline'
        if (scope === 'clip') {
          const clip = cmd.clipId
            ? clips.find(c => c.id === cmd.clipId)
            : clips.filter(c => c.trackId === 'v1').sort((a, b) => a.start - b.start)[0]
          const media = clip && mediaBin.find(m => m.id === clip.mediaId)
          if (!clip || !media) return { error: 'no video clip to analyse (pass clipId, or put a clip on the video track)' }
          // no re-render: point the analyser at the original file and the in/out points
          return {
            ok: true, scope, file: media.path,
            fileStart: +clip.sourceStart.toFixed(2), fileEnd: +(clip.sourceStart + clip.duration).toFixed(2),
            toTimeline: { add: +(clip.start - clip.sourceStart).toFixed(2) },
            duration: +clip.duration.toFixed(2), tags: tagList, coveredSeconds, covered, gaps,
            hint: 'Send file with those in/out points. A timestamp T from the analyser is timeline time T + toTimeline.add, so add tags there.',
          }
        }

        if (clips.length === 0) return { error: 'timeline is empty' }
        // Flatten the timeline so returned timestamps line up 1:1 with what the human sees.
        // Rendered small on purpose: analysis does not need 1080p, and the upload is quicker.
        const preA = await exportPreflight()
        if (preA) return { error: 'could not render the timeline for analysis: ' + preA }
        const out: string = cmd.outputPath || await window.ipcRenderer.analysisPath(currentProject?.name || 'timeline')
        setIsPlaying(false)
        setExportProgress(0); setEta(null); exportStartRef.current = Date.now()
        try {
          await window.ipcRenderer.exportVideo({
            clips: exportClips(1280, 720, 30, 'analysis'),
            texts, brand: { ...settings.brand, enabled: false }, audio: settings.audio, outputPath: out,
            settings: { width: 1280, height: 720, fps: 30, quality: 'analysis', masterVolume },
          })
        } catch (e) {
          setExportProgress(null); setEta(null)
          const f = exportFailure(e)
          console.error('Analysis render failed:', f.reason, f.detail)
          return { error: 'could not render the timeline for analysis: ' + f.reason, ...(f.detail ? { detail: f.detail } : {}) }
        }
        setExportProgress(100); setEta(null)
        setTimeout(() => setExportProgress(null), 3000)
        return {
          ok: true, scope, file: out, duration: +total.toFixed(2),
          toTimeline: { add: 0 }, tags: tagList, coveredSeconds, covered, gaps,
          hint: gaps.length
            ? 'Analyse only the gaps listed (they are the stretches with no tag point nearby), then add tags inside them. Timestamps map straight to the timeline.'
            : 'Every stretch already has a tag nearby, so there is nothing new to analyse unless you lower gapPad.',
        }
      }
      case 'export': {
        if (!cmd.outputPath) return { error: 'outputPath required' }
        if (clips.length === 0 && texts.length === 0) return { error: 'timeline is empty' }
        const pre = await exportPreflight()
        if (pre) return { error: 'export not started: ' + pre }
        setIsPlaying(false)
        const payload = {
          clips: exportClips(w, h, fps, exportQuality),
          texts, brand: settings.brand, audio: settings.audio, outputPath: cmd.outputPath,
          settings: { width: w, height: h, fps, quality: exportQuality, masterVolume },
        }
        // Drive the same progress state the button uses: the human watches it render, and
        // the button re-enables afterwards (it stayed stuck and disabled before).
        setExportProgress(0); setEta(null); exportStartRef.current = Date.now()
        try { await window.ipcRenderer.exportVideo(payload) }
        catch (e) {
          setExportProgress(null); setEta(null); setLastExport(null)
          const f = exportFailure(e)
          console.error('Export failed:', f.reason, f.detail)
          notify(exportFailureText(f), 15000)
          // the reason first; ffmpeg's last lines (or the list behind a count) as detail
          return { error: 'export failed: ' + f.reason, ...(f.detail ? { detail: f.detail } : {}) }
        }
        setExportProgress(100); setEta(null)
        setTimeout(() => setExportProgress(null), 3000)
        setLastExport(cmd.outputPath)
        const qc = cmd.qualityCheck === false ? null : await window.ipcRenderer.qualityCheck(cmd.outputPath).catch(() => null)
        const checks: string[] = qc?.checks?.map((c: any) => `${c.status}: ${c.label} - ${c.detail}`) ?? []
        let verdict: string | undefined = qc?.verdict
        const worse = (v: string) => { if (v === 'fail' || (v === 'warn' && verdict === 'pass')) verdict = v }
        // design rules, checked on the timeline that was just rendered
        const layout = layoutReport(texts, w, h)
        for (const n of layout.notes) { checks.push(`warn: Text layout - ${n}`); worse('warn') }
        if (texts.length && !layout.notes.length) checks.push('pass: Text layout - no overlaps, nothing off-frame, no flashes')
        // script-aware: read the finished mix back and diff it against what was meant to be said
        let script: any
        const expected = String(cmd.script || boothScript || '').trim()
        if (expected && cmd.qualityCheck !== false) {
          const tr = await window.ipcRenderer.transcribe(cmd.outputPath, { model: 'tiny', language: settings.caption.language, word: false }).catch(() => null)
          if (tr?.chunks) {
            const heard = wordsOf(tr.chunks.map(c => c.text).join(' '))
            const want = wordsOf(expected)
            const bag = new Map<string, number>()
            for (const x of heard) bag.set(x, (bag.get(x) || 0) + 1)
            const missing: string[] = []
            let matched = 0
            for (const x of want) { const n = bag.get(x) || 0; if (n > 0) { matched++; bag.set(x, n - 1) } else missing.push(x) }
            const overlap = want.length ? matched / want.length : 1
            const lengthRatio = want.length ? heard.length / want.length : 1
            const status = overlap >= 0.9 && lengthRatio > 0.7 && lengthRatio < 1.5 ? 'pass' : overlap >= 0.75 ? 'warn' : 'fail'
            script = { status, overlap: +overlap.toFixed(3), lengthRatio: +lengthRatio.toFixed(2), wordsExpected: want.length, wordsHeard: heard.length, missing: missing.slice(0, 15) }
            checks.push(`${status}: Script match - ${Math.round(overlap * 100)}% of the script's words were heard in the render${missing.length ? ` (missing: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''})` : ''}`)
            worse(status)
          }
        }
        return { ok: true, outputPath: cmd.outputPath, qualityCheck: qc || checks.length ? { verdict, checks } : undefined, script, layout: layout.notes.length ? layout.notes : undefined }
      }
      default:
        return { error: `unknown action: ${cmd.action}` }
    }
  }
  useEffect(() => {
    const h = async (_e: any, cmd: any) => {
      // The request's own number travels as reqId; cmd.id is the ITEM for delete_item and
      // label_broll (a numeric item id must not be mistaken for a request already handled).
      // A main process from before reqId sends the request number as id.
      const req = typeof cmd?.reqId === 'number' ? cmd.reqId : typeof cmd?.id === 'number' ? cmd.id : undefined
      if (req !== undefined) {
        if (handledAgentCmds.has(req)) return           // already ran for this request
        handledAgentCmds.add(req)
        if (handledAgentCmds.size > 500) for (const id of [...handledAgentCmds].slice(0, 250)) handledAgentCmds.delete(id)
      }
      let result: any
      try { result = await agentExec.current(cmd) } catch (e) { result = { error: errText(e) } }
      window.ipcRenderer.send('agent-response', { id: cmd.id, reqId: cmd.reqId, result })
    }
    window.ipcRenderer.on('agent-command', h)
    return () => window.ipcRenderer.off('agent-command', h)
  }, [])

  // ---- timeline geometry helpers ----
  const timeAtClientX = (clientX: number) => {
    const el = timelineRef.current!
    const rect = el.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left + el.scrollLeft) / pxPerSec)
  }

  /** Files from Explorer, or an item dragged out of the Media panel, dropped at a time (on a track row, or anywhere). */
  const dropMedia = async (e: React.DragEvent, track?: TimelineClip['trackId']) => {
    e.preventDefault()
    const dropTime = timeAtClientX(e.clientX)
    const binId = e.dataTransfer.getData(MEDIA_DRAG)
    if (binId) {
      const m = mediaBin.find(x => x.id === binId)
      if (!m) return
      if (track && trackFor(m, track) !== track) notify(`${m.name} is ${m.type === 'audio' ? 'sound, so it went on the voice / music track' : 'a picture, so it went on the video track'}.`)
      placeOnTimeline(m, dropTime, track)
      return
    }
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    const added = await importFiles(files)
    let cursor = dropTime
    added.forEach(m => { placeOnTimeline(m, m.type === 'audio' ? dropTime : cursor, track); if (m.type !== 'audio') cursor += m.duration })
  }
  const onTimelineDrop = (e: React.DragEvent) => { void dropMedia(e) }
  // Each track row takes its own drops (see the rows below), so a clip dropped on the B-roll row
  // lands on b-roll. They stop the event: the timeline's own handler would add a second copy on v1.

  // ---- editing actions ----
  const deleteSelected = () => {
    if (!selectedId) return
    setClips(c => c.filter(x => x.id !== selectedId))
    setTexts(t => t.filter(x => x.id !== selectedId))
    setSelectedId(null)
  }

  const splitAtPlayhead = () => {
    if (!selClip) return
    if (currentTime <= selClip.start || currentTime >= selClip.start + selClip.duration) return
    const off = currentTime - selClip.start
    // hard cut on the picture, but ramp the waveform or the join clicks (the same DEPOP as split_clip / removeRange)
    const a = { ...selClip, id: rid(), duration: off, fadeOut: 0, aFadeOut: DEPOP }
    const b = { ...selClip, id: rid(), start: currentTime, duration: selClip.duration - off, sourceStart: selClip.sourceStart + off, fadeIn: 0, aFadeIn: DEPOP }
    setClips(prev => { const i = prev.findIndex(c => c.id === selClip.id); const n = [...prev]; n.splice(i, 1, a, b); return n })
    setSelectedId(b.id)
  }

  // Put the caret in the text on the picture, with the placeholder selected so typing replaces it
  const startTextEdit = (id: string, seed?: string) => {
    editTextRef.current = seed ?? texts.find(x => x.id === id)?.text ?? ''
    setSelectedId(id)
    setIsPlaying(false)
    setEditingTextId(id)
    setTimeout(() => {
      const el = editRef.current
      if (!el) return
      const current = editTextRef.current
      el.innerText = current || ''
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }, 0)
  }
  const endTextEdit = () => {
    const el = editRef.current
    if (el && editingTextId) {
      const v = el.innerText.replace(/\n+$/, '')
      setTexts(prev => prev.map(x => x.id === editingTextId ? { ...x, text: v } : x))
    }
    setEditingTextId(null)
  }

  // The export layers clips in array order: each one overlays whatever came before. layerOrder
  // sorts by track only (the same helper the preview uses), which keeps b-roll ON TOP of the A-roll
  // and keeps the order within a track exactly as the preview stacks it. v2 is picture only, so its
  // own audio is dropped here rather than mixed in: the A-roll keeps talking underneath the cutaway.
  const exportClips = (W: number, H: number, FPS: number, quality: string) => layerOrder(clips)
    .map(c => {
      const media = mediaBin.find(m => m.id === c.mediaId)
      const src = exportSource(media, W, H, FPS, quality)
      return { ...c, path: src.path, hdr: src.hdr, hasVideo: media?.hasVideo, hasAudio: c.trackId === 'v2' ? false : media?.hasAudio, chromaKey: media?.chromaKey }
    })

  // The exporter opens the source once per clip, and on a long cut of 4K HEVC HDR that is a lot of
  // heavy decodes plus tone maps. The preview copy is light and already SDR, but it is also smaller
  // (720p on lighter machines), capped at 30 fps and re-compressed (CRF 24, veryfast), so it may
  // only stand in when it costs no size and no motion: fitted into the export frame (the export
  // scales with "decrease") it must not be blown up, and its frame rate must keep up with the export
  // (or with the footage itself, when that is slower). Even then it is a second generation of
  // compression, so High quality never takes it: that reads the originals. The analysis render is
  // small on purpose and always takes the copy.
  const exportSource = (m: MediaFile | undefined, W: number, H: number, FPS: number, quality: string) => {
    const original = { path: m?.path, hdr: m?.hdr }
    if (!m?.proxyPath || m.proxyPct !== undefined) return original          // none, or still being built
    if (quality === 'analysis') return { path: m.proxyPath, hdr: false }
    if (quality === 'high') return original
    const pw = m.proxyWidth, ph = m.proxyHeight, pf = m.proxyFps
    if (!pw || !ph || !pf) return original                                   // size unknown (an older save): play safe
    const upscale = Math.min(W / pw, H / ph) > 1.001
    const smooth = pf + 0.5 >= Math.min(FPS, m.fps || FPS)
    return !upscale && smooth ? { path: m.proxyPath, hdr: false } : original
  }

  /** Reasons an export cannot start, as one line (null when it can). Run before ffmpeg ever sees it. */
  const exportPreflight = async (): Promise<string | null> => {
    const used = clips.map(c => ({ c, m: mediaBin.find(x => x.id === c.mediaId) }))
    const orphans = used.filter(u => !u.m).length
    if (orphans) return `${orphans} clip${orphans === 1 ? ' uses' : 's use'} media that was removed from the Media panel. Delete ${orphans === 1 ? 'it' : 'them'} from the timeline, or re-import the file.`
    // Every file is looked for again, offline ones included: a file deleted or moved since it was
    // imported is caught here (the folder listing is cheap), and one that is back where it was (a
    // drive plugged in again) comes back online without a Relink
    const media = [...new Map(used.map(u => [u.m!.id, u.m!])).values()]
    const missing = await findMissing(media)
    const gone = new Set(missing.map(m => m.id))
    const back = media.filter(m => m.offline && !gone.has(m.id))
    if (back.length || missing.some(m => !m.offline)) {
      setMediaBin(prev => prev.map(x => gone.has(x.id) ? (x.offline ? x : { ...x, offline: true }) : back.some(b => b.id === x.id) ? { ...x, offline: undefined } : x))
      if (back.length) void backfillMedia(back.map(m => ({ ...m, offline: undefined })))
    }
    if (missing.length) return `${missing.length === 1 ? 'This file is' : 'These files are'} missing: ${missing.slice(0, 5).map(mm => mm.name).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}. Reconnect the drive ${missing.length === 1 ? 'it is' : 'they are'} on, or right-click ${missing.length === 1 ? 'it' : 'each'} in the Media panel and choose Relink.`
    return null
  }


  const addText = () => {
    const t: TextClip = { id: rid(), text: 'New text', start: currentTime, duration: 3, x: 0.5, y: 0.5, fontSize: 64, color: '#ffffff', fadeIn: 0.3, fadeOut: 0.3 }
    setTexts(prev => [...prev, t])
    setSelectedId(t.id)
    startTextEdit(t.id, t.text)   // straight into typing, rather than hunting for a box in the sidebar
  }

  /** What every audio-only pass (captions, booth draft, pauses, speech, takes) mixes: each clip
   *  WITH its trim point (sourceStart: without it a split or pause-cut clip was mixed from second 0
   *  of its file, so captions repeated the opening words), b-roll muted, missing files left out. */
  const mixPayload = () => clips.map(c => {
    const m = mediaBin.find(x => x.id === c.mediaId)
    return { path: m?.proxyPct === undefined && m?.proxyPath ? m.proxyPath : m?.path, hasAudio: c.trackId === 'v2' || m?.offline ? false : m?.hasAudio,
      start: c.start, duration: c.duration, sourceStart: c.sourceStart, volume: c.volume }
  })

  /** A fingerprint of the SPEECH on the timeline: only what can be heard talking (a1, and v1 clips
   *  with sound), each reduced to which file, where, which part of it and how loud. Texts, b-roll,
   *  SFX on a2, fades and clip ids are left out, and a split clip merges back into one span, so a
   *  caption, a cutaway or a split does not make the transcript look stale. A cut, a move or a trim
   *  does. Used to reuse the transcript and to refuse plans (takes, b-roll) made on older speech. */
  const speechKey = () => {
    const spans = clips
      .filter(c => c.trackId === 'a1' || (c.trackId === 'v1' && mediaBin.find(m => m.id === c.mediaId)?.hasAudio))
      .map(c => ({ p: mediaBin.find(m => m.id === c.mediaId)?.path || c.mediaId, s: c.start, d: c.duration, ss: c.sourceStart || 0, v: c.volume ?? 1 }))
      .sort((a, b) => a.s - b.s || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
    const merged: typeof spans = []
    for (const x of spans) {
      const prev = [...merged].reverse().find(y => y.p === x.p)
      if (prev && prev.v === x.v && Math.abs(prev.s + prev.d - x.s) < 0.002 && Math.abs(prev.ss + prev.d - x.ss) < 0.002) prev.d = x.s + x.d - prev.s
      else merged.push({ ...x })
    }
    return JSON.stringify([settings.caption.language, merged.map(x => [x.p, +x.s.toFixed(3), +x.d.toFixed(3), +x.ss.toFixed(3), x.v])])
  }

  // Local Whisper captions for the WHOLE timeline → timed text cues styled by caption settings
  // replace: the captions already on the timeline are swapped for the new ones in one update
  const generateCaptions = async (themeOverride?: string, opts: { replace?: boolean } = {}): Promise<number> => {
    const audioClips = clips.filter(c => c.trackId === 'a1' || mediaBin.find(m => m.id === c.mediaId)?.hasAudio)
    if (!audioClips.length) { notify('Add a clip with audio to the timeline first.'); return 0 }
    if (busyRef.current.captions) return 0
    const cs = settings.caption
    const request = themeOverride || themeRequest(cs)
    const themed = (themeOverride || cs.theme || 'creator') !== 'classic'
    let made = 0
    busyRef.current.captions = true
    setCaptioning('Mixing audio…'); setCaptionPct(null)
    try {
      const payload = mixPayload()
      const mix = await window.ipcRenderer.renderMixAudio({ clips: payload })
      if (mix.error || !mix.path) { notify('Captions: ' + (mix.error || 'could not prepare audio')); return 0 }
      const res = await window.ipcRenderer.transcribe(mix.path, { model: cs.model, language: cs.language, word: themed || cs.mode === 'word' })
      if (res.error) { notify('Captions: ' + res.error); return 0 }
      const cues: TextClip[] = []
      if (themed) {
        // word timings -> short lines, each carrying its words so highlight/pop/karaoke stay in sync
        const choice = chooseTheme(request)
        const words = (res.chunks || []).map(c => ({ s: c.start, e: c.end ?? c.start + 0.3, t: (c.text || '').trim() })).filter(x => x.t)
        // never past the end of the timeline (Whisper can stretch the last word to the end of its window)
        for (const p of phrasesFromWords(words)) { if (p.start >= totalDuration) continue; p.end = Math.min(p.end, totalDuration); cues.push(captionClip(p, choice.caption, request, w, h)) }
      }
      else for (const c of res.chunks || []) {
        const text = (c.text || '').trim()
        if (!text) continue
        const dur = Math.max(cs.mode === 'word' ? 0.2 : 0.4, (c.end || c.start + (cs.mode === 'word' ? 0.4 : 2)) - c.start)
        cues.push({ id: rid(), text, start: c.start, duration: dur, x: 0.5, y: CAPTION_Y[cs.position], fontSize: cs.fontSize, color: cs.color, fadeIn: cs.mode === 'word' ? 0 : 0.08, fadeOut: cs.mode === 'word' ? 0 : 0.08, box: cs.box, boxOpacity: cs.boxOpacity })
      }
      if (cues.length) { setTexts(prev => [...(opts.replace ? prev.filter(t => !t.caption) : prev), ...cues]); made = cues.length }
      else notify('No speech detected.')
    } catch (e) { console.error(e); notify('Captioning failed.') }
    // in finally: an early return above (no audio mix, a Whisper error) used to leave the status up
    // and the Captions button disabled until a restart
    finally { busyRef.current.captions = false; setCaptioning(null); setCaptionPct(null) }
    return made
  }

  /** Put every themed caption (and optionally the titles) into a new look. Returns how many changed. */
  const restyleCaptions = (request: string, titlesToo = false): { captions: number; titles: number } => {
    const choice = chooseTheme(request)
    const size = Math.round(captionPx(choice.caption, w, h) / h * 1080)
    let captions = 0, titles = 0
    for (const t of texts) { if (t.caption) captions++; else if (titlesToo) titles++ }
    setTexts(prev => prev.map(t => {
      if (t.caption) return { ...t, color: choice.caption.color, y: THEME_CAP_Y[choice.caption.position], fontSize: size, caption: { ...t.caption, spec: choice.caption, theme: request } }
      if (!titlesToo) return t
      const ti = choice.title
      return { ...t, font: ti.font, color: ti.color, outline: ti.box ? 0 : ti.outline, outlineColor: ti.outlineColor, box: ti.box || t.box, boxColor: ti.box ? ti.boxColor : t.boxColor, boxOpacity: ti.box ? ti.boxOpacity : t.boxOpacity, text: ti.uppercase ? t.text.toUpperCase() : t.text }
    }))
    return { captions, titles }
  }

  // Transcribe the timeline audio into read-along lines for the karaoke booth (one per phrase).
  // Used by the booth's "Draft from timeline audio" button and the agent's booth_script flow.
  const draftBoothScript = async (): Promise<string | null> => {
    const audioClips = clips.filter(c => c.trackId === 'a1' || mediaBin.find(m => m.id === c.mediaId)?.hasAudio)
    if (!audioClips.length) return null
    try {
      const payload = mixPayload()
      const mix = await window.ipcRenderer.renderMixAudio({ clips: payload })
      if (mix.error || !mix.path) return null
      const res = await window.ipcRenderer.transcribe(mix.path, { model: settings.caption.model, language: settings.caption.language, word: false })
      const lines = (res.chunks || []).map(c => (c.text || '').trim()).filter(Boolean)
      return lines.length ? lines.join('\n') : null
    } catch (e) { console.error(e); return null }
  }

  // Detect dead space (silent pauses OR motionless video) across the timeline and ripple it out.
  // Core is UI-free so both the toolbar button and the agent bridge can run it.
  const runCutDeadSpace = async (): Promise<{ error?: string; removed?: number; seconds?: number; mode?: string }> => {
    const S = settings.silence
    const hasAudio = clips.some(c => (c.trackId === 'a1' || c.trackId === 'a2') || (c.trackId === 'v1' && mediaBin.find(m => m.id === c.mediaId)?.hasAudio))
    const videoClips = clips.filter(c => c.trackId === 'v1' && mediaBin.find(m => m.id === c.mediaId)?.type === 'video')
    const useMotion = S.detectBy === 'motion' || (S.detectBy === 'auto' && !hasAudio)
    if (useMotion && !videoClips.length) return { error: 'No video clips to scan for still frames.' }
    if (!useMotion && !hasAudio) return { error: 'No audio to scan. Switch "Detect by" to Visual stillness for silent footage.' }
    setSilenceBusy(useMotion ? 'Scanning frames…' : 'Analyzing audio…')
    try {
      let intervals: { start: number; end: number }[] = []
      if (useMotion) {
        // scan each video clip for frozen/static stretches, mapped to timeline time
        for (const c of videoClips) {
          const media = mediaBin.find(m => m.id === c.mediaId)!
          const r = await window.ipcRenderer.detectFreeze({ filePath: media.path, sourceStart: c.sourceStart, duration: c.duration, freezeDb: S.freezeDb, minDur: S.minPause })
          for (const iv of r.intervals || []) intervals.push({ start: c.start + iv.start, end: c.start + Math.min(iv.end, c.duration) })
        }
      } else {
        const payload = mixPayload()
        const mix = await window.ipcRenderer.renderMixAudio({ clips: payload })
        if (mix.error || !mix.path) return { error: 'Cut pauses: ' + (mix.error || 'could not prepare audio') }
        const res = await window.ipcRenderer.detectSilence({ filePath: mix.path, thresholdDb: S.thresholdDb, minPause: S.minPause })
        if (res.error) return { error: 'Cut pauses: ' + res.error }
        intervals = res.intervals || []
      }
      // pad, clamp to the timeline, drop slivers, then MERGE overlaps (overlapping clips / adjacent
      // detections would otherwise double-cut and corrupt later ranges)
      let ranges = intervals
        .map(iv => ({ start: Math.max(0, iv.start + S.pad), end: Math.min(totalDuration, iv.end - S.pad) }))
        .filter(r => r.end - r.start > 0.1)
        .sort((a, b) => a.start - b.start)
      const merged: { start: number; end: number }[] = []
      for (const r of ranges) {
        const last = merged[merged.length - 1]
        if (last && r.start <= last.end + 0.01) last.end = Math.max(last.end, r.end)
        else merged.push({ ...r })
      }
      ranges = merged
      // Two pauses close together leave an orphan sliver between them: a third of a second of
      // speech that dissolves in and straight back out, which reads as a stutter rather than an
      // edit. When a cut would strand a fragment shorter than MIN_KEEP, leave that pause in.
      // Rhythm beats shaving another half second, and no speech is ever thrown away.
      const MIN_KEEP = 0.9
      const spaced: { start: number; end: number }[] = []
      for (const r of ranges) {
        const prevEnd = spaced.length ? spaced[spaced.length - 1].end : 0
        if (r.start - prevEnd < MIN_KEEP) continue
        spaced.push(r)
      }
      ranges = spaced
      if (!ranges.length) return { error: useMotion ? 'No long static stretches found (lower the min length or stillness sensitivity in settings).' : 'No long pauses found (try lowering the minimum pause length in settings).' }
      ranges.sort((a, b) => b.start - a.start) // apply last→first so earlier times stay valid
      let nc = clips, nt = texts, nm = markers, removed = 0
      for (const r of ranges) { const out = removeRange(nc, nt, r.start, r.end, S.smooth ? S.transition : 0, nm); nc = out.clips; nt = out.texts; nm = out.markers; removed += (r.end - r.start) }
      setClips(nc); setTexts(nt); setMarkers(nm); setSelectedId(null); setCurrentTime(0)
      return { removed: ranges.length, seconds: +removed.toFixed(1), mode: useMotion ? 'stillness' : 'silence' }
    } catch (e) { console.error(e); return { error: 'Cut pauses failed: ' + String(e) } }
    finally { setSilenceBusy(null) }
  }
  const cutDeadSpace = async () => {
    const r = await runCutDeadSpace()
    if (r.error) notify(r.error)
    else notify(`Removed ${r.removed} ${r.mode === 'stillness' ? 'static stretch(es)' : 'pause(s)'} (~${r.seconds}s). Undo with Ctrl+Z if needed.`)
  }

  // ---- B-roll and precise speech ----
  // The pieces that let an agent cut away to matching footage without touching the audio:
  // read the speech once (word by word), keep it, and answer questions against it.
  const brollRef = useRef<{ folder: string; assets: BrollAsset[] } | null>(null)
  const speechRef = useRef<{ words: SpeechWord[]; sentences: Span[]; mixPath: string; model: string; at: string } | null>(null)
  const brollPlanRef = useRef<{ placements: Placement[]; at: string } | null>(null)
  const sfxHitsRef = useRef<any[] | null>(null)

  /**
   * Mix the timeline's audio and read every word out of it, with times.
   *
   * Defaults to the `small` model rather than `tiny`: this is the pass everything else measures
   * from, so being right matters more than being quick. The result is cached until the timeline
   * changes, because it is the slow part.
   */
  const readSpeech = async (model?: string, force?: boolean): Promise<{ error?: string; words?: SpeechWord[]; sentences?: Span[] }> => {
    const want = model || perf.speechModel
    // keyed on the speech alone (speechKey), so an anchored add_text after another one, a caption,
    // a b-roll cutaway or an SFX reuses the transcript instead of running Whisper again
    const key = speechKey()
    if (!force && speechRef.current && speechRef.current.model === want && speechRef.current.at === key) {
      return { words: speechRef.current.words, sentences: speechRef.current.sentences }
    }
    const hasAudio = clips.some(c => (c.trackId === 'a1' || c.trackId === 'a2') || (c.trackId === 'v1' && mediaBin.find(m => m.id === c.mediaId)?.hasAudio))
    if (!hasAudio) return { error: 'Nothing with speech on the timeline yet.' }
    setTakesBusy('Mixing audio…')
    try {
      const payload = mixPayload()
      const mix = await window.ipcRenderer.renderMixAudio({ clips: payload })
      if (mix.error || !mix.path) return { error: mix.error || 'could not prepare audio' }
      setTakesBusy('Reading speech…')
      const res = await window.ipcRenderer.transcribe(mix.path, { model: want, language: settings.caption.language, word: true })
      if (res.error) return { error: res.error }
      const words: SpeechWord[] = (res.chunks || [])
        .map(c => ({ start: c.start, end: c.end ?? c.start + 0.25, text: c.text || '' }))
        .filter(w => w.text.trim() && w.end > w.start)
      if (!words.length) return { error: 'No speech detected.' }
      const sentences = sentenceSpans(words)
      speechRef.current = { words, sentences, mixPath: mix.path, model: want, at: key }
      return { words, sentences }
    } catch (e) { return { error: 'Reading speech failed: ' + String(e) } }
    finally { setTakesBusy(null) }
  }

  /** Snap a proposed cut onto the real waveform. Falls back to the estimate if audio is gone. */
  const refine = async (t: number, dir: 'after' | 'before'): Promise<number> => {
    const mix = speechRef.current?.mixPath
    if (!mix) return t
    const r = await window.ipcRenderer.refineCut({ filePath: mix, t, dir })
    return typeof r.refined === 'number' ? r.refined : t
  }

  /** Pull an asset into the bin if it is not there yet, so a cutaway can reference it. */
  const ensureMedia = async (filePath: string): Promise<MediaFile | null> => {
    const existing = mediaBin.find(m => m.path === filePath)
    if (existing) return existing
    const meta = await window.ipcRenderer.getMetadata(filePath).catch(() => null)
    const verdict = classifyMedia(filePath, meta)
    if ('reject' in verdict) return null
    const media = mediaFromProbe(baseName(filePath) || 'broll', filePath, verdict.type, meta as Probe)
    setMediaBin(prev => [...prev, media])
    void ensureProxies([media], new Map([[media.id, meta as Probe]]))
    return media
  }

  // A collapsed menu still has to show what is happening underneath it: the number of
  // pending take cuts when there is one, otherwise a dot while a hidden tool is busy or open.

  // ---- Takes & history ----
  // Transcribe the timeline, group the lines that are retakes of each other, and hand the result
  // to the panel. Detection is in electron/takes.ts; nothing is cut until the user applies.
  const stateKey = () => JSON.stringify({ c: clips, t: texts, m: markers })

  const scanTakes = async (): Promise<{ error?: string; groups?: number; lines?: number; analysis?: TakeAnalysis }> => {
    const hasAudio = clips.some(c => (c.trackId === 'a1' || c.trackId === 'a2') || (c.trackId === 'v1' && mediaBin.find(m => m.id === c.mediaId)?.hasAudio))
    if (!hasAudio) return { error: 'Nothing with speech on the timeline yet.' }
    setTakesBusy('Mixing audio…')
    const scannedKey = speechKey()   // the line times below are only true for this speech
    try {
      const payload = mixPayload()
      const mix = await window.ipcRenderer.renderMixAudio({ clips: payload })
      if (mix.error || !mix.path) return { error: 'Takes: ' + (mix.error || 'could not prepare audio') }
      setTakesBusy('Reading speech…')
      // Word timings, not phrases: Whisper packs a false start and its retake into one segment
      // ("Say hello to VidHelm. Say hello to VidHelm, a free editor"), so we rebuild the lines
      // ourselves and split them where the speaker started over.
      const res = await window.ipcRenderer.transcribe(mix.path, { model: settings.caption.model, language: settings.caption.language, word: true })
      if (res.error) return { error: 'Takes: ' + res.error }
      const words = (res.chunks || [])
        .map(c => ({ start: c.start, end: c.end ?? c.start + 0.3, text: (c.text || '') }))
        .filter(w => w.text.trim() && w.end > w.start)
      const chunks = words.length
        ? chunksFromWords(words)
        : (res.chunks || []).map(c => ({ start: c.start, end: c.end ?? c.start + 2, text: (c.text || '').trim() })).filter(c => c.text && c.end > c.start)
      if (!chunks.length) return { error: 'No speech detected on the timeline.' }
      const groups = groupTakes(chunks)
      takeSnap.current = null
      takesAt.current = scannedKey
      const analysis: TakeAnalysis = { chunks, groups, drops: [], applied: false, scannedAt: new Date().toLocaleTimeString() }
      // the ref is what the agent path reads back, state has not re-rendered yet
      takesRef.current = analysis
      setTakes(analysis)
      return { groups: groups.length, lines: chunks.length, analysis }
    } catch (e) { console.error(e); return { error: 'Takes scan failed: ' + String(e) } }
    finally { setTakesBusy(null) }
  }

  // Apply the current choices. Cuts run last→first so earlier timestamps stay valid, exactly like
  // Cut Pauses. Re-applying is allowed only while the timeline still matches what we left behind,
  // otherwise a stale transcript would cut the wrong seconds.
  const applyTakes = (analysis: TakeAnalysis | null = takes): { error?: string; cuts?: number; seconds?: number } => {
    if (!analysis) return { error: 'Scan the timeline first.' }
    const ranges = removalRanges(analysis.chunks, analysis.groups, analysis.drops)
    if (!ranges.length) return { error: 'Nothing selected to cut.' }
    let baseClips = clips, baseTexts = texts, baseMarkers = markers
    const snap = takeSnap.current
    if (analysis.applied) {
      if (!snap || snap.after !== stateKey()) return { error: 'The timeline changed since these cuts were applied, re-scan to change takes.' }
      const before = JSON.parse(snap.before) as { c: TimelineClip[]; t: TextClip[]; m?: Marker[] }
      baseClips = before.c; baseTexts = before.t; baseMarkers = before.m || []
    } else if (takesAt.current !== speechKey()) {
      // the line times were read off different speech: cutting them now would remove other words
      return { error: 'The timeline changed since the scan (a cut, a moved or trimmed clip), so those lines are no longer where they were. Re-scan, then pick the takes again.' }
    }
    const beforeKey = JSON.stringify({ c: baseClips, t: baseTexts, m: baseMarkers })
    let nc = baseClips, nt = baseTexts, nm = baseMarkers
    for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
      const out = removeRange(nc, nt, r.start, r.end, settings.silence.smooth ? settings.silence.transition : 0, nm)
      nc = out.clips; nt = out.texts; nm = out.markers
    }
    setClips(nc); setTexts(nt); setMarkers(nm); setSelectedId(null)
    takeSnap.current = { before: beforeKey, after: JSON.stringify({ c: nc, t: nt, m: nm }) }
    setTakes({ ...analysis, applied: true })
    return { cuts: ranges.length, seconds: removedSeconds(ranges) }
  }

  const setTakeKeep = (groupIndex: number, member: number) => {
    setTakes(prev => prev ? { ...prev, groups: prev.groups.map((g, i) => i === groupIndex ? { ...g, keep: member } : g) } : prev)
  }
  const toggleTakeDrop = (index: number) => {
    setTakes(prev => {
      if (!prev) return prev
      const hit = prev.groups.findIndex(g => g.members.includes(index))
      // inside a group, "cut this one" means keep a different take instead
      if (hit >= 0) {
        const g = prev.groups[hit]
        if (g.keep !== index) return prev
        const other = g.members.find(m => m !== index)
        if (other === undefined) return prev
        return { ...prev, groups: prev.groups.map((x, i) => i === hit ? { ...x, keep: other } : x) }
      }
      const drops = prev.drops.includes(index) ? prev.drops.filter(d => d !== index) : [...prev.drops, index]
      return { ...prev, drops }
    })
  }

  // ---- voiceover ----
  const toggleRecord = async () => {
    if (isRecording) {
      recorderRef.current?.rec.stop()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      const startTime = currentTime
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setIsRecording(false)
        const blob = new Blob(chunks, { type: 'audio/webm' })
        let path: string
        try {
          const saved = await saveTake(blob, currentProject?.dir)
          path = saved.path
          if (saved.keptElsewhere) notify('The project folder could not be written, so the voiceover was kept in VidHelm’s own recordings folder. Save the project to move it in.', 11000)
        } catch (err) { notify(`The voiceover could not be saved: ${errText(err)}`, 11000); return }
        const metadata = await window.ipcRenderer.getMetadata(path)
        const media: MediaFile = { id: rid(), name: `Voiceover ${new Date().toLocaleTimeString()}`, path, type: 'audio', duration: metadata.duration || 1, hasVideo: false, hasAudio: true }
        setMediaBin(prev => [...prev, media])
        setClips(prev => [...prev, { id: rid(), mediaId: media.id, type: 'audio', trackId: 'a1', start: startTime, duration: media.duration, sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 }])
      }
      recorderRef.current = { rec, chunks, startTime }
      rec.start()
      setIsRecording(true)
    } catch (err) {
      console.error(err)
      notify('Could not access microphone.')
    }
  }

  // ---- export ----
  const pickExportPath = async () => {
    try { const p = await window.ipcRenderer.selectSavePath('vidhelm_export.mp4'); if (p) setCustomExportPath(p) } catch (e) { console.error(e) }
  }

  const handleExport = async () => {
    if (clips.length === 0 && texts.length === 0) return
    setIsPlaying(false)
    setExportProgress(0)
    setEta(null)
    exportStartRef.current = Date.now()
    try {
      // missing or removed media is named up front, rather than ffmpeg failing halfway through
      const pre = await exportPreflight()
      if (pre) { setExportProgress(null); notify(`Export not started. ${pre}`, 15000); return }
      let finalPath = customExportPath
      if (!finalPath) {
        finalPath = await window.ipcRenderer.selectSavePath('vidhelm_export.mp4')
        if (!finalPath) { setExportProgress(null); return }
        setCustomExportPath(finalPath)
      }
      const payload = {
        clips: exportClips(w, h, fps, exportQuality),
        texts,
        brand: settings.brand,
        audio: settings.audio,
        outputPath: finalPath,
        settings: { width: w, height: h, fps, quality: exportQuality, masterVolume },
      }
      exportStartRef.current = Date.now()
      await window.ipcRenderer.exportVideo(payload)
      setExportProgress(100)
      setLastExport(finalPath)
      setTimeout(() => setExportProgress(null), 3000)
      runQualityCheck(finalPath) // auto "watch & verify" the result
    } catch (err) {
      // never silent: the bar used to just vanish with no file and no reason. The toast gets the
      // reason; ffmpeg's last lines go to the log (DevTools console) for anyone digging deeper.
      const f = exportFailure(err)
      console.error('Export failed:', f.reason, f.detail ? '\n' + f.detail : '')
      setExportProgress(null); setEta(null)
      setLastExport(null)   // the old "Show in folder" would point at a missing or half-written file
      notify(exportFailureText(f), 15000)
    }
  }

  // ---- project folders ----
  // A workspace root holds one sub-folder per project. Opening a project pulls in whatever
  // media is sitting in that folder, so dropping files in with Explorer is the "import".
  const projectData = () => ({ version: 2, mediaBin, clips, texts, markers, orientation, resolution, fps, masterVolume, exportQuality })
  /** What goes into the file: the project's own folder and where each file sits inside it (so a
   *  copied or moved folder relinks itself on open), and nothing that only means something now. */
  const dataForSave = (dir: string | null) => {
    const d = projectData()
    return { ...d, savedAt: Date.now(), ...(dir ? { projectDir: dir } : {}),
      mediaBin: d.mediaBin.map(m => {
        const out: MediaFile = { ...m }
        delete out.proxyPct; delete out.offline; delete out.relPath
        const rel = dir ? relInside(dir, m.path) : null
        if (rel) out.relPath = rel
        return out
      }) }
  }

  // ---- unsaved changes ----
  // The document as last saved or loaded, as a key; "dirty" means the work differs from it. Checked
  // on a short debounce, like the undo history, so a drag is not re-serialised on every mouse move.
  const savedKeyRef = useRef<string>(docKeyOf({ mediaBin: [], clips: [], texts: [], markers: [], orientation: 'landscape', resolution: '1080p', fps: 30, masterVolume: 1, exportQuality: 'high' }))
  const docRef = useRef<DocFields | null>(null)
  const [dirty, setDirty] = useState(false)
  // true while one project is being swapped for another: the outgoing document must not be
  // autosaved (the human may have just said Don't save), nor filed under the incoming project
  const switching = useRef(false)
  // The handles that outlive a render (read by timers, the close prompt, keyboard and agent
  // commands) follow the latest committed state
  useEffect(() => {
    docRef.current = projectData()
    saveRef.current = saveProject
    setLiveDoc({ savedAt: 0, dir: currentProject?.dir ?? null, name: currentProject?.name ?? null, file: saveFile, data: docRef.current }, dirty && !switching.current)
  })
  /** Hold autosave for the length of a project switch. */
  const beginSwitch = () => { switching.current = true; setLiveDoc(liveDoc.current, false) }
  const endSwitch = () => { switching.current = false }
  const isDirty = () => !!docRef.current && docKeyOf(docRef.current) !== savedKeyRef.current
  /** This document is the new "nothing to save" point (null: restored work, unsaved until saved).
   *  After a save, recheck: anything edited while the save was in flight is still unsaved. */
  const markClean = (d: DocFields | null, recheck = false) => {
    savedKeyRef.current = d ? docKeyOf(d) : ''
    setDirty(recheck ? isDirty() : d === null)
  }
  useEffect(() => {
    const t = setTimeout(() => setDirty(isDirty()), 300)
    return () => clearTimeout(t)
  }, [mediaBin, clips, texts, markers, orientation, resolution, fps, masterVolume, exportQuality])
  // Autosave every 30 s and whenever the window loses focus, while there is something unsaved
  useEffect(() => {
    const iv = window.setInterval(autosaveNow, 30000)
    window.addEventListener('blur', autosaveNow)
    return () => { window.clearInterval(iv); window.removeEventListener('blur', autosaveNow) }
  }, [])
  // While anything is unsaved, closing or reloading the window is refused here, and the main
  // process turns that into a Save / Don't save / Cancel question (will-prevent-unload).
  useEffect(() => {
    if (!dirty) {
      window.onbeforeunload = null
      // back to the saved state (undone, or saved): an autosave this session wrote is now only an
      // older draft, and left there it would come back as "unsaved changes found"
      const dir = currentProject?.dir ?? null
      if (!switching.current && wroteSlots.has(autosaveKey(dir))) void clearAutosave(dir)
      return
    }
    window.onbeforeunload = (e: BeforeUnloadEvent) => {
      const a = liveDoc.current
      if (a) autosaveLocal({ ...a, savedAt: Date.now() })   // synchronous: there may be no time for an IPC round trip
      e.preventDefault(); e.returnValue = false
      return false
    }
    return () => { window.onbeforeunload = null }
  }, [dirty, currentProject?.dir])
  // The close question's Save button: save, then close for real. A failed or cancelled save keeps the window open.
  useEffect(() => {
    const h = async () => { if (await saveRef.current(false)) { window.onbeforeunload = null; setLiveDoc(liveDoc.current, false); window.close() } }
    window.ipcRenderer.on('save-before-close', h)
    return () => window.ipcRenderer.off('save-before-close', h)
  }, [])

  /** Before anything replaces the timeline: unsaved work gets Save / Don't save / Cancel. */
  const confirmLeave = async (what: string): Promise<boolean> => {
    if (!isDirty()) return true
    const name = currentProject?.name || (saveFile ? baseName(saveFile) : 'This project')
    const pick = await askChoice({ title: 'Unsaved changes', body: `${name} has changes that are not saved yet. Save them before ${what}?`,
      choices: [{ id: 'save', label: 'Save', primary: true }, { id: 'discard', label: "Don't save" }, { id: 'cancel', label: 'Cancel' }] })
    if (pick === 'save') return await saveProject()
    if (pick === 'discard') { await clearAutosave(currentProject?.dir ?? null); return true }
    return false
  }

  /** Anything computed from the project that was open: none of it may act on the next one. */
  const resetProjectScratch = () => {
    setTakes(null); takesRef.current = null; takeSnap.current = null; takesAt.current = null
    brollRef.current = null; brollPlanRef.current = null; speechRef.current = null; sfxHitsRef.current = null
  }

  /** Replace the whole document with a loaded one: format values checked (an unknown one keeps the
   *  current setting), undo history restarted. Returns the document as it now stands. */
  const applyProjectData = (data: any, bin?: MediaFile[]): DocFields => {
    const arr = <T,>(v: unknown): T[] => Array.isArray(v) ? v as T[] : []
    const mediaBin = bin ?? arr<MediaFile>(data?.mediaBin)
    // Projects saved before trims were held inside the footage can carry a negative in-point or a
    // clip running past its file's end: frozen in the preview, black and silent in the export.
    // Pulled back in here, once, for every way a project comes in.
    const lenOf = new Map(mediaBin.map(m => [m.id, footageLength(m)]))
    const doc: DocFields = {
      mediaBin,
      // (a still has no in-point to be wrong about)
      clips: arr<TimelineClip>(data?.clips).map(c => c && typeof c === 'object' && c.type !== 'image' ? clampToSource(c, lenOf.get(c.mediaId)) : c),
      texts: arr<TextClip>(data?.texts), markers: arr<Marker>(data?.markers),
      orientation: normOrientation(data?.orientation) ?? orientation,
      resolution: normResolution(data?.resolution) ?? resolution,
      fps: normFps(data?.fps) ?? fps,
      masterVolume: typeof data?.masterVolume === 'number' && Number.isFinite(data.masterVolume) ? data.masterVolume : masterVolume,
      exportQuality: data?.exportQuality === 'medium' || data?.exportQuality === 'high' ? data.exportQuality : exportQuality,
    }
    setIsPlaying(false)
    setMediaBin(doc.mediaBin); setClips(doc.clips); setTexts(doc.texts); setMarkers(doc.markers)
    setOrientation(doc.orientation); setResolution(doc.resolution); setFps(doc.fps)
    setMasterVolume(doc.masterVolume); setExportQuality(doc.exportQuality)
    setSelectedId(null); setCurrentTime(0)
    // a fresh undo history: Ctrl+Z must never bring back clips from the project that was open before
    skipRecord.current = true
    history.current = [{ clips: doc.clips, texts: doc.texts, markers: doc.markers }]
    histIndex.current = 0
    setCanUndo(false); setCanRedo(false)
    return doc
  }

  /** exists(path) for many paths, listing each folder once. scan-project lists the common media
   *  types; a file of another type counts as present unless its whole folder is gone. */
  const fileChecker = () => {
    const listings = new Map<string, Set<string> | null | undefined>()
    return async (p: string): Promise<boolean> => {
      if ((window as unknown as { __vhWeb?: boolean }).__vhWeb) return true
      const d = dirName(p), k = pathKey(d)
      if (!listings.has(k)) {
        const r = await window.ipcRenderer.scanProject(d).catch(() => null)
        listings.set(k, !r ? undefined : r.files ? new Set(r.files.map(f => pathKey(f.path))) : r.error ? null : undefined)
      }
      const list = listings.get(k)
      if (list === null) return false            // the folder itself is gone
      if (!list || !LISTED_EXT.has(extOf(p))) return true
      return list.has(pathKey(p))
    }
  }
  /** The bin entries whose files are gone. */
  const findMissing = async (items: MediaFile[]): Promise<MediaFile[]> => {
    const exists = fileChecker()
    const out: MediaFile[] = []
    for (const m of items) if (m.path && !(await exists(m.path))) out.push(m)
    return out
  }

  /** Point every saved bin entry at a file that exists, keeping its id so the clips stay linked:
   *  its place inside this folder (relPath), the same name in this folder when the project was
   *  copied or moved, the saved path, then a same-named file in the folder. What still cannot be
   *  found is marked offline (Relink in the Media panel) instead of leaving blank clips. */
  const resolveMedia = async (dir: string, project: any, files: { path: string; name: string }[]) => {
    const saved: MediaFile[] = (Array.isArray(project?.mediaBin) ? project.mediaBin : []).filter((m: MediaFile) => m && typeof m.path === 'string')
    const top = new Map(files.map(f => [pathKey(f.path), f.path]))
    const byName = new Map<string, string[]>()
    for (const f of files) { const k = f.name.toLowerCase(); byName.set(k, [...(byName.get(k) || []), f.path]) }
    const sameName = (p: string) => { const l = byName.get(baseName(p).toLowerCase()); return l && l.length === 1 ? l[0] : null }
    const moved = typeof project?.projectDir === 'string' && pathKey(project.projectDir) !== pathKey(dir)
    const exists = fileChecker()
    const has = async (p: string) => top.has(pathKey(p)) || await exists(p)
    const relinked = new Set<string>()   // ids now pointing at a different file than the save said
    const missing: string[] = []
    const bin: MediaFile[] = []
    for (const m of saved) {
      const rel = typeof m.relPath === 'string' && m.relPath ? joinPath(dir, m.relPath) : null
      let p: string | null
      if (rel && await has(rel)) p = top.get(pathKey(rel)) ?? rel
      else if (moved && sameName(m.path)) p = sameName(m.path)
      else if (await has(m.path)) p = m.path
      else p = sameName(m.path)
      const e: MediaFile = { ...m }
      delete e.relPath; delete e.proxyPct
      if (!p) { e.offline = true; missing.push(m.name) }
      else {
        delete e.offline
        if (pathKey(p) !== pathKey(m.path)) { e.path = p; delete e.proxyPath; delete e.proxyWidth; delete e.proxyHeight; delete e.proxyFps; relinked.add(e.id) }
      }
      bin.push(e)
    }
    return { bin, relinked, missing }
  }

  /** Probe files found in a folder and turn the usable ones into bin entries (HDR flag included). */
  const probeNewFiles = async (fresh: { path: string; name: string }[], probes: Map<string, Probe>) => {
    const added: MediaFile[] = []
    for (const f of fresh) {
      const meta = await window.ipcRenderer.getMetadata(f.path).catch(() => null)
      const verdict = classifyMedia(f.name, meta)
      if ('reject' in verdict) continue
      const entry = mediaFromProbe(f.name, f.path, verdict.type, meta as Probe)
      probes.set(entry.id, meta as Probe)
      added.push(entry)
    }
    return added
  }

  /** Restored footage: re-probe only what is missing something (the HDR flag or frame rate an older
   *  save lacks, a preview copy with no size, or a copy that was needed and is gone) and hand it to
   *  ensureProxies, which re-finds a cached copy with its real size or rebuilds a lost one. Ordinary
   *  footage that never needed a copy is not probed again on every open. `recheck` names entries
   *  that now point at a different file (relinked), which are always looked at afresh. */
  const backfillMedia = async (items: MediaFile[], recheck: Set<string> | 'all' = new Set()) => {
    const needs = (m: MediaFile) => recheck === 'all' || recheck.has(m.id) || m.hdr === undefined || m.fps === undefined
      || (m.proxyPath ? !(m.proxyWidth && m.proxyHeight && m.proxyFps) : !!m.proxyNote)   // proxyNote without a copy: it was needed (lost, or the build failed)
    const vids = items.filter(m => m.type === 'video' && !m.offline && needs(m))
    if (!vids.length) return
    const probes = new Map<string, Probe>()
    const fill: Record<string, Partial<MediaFile>> = {}
    for (const m of vids) {
      const meta = await window.ipcRenderer.getMetadata(m.path).catch(() => null)
      if (!meta || meta.ok === false) continue
      probes.set(m.id, meta as Probe)
      fill[m.id] = { hdr: isHdr({ colorTransfer: meta.colorTransfer }), ...(meta.fps ? { fps: meta.fps } : {}) }
    }
    if (Object.keys(fill).length) setMediaBin(prev => prev.map(x => fill[x.id] ? { ...x, ...fill[x.id] } : x))
    await ensureProxies(vids.filter(m => probes.has(m.id)), probes)
  }

  const refreshProjects = async (root: string | null) => {
    if (!root) { setProjects([]); return }
    const r = await window.ipcRenderer.listProjects(root)
    if (r.projects) setProjects(r.projects)
    else { setProjects([]); if (r.error) notify(`Project folder: ${r.error}`) }
  }
  useEffect(() => { refreshProjects(settings.workspace.root) }, [settings.workspace.root])   // eslint-disable-line react-hooks/exhaustive-deps

  /** Switch to a project folder. This replaces the whole document, so unsaved work is asked about
   *  first (skipConfirm when the caller already did). An autosave newer than the folder's save is
   *  offered back. askRecover: false (an agent opening it) does not answer that for the human: it
   *  opens nothing and returns the autosave as `unsaved`, still in place for when they open it. */
  const openProjectFolder = async (dir: string, name: string, opts: { skipConfirm?: boolean; recover?: Autosave; askRecover?: boolean } = {}): Promise<{ unsaved?: Autosave } | null> => {
    if (!opts.skipConfirm && !(await confirmLeave(`opening ${name}`))) return null
    beginSwitch()
    try {
      const r = await window.ipcRenderer.scanProject(dir)
      if (r.error) { notify(`Could not open ${name}: ${r.error}`); return null }

      let project = r.project
      let recovered = false
      const auto = opts.recover ?? await readAutosave(dir)
      if (auto?.data && (opts.recover || auto.savedAt > (Number(r.project?.savedAt) || 0))) {
        if (!opts.recover && opts.askRecover === false) return { unsaved: auto }
        const answer = opts.recover ? 'restore'
          : await askChoice({ title: 'Unsaved changes found', body: `${name} has changes from ${new Date(auto.savedAt).toLocaleString()} that were never saved. Restore them?`,
              choices: [{ id: 'restore', label: 'Restore', primary: true }, { id: 'discard', label: 'Discard them' }] })
        if (answer === 'restore') { project = auto.data; recovered = true }
        else if (answer === 'discard') await clearAutosave(dir)
        else return null   // the question was swept away by another one: open nothing, lose nothing
      } else if (auto) void clearAutosave(dir)   // older than the save: nothing in it is lost

      // a saved timeline in the folder wins; otherwise start clean with the folder's media.
      // Paths are resolved first: a moved or copied folder relinks itself, lost files are flagged.
      const files = r.files || []
      const res = project ? await resolveMedia(dir, project, files) : { bin: [] as MediaFile[], relinked: new Set<string>(), missing: [] as string[] }
      resetProjectScratch()
      setCurrentProject({ dir, name }); setSaveFile(null)
      try { localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify({ dir, name })) } catch { /* fine */ }
      const doc = applyProjectData(project || {}, res.bin)
      // clean (or, for restored work, unsaved) from this moment, before the probing below takes its time
      if (recovered) markClean(null)
      else markClean(doc)
      let added: MediaFile[] = []
      const probes = new Map<string, Probe>()
      if (settings.workspace.autoLoad) {
        // pull in everything in the folder that isn't already in the bin (by where entries resolved to)
        const known = new Set(res.bin.map(m => pathKey(m.path)))
        added = await probeNewFiles(files.filter(f => !known.has(pathKey(f.path))), probes)
        if (added.length) {
          setMediaBin(prev => [...prev, ...added])
          // the folder's own files are not unsaved work (unless the human already started editing)
          if (!recovered && !isDirty()) markClean({ ...doc, mediaBin: [...doc.mediaBin, ...added] })
        }
      }
      // preview copies for what just arrived (phone HEVC/HDR plays black without one), plus the
      // HDR flag and copy size for restored entries saved before those were kept
      void ensureProxies(added, probes)
      void backfillMedia(res.bin, res.relinked)
      const bits = [
        added.length ? `${added.length} new file${added.length > 1 ? 's' : ''} in the Media Bin` : settings.workspace.autoLoad ? 'no new media in the folder' : '',
        project ? (recovered ? 'unsaved changes restored' : 'timeline restored') : '',
        res.relinked.size ? `${res.relinked.size} moved file${res.relinked.size > 1 ? 's' : ''} relinked` : '',
        res.missing.length ? `${res.missing.length} file${res.missing.length > 1 ? 's' : ''} missing (marked offline in the Media Bin: right-click to relink)` : '',
      ].filter(Boolean)
      notify(`${name}${bits.length ? ' - ' + bits.join(', ') : ''}.`, res.missing.length ? 11000 : 7000)
      return {}
    } finally { endSwitch() }
  }

  /** ↻: bring in files added to the open project's folder. Adds to the Media Bin and touches nothing
   *  else; the timeline, texts and tags stay as they are. (It used to reopen the whole project from
   *  disk, replacing unsaved work with the last save, or with nothing at all.) */
  const [rescanning, setRescanning] = useState(false)
  const rescanProjectFolder = async () => {
    const p = currentProject
    if (!p || rescanning) return
    setRescanning(true)
    try {
      const r = await window.ipcRenderer.scanProject(p.dir)
      if (r.error) { notify(`Could not rescan ${p.name}: ${r.error}`); return }
      const known = new Set(mediaBin.map(m => pathKey(m.path)))
      const probes = new Map<string, Probe>()
      const added = await probeNewFiles((r.files || []).filter(f => !known.has(pathKey(f.path))), probes)
      // offline entries whose file is there again (copied back, the drive reconnected) come back online
      const offline = mediaBin.filter(m => m.offline)
      const gone = new Set((await findMissing(offline)).map(m => m.id))
      const back = offline.filter(m => !gone.has(m.id))
      if (added.length || back.length) {
        setMediaBin(prev => [...prev.map(x => back.some(b => b.id === x.id) ? { ...x, offline: undefined } : x),
          ...added.filter(m => !prev.some(x => pathKey(x.path) === pathKey(m.path)))])
        if (added.length) void ensureProxies(added, probes)
        if (back.length) void backfillMedia(back.map(m => ({ ...m, offline: undefined })))
      }
      notify([added.length ? `${added.length} new file${added.length > 1 ? 's' : ''} from ${p.name} added to the Media Bin.` : `No new files in ${p.name}.`,
        back.length ? `${back.length} missing file${back.length > 1 ? 's are' : ' is'} back.` : ''].filter(Boolean).join(' '))
    } finally { setRescanning(false) }
  }

  /** Relink: point an offline bin entry at the file's new home, then match any other offline
   *  entries by name in that same folder. Ids stay, so their clips come back. */
  const relinkMedia = async (media: MediaFile) => {
    const exts = [...new Set([extOf(media.path), ...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT])].filter(Boolean)
    const picked = await window.ipcRenderer.pickFile({ title: `Where is ${media.name}?`, extensions: exts })
    if (!picked) return
    const r = await window.ipcRenderer.scanProject(dirName(picked)).catch(() => null)
    const there = new Map((r?.files || []).map(f => [f.name.toLowerCase(), f.path]))
    const moves = new Map<string, string>([[media.id, picked]])
    for (const m of mediaBin) if (m.offline && m.id !== media.id) { const hit = there.get(baseName(m.path).toLowerCase()); if (hit) moves.set(m.id, hit) }
    const moved = mediaBin.filter(m => moves.has(m.id))
      .map(m => ({ ...m, path: moves.get(m.id)!, offline: undefined, proxyPath: undefined, proxyWidth: undefined, proxyHeight: undefined, proxyFps: undefined }))
    setMediaBin(prev => prev.map(m => moved.find(x => x.id === m.id) ?? m))
    notify(`Relinked ${moved.length} file${moved.length > 1 ? 's' : ''}. Save to keep the new location${moved.length > 1 ? 's' : ''}.`)
    void backfillMedia(moved, 'all')   // possibly a different file: its HDR flag, frame rate and preview copy are found afresh
  }

  /** Remove from the bin. Clips still using it would export as nothing, so they go too (after asking). */
  const removeFromBin = async (media: MediaFile) => {
    const using = clips.filter(c => c.mediaId === media.id).length
    if (using) {
      const pick = await askChoice({ title: 'Remove from the Media Bin?', body: `${using} clip${using > 1 ? 's' : ''} on the timeline use${using > 1 ? '' : 's'} ${media.name}. Removing it takes ${using > 1 ? 'those clips' : 'that clip'} off the timeline too. The file itself is not touched.`,
        choices: [{ id: 'both', label: 'Remove both', primary: true }, { id: 'cancel', label: 'Cancel' }] })
      if (pick !== 'both') return
      setClips(prev => prev.filter(c => c.mediaId !== media.id))
      if (clips.some(c => c.id === selectedId && c.mediaId === media.id)) setSelectedId(null)
    }
    setMediaBin(prev => prev.filter(m => m.id !== media.id))
  }

  /** Generate a video clip with the AI harness and land it in the bin (and at the end of v1 unless place=false). */
  const generateAiClip = async (o: { prompt: string; fromPath?: string; fromTime?: number; toPath?: string; toTime?: number; seconds?: number; model?: string; place?: boolean }) => {
    const outDir = currentProject?.dir || settings.workspace.root
    if (!outDir) return { error: 'Open or create a project folder first, so the clip has a home.' }
    // every generation is paid for: one at a time, and a retry while one runs is refused, not bought
    if (busyRef.current.aiClip) return { error: 'An AI clip is already being generated. Wait for it to land in the Media Bin (get_state shows it) rather than starting another.' }
    busyRef.current.aiClip = true; setAiClipBusy(true)
    try {
      const r = await window.ipcRenderer.genClip({ prompt: o.prompt, fromPath: o.fromPath, fromTime: o.fromTime, toPath: o.toPath, toTime: o.toTime, seconds: o.seconds, aspect: orientation, model: o.model, keys: { fal: settings.aiGen?.falKey, gemini: settings.aiGen?.geminiKey }, outDir })
      // stillRunning: the provider may still finish the job (and bill it), so it must not be resubmitted
      if (r.error || !r.path) return { error: r.error || 'generation failed', ...(r.stillRunning ? { stillRunning: true } : {}) }
      const meta = await window.ipcRenderer.getMetadata(r.path).catch(() => null)
      const verdict = classifyMedia(r.path, meta)
      if ('reject' in verdict) return { error: `generated a file the app cannot read: ${verdict.reject}` }
      const m = meta as Probe
      // The same file may already be in the bin: the main process hands an identical request that
      // overlaps a running one (a retry from another client, a reload) the SAME file. Reuse that
      // entry rather than adding a second one. docRef is the bin as last drawn; with one generation
      // at a time (above) nothing can land in between.
      const key = pathKey(r.path)
      const prevId = docRef.current?.mediaBin.find(x => pathKey(x.path) === key)?.id
      let media = mediaFromProbe(baseName(r.path) || 'ai-clip.mp4', r.path, 'video', m, { duration: m.duration || r.seconds || 5, hasVideo: true, hasAudio: !!m.hasAudio })
      if (prevId) media = { ...media, id: prevId }
      else {
        setMediaBin(prev => [...prev, media])
        void ensureProxies([media], new Map([[media.id, m]]))
      }
      if (o.place !== false) {
        // the end of v1 as it is NOW (the generation took minutes and the timeline moved on), once
        setClips(prev => {
          if (prev.some(c => c.mediaId === media.id)) return prev
          const track = prev.filter(c => c.trackId === 'v1')
          const at = track.length ? Math.max(...track.map(c => c.start + c.duration)) : 0
          return [...prev, { id: rid(), mediaId: media.id, type: 'video', trackId: 'v1', start: at, duration: media.duration, sourceStart: 0, volume: r.hasAudio ? 1 : 0, fadeIn: 0, fadeOut: 0 }]
        })
      }
      return { ok: true, mediaId: media.id, path: r.path, model: r.model, seconds: r.seconds, hasAudio: r.hasAudio, estimateUsd: r.estimateUsd, ...(prevId ? { alreadyInBin: true } : {}) }
    } finally { busyRef.current.aiClip = false; setAiClipBusy(false) }
  }
  /** The frame under the playhead: which v1 clip, which source time. */
  const frameUnderPlayhead = () => {
    const hit = clips.filter(c => c.trackId === 'v1' && currentTime >= c.start && currentTime < c.start + c.duration).pop()
    if (!hit) return null
    const media = mediaBin.find(m => m.id === hit.mediaId); if (!media) return null
    return { path: media.path, time: media.type === 'image' ? 0 : hit.sourceStart + (currentTime - hit.start) }
  }

  const importCloudZip = async (zipPath?: string) => {
    const root = settings.workspace.root
    if (!root) { notify('Set a workspace folder in Settings first, then import the cloud zip.'); return }
    if (!(await confirmLeave('importing a cloud project'))) return
    beginSwitch()   // the download can take a while: the outgoing work is not autosaved meanwhile
    let target: { path: string; name: string; summary: string } | null = null
    try {
      notify('Importing the cloud hand-off: unpacking, downloading clips and drafts…')
      const r = await window.ipcRenderer.importCloudZip({ root, zipPath })
      if (r.cancelled) return
      if (r.error || !r.path) { notify(`Import failed: ${r.error || 'unknown error'}`); return }
      await refreshProjects(root)
      target = { path: r.path, name: r.name || 'Cloud project',
        summary: `Imported ${r.name}: ${r.clips} clip${r.clips === 1 ? '' : 's'} downloaded, ${r.timeline} item${r.timeline === 1 ? '' : 's'} on the timeline${r.failed?.length ? `, ${r.failed.length} download${r.failed.length === 1 ? '' : 's'} failed (see NOTES.md)` : ''}.` }
    } finally { endSwitch() }
    await openProjectFolder(target.path, target.name, { skipConfirm: true })
    notify(target.summary)
  }

  const newProjectFolder = async () => {
    const root = settings.workspace.root
    if (!root) return
    if (!(await confirmLeave('starting a new project'))) return
    beginSwitch()
    try {
      const name = `Project ${new Date().toISOString().slice(0, 10)}`
      const r = await window.ipcRenderer.createProject({ root, name })
      if (r.error || !r.path) { notify(`Could not create the project: ${r.error || 'unknown error'}`); return }
      await refreshProjects(root)
      resetProjectScratch()
      setCurrentProject({ dir: r.path, name: r.name || name }); setSaveFile(null)
      try { localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify({ dir: r.path, name: r.name || name })) } catch { /* fine */ }
      markClean(applyProjectData({}, []))   // a clean start, with a clean undo history
      notify(`Created ${r.name}. Drop footage into that folder and press ↻ to bring it in, no import needed.`)
      window.ipcRenderer.revealFolder(r.path)
    } finally { endSwitch() }
  }

  /** Save to wherever this project lives: its folder, or the file it came from; the first time, a
   *  file the human picks. Save As (as = true) writes a COPY to a picked file and changes nothing
   *  else: Save still writes where it did, and what is unsaved there stays unsaved. (With nowhere
   *  to save yet, the picked file becomes that place.) Returns whether the project was saved. */
  const saveProject = async (as = false): Promise<boolean> => {
    try {
      if (currentProject && !as) {
        const dir = currentProject.dir
        const data = dataForSave(dir)
        const r = await window.ipcRenderer.saveProjectTo({ dir, data })
        if (!r.path) { notify(`Save failed: ${r.error || 'unknown error'}`, 11000); return false }
        // takes recorded before the project had a folder (or while it could not be written) are
        // copied into <project>/voice by the main process, which also gave them their relPath in
        // the saved file; follow them there, so the bin and the saved file agree
        const moved = r.moved || []
        const follow = (m: MediaFile) => { const hit = moved.find(x => pathKey(x.from) === pathKey(m.path)); return hit ? { ...m, path: hit.to } : m }
        notify(`Saved into ${currentProject.name}.${moved.length ? ` ${moved.length} recording${moved.length > 1 ? 's were' : ' was'} copied into its voice folder.` : ''}`)
        refreshProjects(settings.workspace.root)
        if (moved.length) { setMediaBin(prev => prev.map(follow)); markClean({ ...data, mediaBin: data.mediaBin.map(follow) }) }
        else markClean(data, true)
        void clearAutosave(dir)
        return true
      }
      const data = dataForSave(null)
      if (saveFile && !as) {
        // back into the file it was opened from; a main process without that handler asks instead
        const r = await optionalInvoke('save-project-file', { path: saveFile, data })
        if (r?.path) { notify(`Saved ${baseName(r.path)}.`); markClean(data, true); void clearAutosave(null); return true }
        if (r?.error) { notify(`Save failed: ${r.error}`, 11000); return false }
      }
      const p = await window.ipcRenderer.saveProject(data)
      if (!p) return false
      // Save As picked the folder's own save file: that is a normal save, written the folder's way
      if (as && currentProject && pathKey(p) === pathKey(joinPath(currentProject.dir, 'project.vidhelm.json'))) return await saveProject(false)
      // Save As with somewhere to save already: a copy. The project, its Save target and its
      // unsaved state are left exactly as they were
      if (as && (currentProject || (saveFile && pathKey(saveFile) !== pathKey(p)))) {
        notify(`Saved a copy as ${baseName(p)}. Save still writes ${currentProject ? `into ${currentProject.name}` : `to ${baseName(saveFile!)}`}.`, 9000)
        return true
      }
      setSaveFile(p)
      notify(`Saved ${baseName(p)}.`)
      markClean(data, true); void clearAutosave(null)
      return true
    } catch (e) { console.error(e); notify(`Save failed: ${errText(e)}`, 11000); return false }
  }

  const loadProject = async () => {
    try {
      const res = await window.ipcRenderer.loadProject()
      if (!res) return
      // newer main processes say which file it was ({ data, path }); older ones hand back the project itself
      const file: string | null = typeof res.path === 'string' && res.data && typeof res.data === 'object' ? res.path : null
      const data = file ? res.data : res
      // a project folder's own save file: open that folder properly, so Save writes back into it
      if (file && baseName(file).toLowerCase() === 'project.vidhelm.json') { const dir = dirName(file); await openProjectFolder(dir, baseName(dir)); return }
      if (!(await confirmLeave('opening that project'))) return
      resetProjectScratch()
      // Not a folder project any more: Save goes to this file (or asks, when the file is unknown),
      // never into the folder that was open before
      setCurrentProject(null)
      setSaveFile(file)
      const doc = applyProjectData(data)
      markClean(doc)
      notify(file ? `Opened ${baseName(file)}.` : 'Opened the project. The first Save asks where to keep it.')
      void backfillMedia(doc.mediaBin)
      const miss = await findMissing(doc.mediaBin)
      if (miss.length) {
        setMediaBin(prev => prev.map(x => miss.some(m => m.id === x.id) ? { ...x, offline: true } : x))
        notify(`${miss.length} file${miss.length > 1 ? 's' : ''} in this project ${miss.length > 1 ? 'are' : 'is'} missing (marked offline in the Media Bin: right-click to relink).`, 11000)
      }
    } catch (e) { console.error(e); notify(`Could not open that project: ${errText(e)}`) }
  }

  // Unsaved work from a session that ended without saving (a crash, a power cut, Don't save):
  // offered back once, at startup. The project folder's own copy is offered again when it opens.
  // This session starts untitled and autosaves into the untitled slot, so untitled work from the
  // last session is moved to a pending slot first: "Not now" then really means later.
  useEffect(() => {
    if ((window as unknown as { __vhWeb?: boolean }).__vhWeb) return
    let alive = true
    void (async () => {
      let last: { dir?: string; name?: string } | null = null
      try { last = JSON.parse(localStorage.getItem(LAST_PROJECT_KEY) || 'null') } catch { /* none */ }
      const [inDir, untitled] = await Promise.all([last?.dir ? readAutosave(last.dir) : Promise.resolve(null), readAutosave(null)])
      // kind: where it lives now ('pending' only goes when Restore or Discard says so)
      type Found = { a: Autosave; kind: 'dir' | 'live' | 'pending' }
      const found: Found[] = inDir?.data ? [{ a: inDir, kind: 'dir' }] : []
      if (untitled?.data) found.push({ a: untitled, kind: (await setAsideAutosave(untitled)) ? 'pending' : 'live' })
      for (const a of readPending(null)) if (!found.some(f => f.kind === 'pending' && f.a.savedAt === a.savedAt)) found.push({ a, kind: 'pending' })
      const pick = found.sort((x, y) => y.a.savedAt - x.a.savedAt)[0]
      if (!alive || !pick) return
      const p = pick.a
      const where = p.dir ? (p.name || baseName(p.dir)) : p.file ? baseName(p.file) : 'an untitled project'
      // work that could not be set aside would be overwritten by this session, so there is no "later" for it
      const choice = await askChoice({ title: 'Restore unsaved work?', body: `VidHelm closed with unsaved changes in ${where} (from ${new Date(p.savedAt).toLocaleString()}). Restore them?`,
        choices: [{ id: 'restore', label: 'Restore', primary: true }, ...(pick.kind === 'live' ? [] : [{ id: 'later', label: 'Not now' }]), { id: 'discard', label: 'Discard them' }] })
      if (choice === 'discard') { if (pick.kind === 'pending') dropPending(p); else await clearAutosave(p.dir); return }
      if (choice !== 'restore') return
      if (p.dir) { await openProjectFolder(p.dir, p.name || baseName(p.dir), { skipConfirm: true, recover: p }); return }
      resetProjectScratch(); setCurrentProject(null); setSaveFile(p.file)
      const doc = applyProjectData(p.data)
      markClean(null)   // restored work stays unsaved until it is saved
      // back in the live slot before its pending copy goes, so a crash right now still loses nothing
      if (pick.kind === 'pending') { await writeAutosave({ ...p, dir: null }); dropPending(p) }
      notify('Restored your unsaved work. Save it to keep it.')
      void backfillMedia(doc.mediaBin)
    })()
    return () => { alive = false }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- generic drags on timeline ----
  // Where a dragged edge may snap: 0, the playhead, tag points, and both edges of every other clip
  // and text on every row. Taken once when the drag starts, so it cannot snap to itself.
  const snapTargetsFor = (excludeId: string) =>
    collectSnapTargets([...clips, ...texts], excludeId, [0, currentTime, ...markers.map(mk => mk.t)])
  const flashLimit = (id: string, side: 'left' | 'right') => {
    setLimitHit({ id, side })
    clearTimeout(limitTimer.current)
    limitTimer.current = window.setTimeout(() => setLimitHit(null), 300)
  }
  /** Mouse listeners for one drag; `done` runs on release. */
  const trackDrag = (move: (m: MouseEvent) => void, done?: () => void) => {
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setDrag(null); done?.() }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  // Move a clip or a title/caption along the timeline. Nothing moves until the pointer has gone a
  // few pixels, so a plain click selects, a double-click on text still opens typing, and snapping
  // cannot hop an item onto the playhead from a click.
  const startMove = (e: React.MouseEvent, kind: 'clip' | 'text', id: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelectedId(id)
    const clip = kind === 'clip' ? clips.find(c => c.id === id) : undefined
    const text = kind === 'text' ? texts.find(t => t.id === id) : undefined
    const it = clip ?? text
    if (!it) return
    const startX = e.clientX
    const origStart = it.start
    draggingRef.current = false
    // Up or down moves a clip between the rows it may live on: picture between video and b-roll,
    // sound between voice/music and SFX. The row under the pointer says which. Text has one row.
    const isAudio = clip?.type === 'audio'
    let track = clip?.trackId
    const targets = snapTargetsFor(id)
    // a caption carries its words with it, so moving it takes them off the speech they were heard
    // at; the readout says by how much, from where it sat the first time it was grabbed
    if (text?.caption && !capHeardAt.current.has(id)) capHeardAt.current.set(id, text.start)
    const heardAt = text?.caption ? capHeardAt.current.get(id) : null
    const rowAt = (m: MouseEvent) => (document.elementFromPoint(m.clientX, m.clientY) as HTMLElement | null)?.closest('[data-track]')?.getAttribute('data-track') as TimelineClip['trackId'] | undefined
    const move = (m: MouseEvent) => {
      const dx = m.clientX - startX
      if (Math.abs(dx) > 3) draggingRef.current = true
      const row = clip ? rowAt(m) : undefined
      if (row && row !== track && (isAudio ? row === 'a1' || row === 'a2' : row === 'v1' || row === 'v2')) { track = row; draggingRef.current = true }
      if (!draggingRef.current) return
      // either edge snaps (Alt drags freely); the guide shows which time it caught
      const r = m.altKey ? { start: Math.max(0, origStart + dx / pxPerSec), line: null } : snapMove(origStart + dx / pxPerSec, it.duration, targets, SNAP_PX / pxPerSec)
      if (clip) setClips(prev => prev.map(c => c.id === id ? { ...c, start: r.start, trackId: track ?? c.trackId } : c))
      else setTexts(prev => prev.map(t => t.id === id ? { ...t, start: r.start } : t))
      const note = offSpeechNote(r.start, heardAt)
      setDrag({ id, snap: r.line, hud: { x: m.clientX, y: m.clientY, text: moveReadout(r.start, origStart) + (note ? ' · ' + note : '') } })
    }
    trackDrag(move, () => setTimeout(() => { draggingRef.current = false }, 0))
  }

  // Drag one edge of a clip or a title/caption. Footage stops at the ends of its file; stills,
  // titles and captions have no such edge.
  const startTrim = (e: React.MouseEvent, kind: 'clip' | 'text', id: string, side: 'left' | 'right') => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelectedId(id)
    const clip = kind === 'clip' ? clips.find(c => c.id === id) : undefined
    const text = kind === 'text' ? texts.find(t => t.id === id) : undefined
    const o = clip ?? text
    if (!o) return
    const startX = e.clientX
    const media = clip ? mediaBin.find(m => m.id === clip.mediaId) : undefined
    const opts = clip
      ? { hasSource: media?.type !== 'image', sourceDuration: footageLength(media), minDuration: 0.3 }
      : { hasSource: false, minDuration: 0.2 }
    const targets = snapTargetsFor(id)
    const edge0 = side === 'left' ? o.start : o.start + o.duration
    let live = false
    let lastStart = o.start
    const move = (m: MouseEvent) => {
      // the same small dead zone as a move, so pressing a handle cannot snap its edge somewhere
      if (!live && Math.abs(m.clientX - startX) <= 2) return
      live = true
      const raw = edge0 + (m.clientX - startX) / pxPerSec
      const caught = m.altKey ? null : nearestTarget(raw, targets, SNAP_PX / pxPerSec)
      const r = trimTo(o, side, caught ?? raw, opts)
      const edge = side === 'left' ? r.start : r.start + r.duration
      lastStart = r.start
      if (clip) setClips(prev => prev.map(c => c.id === id ? { ...c, start: r.start, duration: r.duration, sourceStart: r.sourceStart } : c))
      // a caption's words keep their spoken times when its start moves (they count from the start)
      else setTexts(prev => prev.map(t => t.id === id ? { ...t, start: r.start, duration: r.duration, ...(text!.caption ? { caption: { ...text!.caption, words: shiftWords(text!.caption.words, r.start - text!.start) } } : {}) } : t))
      // the guide only when the edge really sits on the target (a wall may have stopped it short)
      setDrag({ id, snap: caught !== null && Math.abs(edge - caught) < 1e-6 ? caught : null, hud: { x: m.clientX, y: m.clientY, text: trimReadout(r.duration, o.duration, r.limit) } })
      if (r.limit) flashLimit(id, side)
    }
    // a trimmed caption is as far off its speech as before: its first-grab position moves with the start
    trackDrag(move, () => { const h = capHeardAt.current.get(id); if (h !== undefined) capHeardAt.current.set(id, h + (lastStart - o.start)) })
  }

  const startResizeTimeline = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const orig = timelineH
    const move = (m: MouseEvent) => setTimelineH(clamp(orig + (startY - m.clientY), 140, 560))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  // drag a text overlay on the stage
  const startTextDrag = (e: React.MouseEvent, t: TextClip) => {
    e.stopPropagation()
    setSelectedId(t.id)
    if (!stageRef.current) return
    const rect = stageRef.current.getBoundingClientRect()
    const move = (m: MouseEvent) => {
      const nx = clamp((m.clientX - rect.left) / rect.width, 0, 1)
      const ny = clamp((m.clientY - rect.top) / rect.height, 0, 1)
      setTexts(prev => prev.map(x => x.id === t.id ? { ...x, x: nx, y: ny } : x))
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  const onTimelineClick = (e: React.MouseEvent) => {
    // A press on a clip selects it on mousedown; the click that follows bubbles up to here, and used
    // to clear that selection again straight away (so Split never lit up from a click). Clicks on a
    // clip, a row label or a tag belong to them: only empty lane space seeks and deselects.
    if ((e.target as HTMLElement).closest('.clip, .track-label, .marker-flag')) return
    if (draggingRef.current || scrubbing) return
    setCurrentTime(timeAtClientX(e.clientX))
    setSelectedId(null)
  }

  // ---- scrubbing ----
  // Press the ruler (or grab the playhead) and drag. Pointer capture keeps the drag alive
  // even when the cursor leaves the ruler, and rAF coalescing keeps seeking smooth.
  const seekTo = (clientX: number) => setCurrentTime(clamp(timeAtClientX(clientX), 0, Math.max(totalDuration, 0)))
  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()                       // no text selection while dragging
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* older pointer impls */ }
    setIsPlaying(false)
    setScrubbing(true)
    seekTo(e.clientX)
  }
  const moveScrub = (e: React.PointerEvent) => {
    if (!scrubbing) return
    const x = e.clientX
    cancelAnimationFrame(scrubRaf.current)
    scrubRaf.current = requestAnimationFrame(() => seekTo(x))
  }
  const endScrub = (e: React.PointerEvent) => {
    if (!scrubbing) return
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* already released */ }
    cancelAnimationFrame(scrubRaf.current)
    seekTo(e.clientX)
    setScrubbing(false)
  }
  const scrubHandlers = { onPointerDown: startScrub, onPointerMove: moveScrub, onPointerUp: endScrub, onPointerCancel: endScrub }
  // The same handlers with a fixed identity for the memoised ruler, which would otherwise redraw
  // every tick on every playback frame. They call through to this render's versions.
  const scrubLive = useRef(scrubHandlers)
  scrubLive.current = scrubHandlers
  const rulerHandlers = useMemo(() => ({
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => scrubLive.current.onPointerDown(e),
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => scrubLive.current.onPointerMove(e),
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => scrubLive.current.onPointerUp(e),
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => scrubLive.current.onPointerCancel(e),
  }), [])

  const patchClip = (patch: Partial<TimelineClip>) => setClips(prev => prev.map(c => c.id === selectedId ? { ...c, ...patch } : c))
  const patchText = (patch: Partial<TextClip>) => setTexts(prev => prev.map(t => t.id === selectedId ? { ...t, ...patch } : t))

  /** One place that knows how to bring up each panel: Help, the tour and the help chat all use it. */
  const openPanel = (p: HelpPanel | HelpAction) => {
    if (p === 'media' || p === 'sfx') { setExpanded(false); setSidebarTab(p) }
    else if (p === 'booth') setShowBooth(true)
    else if (p === 'narration') setShowNarration(true)
    else if (p === 'thumbnail') setShowThumbnail(true)
    else if (p === 'settings') setShowSettings(true)
    else if (p === 'connect') setShowConnect(true)
    else if (p === 'model3d') { setModel3DPath(null); setShowModel3D(true) }
    else if (p === 'takes') setShowTakes(true)
    else if (p === 'aiclip') setShowAiClip(true)
    else if (p === 'tour') { setShowChat(false); setShowTour(true) }
    else if (p === 'export' || p === 'tags') { setExpanded(false); setRightTab(p) }
  }

  // ---- render ----
  // The ruler (src/ruler.tsx) picks a tick spacing that leaves room for its labels; the lanes span
  // the same width it does, so backgrounds, drops and the scrub area reach past the last clip.
  const tlWidth = contentWidth(totalDuration, pxPerSec, tlView.w, tickStepFor(pxPerSec))

  const renderClip = (c: TimelineClip) => {
    const media = mediaBin.find(m => m.id === c.mediaId)
    let bg: string | undefined
    let bgSize = '100% 100%'
    if ((c.trackId === 'v1' || c.trackId === 'v2') && media && !media.offline) {
      if (media.type === 'image') { bg = `url("${fileUrl(media.path)}")`; bgSize = 'cover' }
      else if (thumbs[c.id]?.path) bg = `url("${fileUrl(thumbs[c.id].path)}")`
    }
    const lost = !media || media.offline
    const atLimit = (side: 'left' | 'right') => limitHit?.id === c.id && limitHit.side === side ? ' at-limit' : ''
    return (
      <div
        key={c.id}
        onMouseDown={(e) => startMove(e, 'clip', c.id)}
        className={`clip ${c.trackId === 'v2' ? 'b-clip' : c.trackId !== 'v1' ? 'a-clip' : 'v-clip'} ${c.type} ${bg ? 'has-thumb' : ''} ${selectedId === c.id ? 'selected' : ''} ${drag?.id === c.id ? 'dragging' : ''} ${lost ? 'offline' : ''}`}
        style={{ left: c.start * pxPerSec, width: c.duration * pxPerSec, backgroundImage: bg, backgroundSize: bgSize, backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }}
        title={!media ? 'Its media was removed from the Media Bin: delete this clip or re-import the file' : media.offline ? `${media.name}: file missing, right-click it in the Media Bin to relink` : media.name}
      >
        <div className={`trim-handle left${atLimit('left')}`} onMouseDown={(e) => startTrim(e, 'clip', c.id, 'left')} />
        {c.fadeIn > 0 && <div className="fade-tri in" style={{ width: c.fadeIn * pxPerSec }} />}
        <span className="clip-label">{media?.name}</span>
        {c.fadeOut > 0 && <div className="fade-tri out" style={{ width: c.fadeOut * pxPerSec }} />}
        <div className={`trim-handle right${atLimit('right')}`} onMouseDown={(e) => startTrim(e, 'clip', c.id, 'right')} />
      </div>
    )
  }

  return (
    <div className="app-container" onDragOver={(e) => e.preventDefault()}>
      <ChromaKeyFilters />
      {(window as unknown as { __vhWeb?: boolean }).__vhWeb && (
        <div className="web-banner">
          Browser preview: this draws the interface only. Opening files, FFmpeg, exporting and the AI bridge all live in the desktop app, run <code>npm run dev</code> or open the installed VidHelm.
        </div>
      )}
      <header
        onMouseDown={e => { if (e.button === 0 && !(e.target as HTMLElement).closest(HDR_CONTROLS)) window.ipcRenderer.windowDragStart?.() }}
        onDoubleClick={e => { if (!(e.target as HTMLElement).closest(HDR_CONTROLS)) window.ipcRenderer.windowToggleMaximize?.() }}
        title="Drag anywhere on this bar to move the window · double-click to maximize">
        <div className="hdr-left">
          <div className="brand" title="VidHelm"><VidHelmMark /><h1>VidHelm</h1></div>
          <div className="hdr-group">
            <button className={`hdr-btn ${dirty ? 'unsaved' : ''}`} onClick={e => { void saveProject(e.shiftKey) }}
              title={`${dirty ? 'Unsaved changes. ' : ''}Save project (Ctrl+S)${currentProject ? ` into ${currentProject.name}` : saveFile ? ` to ${baseName(saveFile)}` : ''}.${currentProject || saveFile ? ' Shift+click or Ctrl+Shift+S saves a copy as a file; Save keeps writing here.' : ''}`}><IcSave /><span>Save</span></button>
            <button className="hdr-btn" onClick={loadProject} title="Open project"><IcOpen /><span>Open</span></button>
            <button className="hdr-btn" onClick={() => importCloudZip()} title="Import a VidHelm Cloud hand-off (.zip): clips, plan, notes and narration land in a new project"><IcCloud /><span>Import</span></button>
          </div>
          <span className="hdr-sep" />
          <div className="hdr-group">
            <button className="hdr-btn" onClick={runRecipe} title="Run your Start Recipe on this timeline"><IcRecipe /><span>Recipe</span></button>
            <button className="hdr-btn" onClick={() => { setModel3DPath(null); setShowModel3D(true) }} title="3D Studio, turn an STL / 3MF / OBJ into a spinning turntable clip"><IcCube /><span>3D</span></button>
            <button className="hdr-btn" onClick={() => setShowAiClip(true)} title="AI clip: generate a shot from a description, or morph one picture (or the frame under the playhead) into another"><IcSparkle /><span>AI clip</span></button>
          </div>
        </div>
        <div className="orientation-switch" role="group" aria-label="Frame format">
          {(Object.keys(ORIENTATIONS) as OrientationKey[]).map(key => (
            <button key={key} className={`orient-btn ${orientation === key ? 'active' : ''}`} onClick={() => setOrientation(key)} title={`${ORIENTATIONS[key].label} (${ORIENTATIONS[key].sub})`}>
              <span className={`orient-glyph ${key}`} /><span className="orient-label">{ORIENTATIONS[key].label}</span>
            </button>
          ))}
        </div>
        <div className="hdr-right">
          <button className="hdr-btn hdr-chat" onClick={() => setShowChat(c => !c)} title="Help chat: ask anything about VidHelm"><IcChat /><span>Help</span></button>
          <button className="hdr-btn hdr-connect" onClick={() => setShowConnect(true)} title="Connect your AI, one-click setup + troubleshooter"><IcBot /><span>Connect AI</span></button>
          <span className="hdr-sep" />
          <button className="hdr-btn icon" onClick={() => setUiTheme(t => t === 'dark' ? 'light' : 'dark')} title={uiTheme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}>{uiTheme === 'dark' ? <IcSun /> : <IcMoon />}</button>
          <button className="hdr-btn icon" onClick={e => { e.stopPropagation(); setShowLinks(v => !v) }} title="Links and contact"><IconInfo /></button>
          <button className="hdr-btn icon" onClick={() => setShowHelp(true)} title="Getting started, the tour, credits and licences"><IcHelp /></button>
          <button className="hdr-btn icon" onClick={() => setShowSettings(true)} title="Brand kit & settings"><IconGear /></button>
          <button className="hdr-export" onClick={handleExport} disabled={(clips.length === 0 && texts.length === 0) || exportProgress !== null}
            title="Render the video with the settings in the Export panel">
            <IconExport /><span>{exportProgress !== null ? `${Math.round(exportProgress)}%` : 'Export'}</span>
          </button>
          {showLinks && (
            <div className="links-pop" onClick={e => e.stopPropagation()}>
              {LINKS.map(l => (
                <button key={l.url} onClick={() => { window.ipcRenderer.openExternal(l.url); setShowLinks(false) }}>
                  <span className="links-ico">{l.icon}</span>
                  <span className="links-txt">
                    <b>{l.label}</b><i>{l.sub}</i>
                    {l.note && <em className="links-note">{l.note}</em>}
                  </span>
                </button>
              ))}
              <div className="links-foot">VidHelm {appVersion} · built by RandoTechNerd</div>
            </div>
          )}
        </div>
      </header>

      <main className={expanded ? 'expanded' : ''}>
        <div className="workspace">
        {!expanded && (
          <div className="sidebar left">
            <div className="section-header tabs">
              <button className={`tab ${sidebarTab === 'media' ? 'active' : ''}`} onClick={() => setSidebarTab('media')}>Media</button>
              <button className={`tab ${sidebarTab === 'sfx' ? 'active' : ''}`} onClick={() => setSidebarTab('sfx')} title="Sound effects, audition and drop on the SFX track">Sound FX</button>
              {sidebarTab === 'media' && <label className="add-btn" title="Add video, audio or images, or a 3D model (STL / 3MF / OBJ / GLB)"><IconPlus /><input type="file" accept={ACCEPT_ATTR} multiple onChange={handleFileUpload} hidden /></label>}
            </div>
            {sidebarTab === 'sfx' && <SfxPanel onPlace={placeSfx}
              genCommand={settings.sfxGen.command} onGenCommand={c => setSettings(s => ({ ...s, sfxGen: { ...s.sfxGen, command: c } }))}
              freesoundToken={settings.sfxGen.freesoundToken} onFreesoundToken={t => setSettings(s => ({ ...s, sfxGen: { ...s.sfxGen, freesoundToken: t } }))}
              favorites={settings.sfxGen.favorites}
              onToggleFavorite={name => setSettings(s => {
                const cur = s.sfxGen.favorites || []
                return { ...s, sfxGen: { ...s.sfxGen, favorites: cur.includes(name) ? cur.filter(x => x !== name) : [...cur, name] } }
              })} />}
            {sidebarTab === 'media' && settings.workspace.root && (
              <div className="proj-bar">
                <select value={currentProject?.dir || ''} title="Each sub-folder of your project folder is a project"
                  onChange={e => { const p = projects.find(x => x.path === e.target.value); if (p) void openProjectFolder(p.path, p.name) }}>
                  <option value="" disabled>Open a project…</option>
                  {projects.map(p => <option key={p.path} value={p.path}>{p.name}{p.media ? ` · ${p.media} file${p.media > 1 ? 's' : ''}` : ''}{p.saved ? ' ✓' : ''}</option>)}
                </select>
                <button onClick={newProjectFolder} title="Create a new project folder"><IcPlus /></button>
                <button title="Bring in new files from this folder and look again for missing ones (your timeline stays as it is)" disabled={!currentProject || rescanning}
                  onClick={() => { void rescanProjectFolder() }}><IcRefresh /></button>
                <button title="Show the folder in Explorer" disabled={!currentProject}
                  onClick={() => currentProject && window.ipcRenderer.revealFolder(currentProject.dir)}><IcFolder /></button>
              </div>
            )}
            {sidebarTab === 'media' && <div className="media-list" onDrop={async (e) => { e.preventDefault(); await importFiles(Array.from(e.dataTransfer.files)) }} onDragOver={(e) => e.preventDefault()}>
              {mediaBin.length === 0 && <div className="empty-hint">
                Click <IconPlus /> or drag files here.
                <InfoNote label="What can I add?">
                  Double-click an item, or drop files straight onto the timeline, to use it.<br /><br />
                  Video, audio and images in just about any format, plus 3D models (STL · 3MF · OBJ · GLB), which open in the 3D Studio instead of the timeline.<br /><br />
                  New here? The <b>?</b> button up top walks you through a first video.
                </InfoNote>
              </div>}
              {mediaBin.map(m => (
                <div key={m.id} className={`media-item ${m.offline ? 'offline' : ''}`} draggable={!m.offline}
                  onDragStart={e => { e.dataTransfer.setData(MEDIA_DRAG, m.id); e.dataTransfer.effectAllowed = 'copy' }}
                  onDoubleClick={() => { if (!m.offline) addToTimeline(m) }} onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, mediaId: m.id }) }}
                  title={m.offline ? `File not found: ${m.path}. Right-click to relink it.` : 'Double-click to add, or drag onto a track row • right-click for options'}>
                  <div className="media-icon">
                    {m.offline
                      ? <IcMissing />
                      : m.type === 'image'
                      ? <img className="media-still" src={fileUrl(m.path)} alt="" />
                      : m.type === 'video'
                        ? <video className="media-still" src={`${fileUrl(m.proxyPath || m.path)}#t=0.5`} muted preload="metadata" />
                        : <IconAudio/>}
                  </div>
                  <div className="media-info">
                    <span className="name">{m.name}</span>
                    <span className="duration">
                      {m.type === 'image' ? 'Image • 5s' : `${Math.round(m.duration)}s`}
                      {m.offline && <span className="prox warn"> · offline, right-click to relink</span>}
                      {!m.offline && m.proxyPct !== undefined && <span className="prox building" title={`${m.proxyNote}. Building a preview copy, the original is untouched.`}> · preview copy {m.proxyPct}%</span>}
                      {!m.offline && m.proxyPct === undefined && m.proxyPath && <span className="prox" title={`${m.proxyNote}. Editing plays a preview copy. A High quality export reads the original; a Standard one uses this copy only when it already matches the export's size and frame rate.`}> · proxy</span>}
                      {!m.offline && m.proxyPct === undefined && !m.proxyPath && m.proxyNote && <span className="prox warn" title={m.proxyNote}> · no preview</span>}
                    </span>
                  </div>
                </div>
              ))}
            </div>}
          </div>
        )}

        <div className="center-panel">
          <div className="viewer-container">
            <div className="stage" ref={stageRef} style={{ aspectRatio: String(ORIENTATIONS[orientation].ratio) }} onMouseDown={() => setSelectedId(null)}>
              {activeVideoClips.length === 0 && activeTexts.length === 0 && <div className="placeholder">{w}×{h}</div>}
              {previewVideoClips.map(c => {
                const media = mediaBin.find(m => m.id === c.mediaId)
                if (!media) return null
                // hidden while it warms up, so it never shows a half-decoded or empty frame
                const op = currentTime < c.start ? 0 : fadeFactor(c, currentTime)
                return media.type === 'image'
                  ? <img key={c.id} className="layer" style={{ opacity: op, filter: media.chromaKey ? `url(#${keyFilterFor(media.chromaKey)})` : undefined }} src={fileUrl(media.path)} alt="" />
                  : <video key={c.id} ref={el => { if (el) videoEls.current.set(c.id, el); else videoEls.current.delete(c.id) }} className="layer"
                      muted={c.trackId === 'v2'}
                      style={{ opacity: op, filter: media.chromaKey ? `url(#${keyFilterFor(media.chromaKey)})` : undefined }} src={fileUrl(media.proxyPath || media.path)} />
              })}
              {activeTexts.map(t => t.caption ? (
                <CaptionLayer key={t.id} t={t} time={currentTime} groupBase={texts.indexOf(t)} outW={w} outH={h} stageH={stageH} selected={selectedId === t.id && !isPlaying} onSelect={() => { if (!isPlaying) setSelectedId(t.id) }} />
              ) : (
                <div key={t.id} className={`text-layer ${selectedId === t.id && !isPlaying ? 'editing' : ''} ${editingTextId === t.id ? 'typing' : ''}`}
                  style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%`, fontSize: `${t.fontSize / 1080 * stageH}px`, color: t.color, opacity: fadeFactor(t, currentTime), background: t.box ? (t.boxColor ? `${t.boxColor}${Math.round((t.boxOpacity ?? 0.5) * 255).toString(16).padStart(2, '0')}` : `rgba(0,0,0,${t.boxOpacity ?? 0.5})`) : 'transparent', padding: t.box ? '0.15em 0.4em' : 0, borderRadius: t.box ? '4px' : 0,
                    ...(t.font && THEME_FONTS[t.font] ? { fontFamily: `'${THEME_FONTS[t.font].family}', sans-serif`, fontWeight: THEME_FONTS[t.font].bold ? 700 : 400 } : {}),
                    ...(t.outline && !t.box ? { WebkitTextStroke: `${(t.outline * 2 * t.fontSize / 1080 * stageH).toFixed(1)}px ${t.outlineColor || '#000'}`, paintOrder: 'stroke fill' } : {}) }}
                  ref={editingTextId === t.id ? editRef : undefined}
                  contentEditable={editingTextId === t.id}
                  suppressContentEditableWarning
                  spellCheck={false}
                  title={editingTextId === t.id ? '' : 'Drag to move, double-click to type'}
                  onMouseDown={(e) => { if (isPlaying) return; if (editingTextId === t.id) { e.stopPropagation(); return } startTextDrag(e, t) }}
                  onDoubleClick={(e) => { e.stopPropagation(); if (!isPlaying) startTextEdit(t.id) }}
                  onInput={(e) => { const v = (e.target as HTMLElement).innerText; setTexts(prev => prev.map(x => x.id === t.id ? { ...x, text: v } : x)) }}
                  onBlur={() => endTextEdit()}
                  onKeyDown={(e) => {
                    e.stopPropagation()   // Space and Delete belong to the caret while typing
                    if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); endTextEdit() }
                  }}>
                  {editingTextId === t.id ? undefined : (t.text || ' ')}
                </div>
              ))}
              {settings.brand.enabled && settings.brand.logoPath && (() => {
                const b = settings.brand
                const inWindow = b.showMode === 'whole'
                  || (b.showMode === 'intro' && currentTime <= b.windowSec)
                  || (b.showMode === 'outro' && currentTime >= totalDuration - b.windowSec)
                if (!inWindow) return null
                const posStyle: React.CSSProperties = { position: 'absolute', width: `${b.sizePct}%`, opacity: b.opacity, pointerEvents: 'none' }
                const mg = `${(b.margin / 1080) * 100 * (ORIENTATIONS[orientation].ratio >= 1 ? 1 / ORIENTATIONS[orientation].ratio : 1)}%`
                if (b.position.includes('t')) posStyle.top = '4%'; else if (b.position.includes('b')) posStyle.bottom = '4%'
                if (b.position.includes('l')) posStyle.left = '3%'; else if (b.position.includes('r')) posStyle.right = '3%'
                if (b.position === 'center') { posStyle.top = '50%'; posStyle.left = '50%'; posStyle.transform = 'translate(-50%,-50%)' }
                void mg
                return <img className="brand-logo" style={posStyle} src={fileUrl(b.logoPath)} alt="logo" />
              })()}
            </div>
            <button className="expand-btn" onClick={() => setExpanded(!expanded)} title="Toggle large preview"><IconExpand /></button>
          </div>

        </div>

        {!expanded && (
          <div className="sidebar right">
            <div className="section-header tabs">
              <button className={`tab ${rightTab === 'export' ? 'active' : ''}`} onClick={() => setRightTab('export')}>Export</button>
              <button className={`tab ${rightTab === 'tags' ? 'active' : ''}`} onClick={() => setRightTab('tags')} title="Tag points: press M at the beats that matter">Tags{markers.length > 0 && <span className="count-badge">{markers.length}</span>}</button>
              <button className={`tab ${rightTab === 'inspect' ? 'active' : ''}`} onClick={() => setRightTab('inspect')} title="Adjust the selected clip or text">Inspector</button>
            </div>
            <div className="panel-body">
              {rightTab === 'export' && (
                <div className="panel-section">
                <div className="field row">
                  <div><label>Resolution</label>
                    <select value={resolution} onChange={e => setResolution(e.target.value as ResolutionKey)}>
                      <option value="4K">4K (2160)</option><option value="1440p">1440p</option><option value="1080p">1080p</option><option value="720p">720p</option>
                    </select>
                  </div>
                  <div><label>Frame Rate</label>
                    <select value={fps} onChange={e => setFps(parseInt(e.target.value) as 24 | 30 | 60)}>
                      <option value={24}>24 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option>
                    </select>
                  </div>
                </div>
                <div className="field"><label>Encoding Quality</label>
                  <select value={exportQuality} onChange={e => setExportQuality(e.target.value as any)}><option value="medium">Standard (faster)</option><option value="high">High (larger file)</option></select>
                </div>
                <div className="field"><label><IconVolume /> Master Volume - {Math.round(masterVolume * 100)}%</label>
                  <input type="range" min="0" max="1.5" step="0.05" value={masterVolume} onChange={e => setMasterVolume(parseFloat(e.target.value))} style={{ width: '100%', accentColor: 'var(--accent-primary)' }} />
                </div>
                <div className="field chk" onClick={() => setSettings(s => ({ ...s, audio: { ...s.audio, optimize: !s.audio.optimize } }))}><input type="checkbox" checked={settings.audio.optimize} readOnly id="norm" /><label htmlFor="norm" style={{ cursor: 'pointer', marginBottom: 0 }}>Optimize loudness (−14 LUFS)</label></div>
                <div className="field chk" onClick={() => setSettings(s => ({ ...s, audio: { ...s.audio, noiseReduction: !s.audio.noiseReduction } }))}><input type="checkbox" checked={settings.audio.noiseReduction} readOnly id="nr" /><label htmlFor="nr" style={{ cursor: 'pointer', marginBottom: 0 }}>Noise reduction</label></div>
                <div className="field"><label>Save To</label><div className="path-box" onClick={pickExportPath}><IconFolder /><span>{customExportPath ? customExportPath.split(/[\\/]/).pop() : 'Choose on export…'}</span></div></div>
                <div className={`progress-line ${exportProgress !== null ? 'show' : ''}`}><div className="fill" style={{ width: `${exportProgress || 0}%` }} /></div>
                <button className="action-btn export" onClick={handleExport} disabled={(clips.length === 0 && texts.length === 0) || exportProgress !== null}><IconExport /> <span>{exportProgress !== null ? `Rendering ${Math.round(exportProgress)}%${eta && eta > 0 ? ` • ${fmtEta(eta)} left` : ''}` : 'Export Video'}</span></button>
                {lastExport && exportProgress === null && (
                  <div className="post-export">
                    <button className="reveal-link" onClick={() => window.ipcRenderer.revealFile(lastExport)}><IcCheck /> Show in folder</button>
                    <button className="reveal-link" onClick={() => runQualityCheck(lastExport)}><IcEye /> Watch &amp; Verify</button>
                  </div>
                )}
                </div>
              )}
              {rightTab === 'tags' && (
                <div className="panel-section">
                  <MarkerPanel markers={markers} currentTime={currentTime} onChange={setMarkers} onSeek={t => setCurrentTime(t)} />
                </div>
              )}
              {rightTab === 'inspect' && selClip && (
                <div className="panel-section">
                  <h3 className="group-title">Clip</h3>
                  <div className="field"><label>Track</label>
                    <select value={selClip.trackId} onChange={e => patchClip({ trackId: e.target.value as TimelineClip['trackId'] })}>
                      {selClip.type === 'audio'
                        ? <><option value="a1">Voice / music</option><option value="a2">Sound effects</option></>
                        : <><option value="v1">Video</option><option value="v2">B-roll (picture only, over the video)</option></>}
                    </select>
                    {selClip.trackId === 'v2' && <p className="hint">B-roll covers the video underneath while its sound keeps playing; this clip's own sound is not used.</p>}
                  </div>
                  <div className="field"><label>Volume - {Math.round(selClip.volume * 100)}%</label>
                    <input type="range" min="0" max="2" step="0.05" value={selClip.volume} onChange={e => patchClip({ volume: parseFloat(e.target.value), volumePoints: [] })} style={{ width: '100%', accentColor: 'var(--accent-primary)' }} />
                  </div>
                  <div className="field">
                    <label>Volume Automation {selClip.volumePoints?.length ? `(${selClip.volumePoints.length} pts)` : ''}</label>
                    <VolumeGraph points={selClip.volumePoints || []} duration={selClip.duration} base={selClip.volume} onChange={pts => patchClip({ volumePoints: pts })} />
                    <div className="vg-actions">
                      <button onClick={() => { const rel = clamp(currentTime - selClip.start, 0, selClip.duration); patchClip({ volumePoints: [...(selClip.volumePoints || []), { t: rel, v: selClip.volume }].sort((a, b) => a.t - b.t) }) }}>+ Point at playhead</button>
                      <button onClick={() => patchClip({ volumePoints: [] })} disabled={!selClip.volumePoints?.length}>Clear</button>
                    </div>
                    <p className="hint">Click the graph to add points, drag to shape the line, double-click a point to remove. Drag down to silence pops. Unity gain = the middle line.</p>
                  </div>
                  <div className="field row">
                    <div><label>Fade In (s)</label><input type="number" step="0.1" min="0" className="duration-input" value={selClip.fadeIn} onChange={e => patchClip({ fadeIn: clamp(parseFloat(e.target.value) || 0, 0, selClip.duration) })} /></div>
                    <div><label>Fade Out (s)</label><input type="number" step="0.1" min="0" className="duration-input" value={selClip.fadeOut} onChange={e => patchClip({ fadeOut: clamp(parseFloat(e.target.value) || 0, 0, selClip.duration) })} /></div>
                  </div>
                  <div className="field"><label>Duration (s)</label><input type="number" step="0.1" min="0.1" className="duration-input" value={selClip.duration.toFixed(2)}
                    onChange={e => patchClip({ duration: clamp(parseFloat(e.target.value) || 0.1, 0.1, maxDurationFrom(selClip.sourceStart, footageLength(mediaBin.find(m => m.id === selClip.mediaId)))) })} /></div>
                  <p className="hint">Overlap two video clips and give them fades for a transparent crossfade.</p>
                </div>
              )}
              {rightTab === 'inspect' && selText && (
                <div className="panel-section">
                  <h3 className="group-title">Text</h3>
                  <div className="field"><label>Content</label><textarea className="duration-input" rows={2} value={selText.text} onChange={e => patchText({ text: e.target.value })} /></div>
                  <div className="field row">
                    <div><label>Size</label><input type="number" min="8" step="2" className="duration-input" value={selText.fontSize} onChange={e => patchText({ fontSize: parseFloat(e.target.value) || 12 })} /></div>
                    <div><label>Color</label><input type="color" className="color-input" value={selText.color} onChange={e => patchText({ color: e.target.value })} /></div>
                  </div>
                  <div className="field row">
                    <div><label>Start (s)</label><input type="number" step="0.1" min="0" className="duration-input" value={selText.start.toFixed(2)} onChange={e => patchText({ start: parseFloat(e.target.value) || 0 })} /></div>
                    <div><label>Duration (s)</label><input type="number" step="0.1" min="0.2" className="duration-input" value={selText.duration.toFixed(2)} onChange={e => patchText({ duration: parseFloat(e.target.value) || 0.2 })} /></div>
                  </div>
                  <div className="field row">
                    <div><label>Fade In (s)</label><input type="number" step="0.1" min="0" className="duration-input" value={selText.fadeIn} onChange={e => patchText({ fadeIn: parseFloat(e.target.value) || 0 })} /></div>
                    <div><label>Fade Out (s)</label><input type="number" step="0.1" min="0" className="duration-input" value={selText.fadeOut} onChange={e => patchText({ fadeOut: parseFloat(e.target.value) || 0 })} /></div>
                  </div>
                  <div className="field chk" onClick={() => patchText({ box: !selText.box })}><input type="checkbox" checked={!!selText.box} readOnly id="tbox" /><label htmlFor="tbox" style={{ cursor: 'pointer', marginBottom: 0 }}>Background bar</label></div>
                  <p className="hint">Drag the text on the preview to position it.</p>
                </div>
              )}
              {rightTab === 'inspect' && !selClip && !selText && (
                <div className="empty-hint">Select a clip or a text layer on the timeline to adjust it here.</div>
              )}
            </div>
          </div>
        )}
        </div>

        <div className="resize-handle" onMouseDown={startResizeTimeline} title="Drag to resize the timeline" />
        <section className="timeline-area">
          <div className="timeline-actions">
            {/* The primary tools scroll if the centre panel gets narrow, so the bar is always
                exactly one row. More and the zoom group sit outside the scroller and stay put,
                which also keeps the dropdown clear of the scroll container's clipping. */}
            <div className="tool-group">
            <button className="tool-btn play" onClick={() => setIsPlaying(p => !p)} disabled={totalDuration <= 0}>{isPlaying ? <IconPause /> : <IconPlay />} {isPlaying ? 'Pause' : 'Play'}</button>
            <span className="timecode" title="Playhead / total length"><b>{fmt(currentTime)}</b><i>/</i>{fmt(totalDuration)}</span>
            <div className="divider" />
            <button className="tool-btn compactable" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)"><IconUndo /> <span className="tb-label">Undo</span></button>
            <button className="tool-btn compactable" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"><IconRedo /> <span className="tb-label">Redo</span></button>
            <div className="divider" />
            <button className="tool-btn compactable" onClick={splitAtPlayhead} disabled={!selClip} title="Split the selected clip at the playhead"><IconScissors /> <span className="tb-label">Split</span></button>
            <button className="tool-btn compactable" onClick={deleteSelected} disabled={!selectedId} title="Delete the selection"><IconTrash /> <span className="tb-label">Delete</span></button>
            <button className="tool-btn compactable" onClick={addText} title="Add a text layer"><IconText /> <span className="tb-label">Text</span></button>
            <button className={`tool-btn compactable ${isRecording ? 'recording' : ''}`} onClick={toggleRecord} title="Record a voiceover"><IconMic /> <span className="tb-label">{isRecording ? 'Stop' : 'Voiceover'}</span></button>
            <button className="tool-btn compactable captions-btn" onClick={() => generateCaptions()} disabled={captioning !== null || totalDuration <= 0} title="Auto-caption the whole timeline (on-device Whisper)">
              <IconCaptions /> <span className="tb-label">{captioning ? `${captioning}${captionPct !== null ? ` ${captionPct}%` : '…'}` : 'Captions'}</span>
              {captioning && captionPct !== null && <span className="cap-bar"><span className="cap-fill" style={{ width: `${captionPct}%` }} /></span>}
            </button>
            <div className="divider" />
            <button className={`tool-btn compactable ${showBooth ? 'active' : ''}`} onClick={() => setShowBooth(b => !b)}
              title="Karaoke booth, read a script along with the video in one take"><IcBooth /> <span className="tb-label">Booth</span></button>
            <button className="tool-btn compactable" onClick={() => setShowNarration(true)}
              title="Generate narration with a cloned voice (external TTS tool)"><IcVoice /> <span className="tb-label">Narrate</span></button>
            <button className="tool-btn compactable" onClick={cutDeadSpace} disabled={silenceBusy !== null || totalDuration <= 0}
              title="Detect & remove long silent pauses (great for faceless videos)"><IcCut /> <span className="tb-label">{silenceBusy || 'Cut Pauses'}</span></button>
            <button className="tool-btn compactable" onClick={() => setShowTakes(true)} disabled={takesBusy !== null}
              title="Takes & history: find repeated takes, keep the best one, and see the full transcript of what was cut">
              <IcList /> <span className="tb-label">{takesBusy || 'Takes'}</span>{takeStats(takes).cuts > 0 && <span className="tk-badge">{takeStats(takes).cuts}</span>}
            </button>
            </div>

            <div className="spacer" />
            <div className="zoom" role="group" aria-label="Timeline zoom">
              <button title="Zoom out" aria-label="Zoom out" onClick={() => setPxPerSec(p => clamp(p / 1.4, 2, 200))}>−</button>
              <button title="Zoom in" aria-label="Zoom in" onClick={() => setPxPerSec(p => clamp(p * 1.4, 2, 200))}>+</button>
              <button className="zoom-fit" title="Zoom to fit, see every clip at once (Ctrl+scroll on the timeline also zooms)" disabled={totalDuration <= 0}
                onClick={() => { const w = timelineRef.current?.clientWidth || 800; setPxPerSec(clamp((w - 60) / Math.max(totalDuration, 0.5), 2, 200)); if (timelineRef.current) timelineRef.current.scrollLeft = 0 }}>Fit</button>
            </div>
          </div>


          <div className="timeline-panel" style={{ height: timelineH }}>
            <div className={`timeline ${scrubbing ? 'scrubbing' : ''}`} ref={timelineRef} onClick={onTimelineClick} onDrop={onTimelineDrop} onDragOver={(e) => e.preventDefault()}
              onWheel={e => {
                if (!e.ctrlKey) return
                // Ctrl+scroll zooms around the cursor so the point under the mouse stays put
                const el = timelineRef.current!
                const tAtCursor = (e.clientX - el.getBoundingClientRect().left + el.scrollLeft) / pxPerSec
                const next = clamp(e.deltaY < 0 ? pxPerSec * 1.18 : pxPerSec / 1.18, 2, 200)
                setPxPerSec(next)
                requestAnimationFrame(() => { el.scrollLeft = Math.max(0, tAtCursor * next - (e.clientX - el.getBoundingClientRect().left)) })
              }}>
              <div className="tl-content" style={{ width: tlWidth }}>
              <TimeRuler pxPerSec={pxPerSec} widthPx={tlWidth} viewW={tlView.w} viewH={tlView.h} fps={fps} mode="tenths" scroller={timelineRef} handlers={rulerHandlers} />
              {markers.map(m => (
                <div key={m.id} className="marker-flag" style={{ left: m.t * pxPerSec, background: m.color }} title={m.label || 'tag point'}
                  onClick={e => { e.stopPropagation(); setCurrentTime(m.t) }}
                  onMouseDown={e => {
                    e.stopPropagation()
                    const startX = e.clientX, orig = m.t
                    let moved = false
                    const move = (ev: MouseEvent) => { const nt = Math.max(0, orig + (ev.clientX - startX) / pxPerSec); if (Math.abs(ev.clientX - startX) > 3) moved = true; setMarkers(ms => ms.map(x => x.id === m.id ? { ...x, t: nt } : x)) }
                    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); if (!moved) setCurrentTime(m.t) }
                    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
                  }}>
                  {m.label && <span className="marker-flag-label">{m.label}</span>}
                </div>
              ))}
              <div className="scrubber" style={{ left: currentTime * pxPerSec }}>
                <div className="scrubber-grab" title="Drag to scrub" {...scrubHandlers} />
              </div>
              {drag?.snap != null && <div className="snap-line" style={{ left: drag.snap * pxPerSec }} />}
              <div className="tracks">
                <button className="track-label" onClick={() => setCollapsed(c => ({ ...c, text: !c.text }))}><IconChevron open={!collapsed.text} /> TEXT</button>
                {!collapsed.text && (
                  <div className="track text-track">
                    {texts.map(t => (
                      <div key={t.id} onMouseDown={(e) => startMove(e, 'text', t.id)}
                        onDoubleClick={(e) => { e.stopPropagation(); setCurrentTime(t.start + Math.min(0.2, t.duration / 2)); startTextEdit(t.id) }}
                        className={`clip text-clip ${selectedId === t.id ? 'selected' : ''} ${drag?.id === t.id ? 'dragging' : ''}`} style={{ left: t.start * pxPerSec, width: t.duration * pxPerSec }}
                        title={`${t.text}\nDrag to move, drag an edge to trim, double-click to type`}>
                        <div className="trim-handle left" onMouseDown={(e) => startTrim(e, 'text', t.id, 'left')} />
                        <span className="clip-label"><IconText /> {t.text}</span>
                        <div className="trim-handle right" onMouseDown={(e) => startTrim(e, 'text', t.id, 'right')} />
                      </div>
                    ))}
                  </div>
                )}
                <button className="track-label" onClick={() => setCollapsed(c => ({ ...c, broll: !c.broll }))} title="Picture only: cutaways here cover the video track while the audio underneath keeps playing"><IconChevron open={!collapsed.broll} /> B-ROLL</button>
                {!collapsed.broll && <div className="track v-track broll-track" data-track="v2" onDragOver={e => e.preventDefault()} onDrop={e => { e.stopPropagation(); void dropMedia(e, 'v2') }}>
                  {clips.filter(c => c.trackId === 'v2').map(renderClip)}
                  {!clips.some(c => c.trackId === 'v2') && <span className="row-hint">Drag a picture here (from the Media panel or a folder) to cut away to it</span>}
                </div>}
                <button className="track-label" onClick={() => setCollapsed(c => ({ ...c, video: !c.video }))}><IconChevron open={!collapsed.video} /> VIDEO</button>
                {!collapsed.video && <div className="track v-track" data-track="v1" onDragOver={e => e.preventDefault()} onDrop={e => { e.stopPropagation(); void dropMedia(e, 'v1') }}>{clips.filter(c => c.trackId === 'v1').map(renderClip)}</div>}
                <button className="track-label" onClick={() => setCollapsed(c => ({ ...c, audio: !c.audio }))}><IconChevron open={!collapsed.audio} /> VOICE / MUSIC</button>
                {!collapsed.audio && <div className="track a-track" data-track="a1" onDragOver={e => e.preventDefault()} onDrop={e => { e.stopPropagation(); void dropMedia(e, 'a1') }}>{clips.filter(c => c.trackId === 'a1').map(renderClip)}</div>}
                <button className="track-label" onClick={() => setCollapsed(c => ({ ...c, sfx: !c.sfx }))}><IconChevron open={!collapsed.sfx} /> SFX</button>
                {!collapsed.sfx && <div className="track a-track sfx-track" data-track="a2" onDragOver={e => e.preventDefault()} onDrop={e => { e.stopPropagation(); void dropMedia(e, 'a2') }}>{clips.filter(c => c.trackId === 'a2').map(renderClip)}</div>}
              </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Tour open={showTour} onClose={() => setShowTour(false)} onFinish={() => setShowChat(true)} />
      <HelpChat open={showChat} onClose={() => setShowChat(false)} onAction={openPanel}
        context={{ version: appVersion, clips: clips.length + texts.length, duration: totalDuration, format: ORIENTATIONS[orientation].label, aiKeys: !!(settings.aiGen?.falKey || settings.aiGen?.geminiKey) }} />
      <div className="toasts">{toasts.map(t => <div key={t.id} className="toast" onClick={() => setToasts(x => x.filter(y => y.id !== t.id))}>{t.text}</div>)}</div>
      {drag && <div className="drag-hud" style={{ left: drag.hud.x, top: drag.hud.y - 14 }}>{drag.hud.text}</div>}
      {ask && (
        <div className="modal-backdrop ask-backdrop">
          <div className="modal ask-modal" role="alertdialog" aria-modal="true" aria-label={ask.title}>
            <div className="modal-head"><h2>{ask.title}</h2></div>
            <div className="modal-body"><p>{ask.body}</p></div>
            <div className="modal-foot ask-foot">
              {ask.choices.map(c => <button key={c.id} className={c.primary ? 'primary' : ''} autoFocus={c.primary} onClick={() => ask.resolve(c.id)}>{c.label}</button>)}
            </div>
          </div>
        </div>
      )}

      <KaraokeBooth open={showBooth} onClose={() => setShowBooth(false)} markers={markers}
        totalDuration={totalDuration} currentTime={currentTime} isPlaying={isPlaying}
        onSeek={t => setCurrentTime(t)} onPlay={p => setIsPlaying(p)} onRecorded={boothRecorded}
        script={boothScript} onScript={setBoothScript} onDraft={draftBoothScript} projectDir={currentProject?.dir} />
      <NarrationModal open={showNarration} onClose={() => setShowNarration(false)}
        command={settings.narration.command}
        onCommand={c => setSettings(s => ({ ...s, narration: { command: c } }))}
        onGenerated={narrationGenerated} />

      <ConnectModal open={showConnect} onClose={() => setShowConnect(false)} />
      <HelpModal open={showHelp} onClose={() => setShowHelp(false)} version={appVersion}
        onOpenPanel={openPanel} onTour={() => setShowTour(true)} onChat={() => setShowChat(true)} />
      <Model3DModal open={showModel3D} onClose={() => setShowModel3D(false)} initialPath={model3DPath} apiRef={model3dApi}
        getFrame={async () => {
          // the frame under the playhead, so a turntable can be rendered over real footage
          const hit = clips.filter(c => c.trackId === 'v1' && currentTime >= c.start && currentTime < c.start + c.duration)
            .map(c => ({ c, m: mediaBin.find(m => m.id === c.mediaId) })).find(x => x.m?.type === 'video')
          if (!hit?.m) return null
          const srcT = hit.c.sourceStart + (currentTime - hit.c.start)
          const r = await window.ipcRenderer.sampleFrames({ filePath: hit.m.path, count: 1, sourceStart: srcT, duration: 0.05 }).catch(() => null)
          return r?.frames?.[0]?.path || null
        }}
        onRendered={async (path, kind, name, overlay, chromaKey) => {
          const meta = await window.ipcRenderer.getMetadata(path).catch(() => null)
          const media: MediaFile = {
            id: rid(), name, path, type: kind,
            duration: kind === 'image' ? 5 : (meta?.duration || 6),
            hasVideo: true, hasAudio: false, chromaKey,
          }
          setMediaBin(prev => [...prev, media])
          if (overlay) {
            // transparent renders go in at the playhead so they land on top of the footage
            // already there, clips composite in the order they were added
            setClips(prev => [...prev, { id: rid(), mediaId: media.id, type: media.type, trackId: 'v1', start: currentTime, duration: media.duration, sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 }])
            notify(`${name} added as an overlay at ${fmt(currentTime)}${chromaKey ? ', its backdrop is keyed out' : ''}. It sits on top of the clip underneath, drag it anywhere on the video track.`, 9000)
          } else addToTimeline(media)
        }} />
      <ThumbnailModal open={showThumbnail} onClose={() => setShowThumbnail(false)}
        videoPath={firstVideo()?.path || null} videoName={firstVideo()?.name || 'video'} logoPath={settings.brand.logoPath}
        photos={thumbPhotos()} theme={thumbTheme()} themeName={chooseTheme(thumbTheme()).theme.name} />

      <TakesModal open={showTakes} onClose={() => setShowTakes(false)} analysis={takes} busy={takesBusy}
        canReapply={!!takeSnap.current && takeSnap.current.after === stateKey()}
        onScan={async () => { const r = await scanTakes(); if (r.error) notify(r.error); else notify(r.groups ? `Found ${r.groups} repeated spot${r.groups === 1 ? '' : 's'} across ${r.lines} lines. Pick the takes you want, then cut.` : `No repeated takes in ${r.lines} lines. You can still strike out any line by hand.`) }}
        onApply={() => { const r = applyTakes(); if (r.error) notify(r.error); else notify(`Cut ${r.cuts} spot${r.cuts === 1 ? '' : 's'} (~${r.seconds}s). Undo with Ctrl+Z, or change a take in Takes & history.`) }}
        onSetKeep={setTakeKeep} onToggleDrop={toggleTakeDrop} onSeek={t => setCurrentTime(t)} />

      {ctxMenu && (() => {
        const media = mediaBin.find(m => m.id === ctxMenu.mediaId)
        if (!media) return null
        return (
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={e => e.stopPropagation()}>
            {media.offline && <>
              <button title={media.path} onClick={() => { setCtxMenu(null); void relinkMedia(media) }}>Relink… (find the moved file)</button>
              <div className="ctx-sep" />
            </>}
            {!media.offline && <>
              <button onClick={() => { addToTimeline(media); setCtxMenu(null) }}>Add to timeline</button>
              {media.type !== 'audio' && <button title="Picture only: covers the video at the playhead while its sound keeps playing"
                onClick={() => { placeOnTimeline(media, currentTime, 'v2'); setCtxMenu(null) }}>Add as B-roll at the playhead</button>}
              {media.type === 'audio' && <button onClick={() => { placeOnTimeline(media, currentTime, 'a2'); setCtxMenu(null) }}>Add as a sound effect at the playhead</button>}
              <button onClick={() => { addAsIntro(media); setCtxMenu(null) }}>Add as intro clip ({settings.intro.segment} {settings.intro.seconds}s)</button>
              {media.type !== 'audio' && <button title="Remove a solid green or magenta backdrop so the clip below shows through, applied on export and in the preview"
                onClick={() => { setMediaBin(prev => prev.map(m => m.id === media.id ? { ...m, chromaKey: m.chromaKey ? undefined : KEY_GREEN } : m)); setCtxMenu(null) }}>
                {media.chromaKey ? 'Stop keying the backdrop' : 'Key out a green screen'}
              </button>}
              <div className="ctx-sep" />
            </>}
            <button onClick={() => { setCtxMenu(null); void removeFromBin(media) }}>Remove from bin</button>
          </div>
        )
      })()}

      {showAiClip && (
        <div className="modal-backdrop" onClick={() => { if (!aiClipBusy) setShowAiClip(false) }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head"><h2>AI clip</h2><button className="modal-close" onClick={() => setShowAiClip(false)}>✕</button></div>
            <div className="modal-body">
              <section>
                <p style={{ opacity: .8 }}>Describe a shot, or start from a picture (or the frame under the playhead) and end on another picture: the clip morphs one into the other. It lands in the Media Bin and at the end of v1, in the project's format. Kling and Luma run through fal.ai; Veo 3.1 (with sound) through Gemini.</p>
                <textarea className="duration-input" style={{ width: '100%', minHeight: 70, marginTop: 8 }} placeholder="e.g. slow push-in as the flames rise, dusk, cinematic" value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} />
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
                  <label>From <select value={aiFrom} onChange={e => setAiFrom(e.target.value)}><option value="">(none, text only)</option><option value="__frame">frame under the playhead</option>{mediaBin.filter(m => m.type === 'image' || m.type === 'video').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
                  <label>To <select value={aiTo} onChange={e => setAiTo(e.target.value)}><option value="">(none)</option>{mediaBin.filter(m => m.type === 'image').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
                  <label>Length <select value={aiSeconds} onChange={e => setAiSeconds(+e.target.value)}><option value={5}>5 s</option><option value={8}>8 s</option><option value={10}>10 s</option></select></label>
                </div>
                <div style={{ marginTop: 10 }}>
                  <input className="duration-input" style={{ width: '100%' }} placeholder="fal.ai API key (fal.ai → Keys → Add key). Saved in your settings, never leaves this machine except to fal." value={settings.aiGen?.falKey || ''} onChange={e => setSettings(s => ({ ...s, aiGen: { ...(s.aiGen || {}), falKey: e.target.value.trim() } }))} />
                  <input className="duration-input" style={{ width: '100%', marginTop: 6 }} placeholder="Gemini API key (optional: Veo 3.1 with sound, first + last frame)" value={settings.aiGen?.geminiKey || ''} onChange={e => setSettings(s => ({ ...s, aiGen: { ...(s.aiGen || {}), geminiKey: e.target.value.trim() } }))} />
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center' }}>
                  <button className="hdr-btn" disabled={aiClipBusy} onClick={async () => {
                    if (!aiPrompt.trim() && !aiFrom) { notify('Describe the clip, or pick a picture to start from.'); return }
                    let fromPath: string | undefined, fromTime: number | undefined
                    if (aiFrom === '__frame') { const f = frameUnderPlayhead(); if (!f) { notify('Nothing under the playhead.'); return } fromPath = f.path; fromTime = f.time }
                    else if (aiFrom) fromPath = mediaBin.find(m => m.id === aiFrom)?.path
                    const toPath = aiTo ? mediaBin.find(m => m.id === aiTo)?.path : undefined
                    notify('Generating the clip: 1 to 4 minutes. Keep editing, it lands in the bin when done.')
                    const r = await generateAiClip({ prompt: aiPrompt.trim() || 'bring this picture to life, subtle realistic motion', fromPath, fromTime, toPath, seconds: aiSeconds })
                    if ('error' in r) {
                      // stillRunning: the provider may still deliver (and bill) it, so pressing Generate again would pay twice
                      notify(`AI clip failed: ${r.error}${'stillRunning' in r && r.stillRunning ? ' The job may still finish on the provider’s side, so check your provider dashboard before generating it again.' : ''}`, 'stillRunning' in r && r.stillRunning ? 15000 : undefined)
                      return
                    }
                    notify(`AI clip ready (${r.model}, ${r.seconds}s${r.hasAudio ? ', with sound' : ''}, about $${r.estimateUsd}). It is in the bin and on v1.`)
                    setShowAiClip(false)
                  }}>{aiClipBusy ? 'Generating…' : '✨ Generate'}</button>
                  <span style={{ opacity: .7, fontSize: 12 }}>Roughly 35 to 75 cents per 5 seconds, charged by the provider.</span>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head"><h2>Brand Kit & Settings</h2><button className="modal-close" onClick={() => setShowSettings(false)}>✕</button></div>
            <div className="modal-body">
              <section>
                <div className="sec-title">
                  <h3>Logo / Watermark</h3>
                  <label className="switch"><input type="checkbox" checked={settings.brand.enabled} onChange={e => setSettings(s => ({ ...s, brand: { ...s.brand, enabled: e.target.checked } }))} /> Apply to every export</label>
                </div>
                <div className="logo-row">
                  <div className="logo-preview">{settings.brand.logoPath ? <img src={fileUrl(settings.brand.logoPath)} alt="logo" /> : <span>No logo</span>}</div>
                  <div className="logo-actions">
                    <button onClick={async () => { const p = await window.ipcRenderer.pickLogo(); if (p) setSettings(s => ({ ...s, brand: { ...s.brand, logoPath: p, enabled: true } })) }}>Choose PNG…</button>
                    {settings.brand.logoPath && <button onClick={() => setSettings(s => ({ ...s, brand: { ...s.brand, logoPath: null } }))}>Remove</button>}
                  </div>
                </div>
                <div className="grid2">
                  <label>Position
                    <select value={settings.brand.position} onChange={e => setSettings(s => ({ ...s, brand: { ...s.brand, position: e.target.value as any } }))}>
                      <option value="tl">Top Left</option><option value="tr">Top Right</option><option value="bl">Bottom Left</option><option value="br">Bottom Right</option><option value="center">Center</option>
                    </select>
                  </label>
                  <label>Show
                    <select value={settings.brand.showMode} onChange={e => setSettings(s => ({ ...s, brand: { ...s.brand, showMode: e.target.value as any } }))}>
                      <option value="whole">Whole video</option><option value="intro">Intro only</option><option value="outro">Outro watermark</option>
                    </select>
                  </label>
                  <label>Size - {settings.brand.sizePct}% width<input type="range" min="4" max="40" step="1" value={settings.brand.sizePct} onChange={e => setSettings(s => ({ ...s, brand: { ...s.brand, sizePct: parseInt(e.target.value) } }))} /></label>
                  <label>Opacity - {Math.round(settings.brand.opacity * 100)}%<input type="range" min="0.1" max="1" step="0.05" value={settings.brand.opacity} onChange={e => setSettings(s => ({ ...s, brand: { ...s.brand, opacity: parseFloat(e.target.value) } }))} /></label>
                  {settings.brand.showMode !== 'whole' && <label>Window (s)<input type="number" min="1" step="0.5" value={settings.brand.windowSec} onChange={e => setSettings(s => ({ ...s, brand: { ...s.brand, windowSec: parseFloat(e.target.value) || 5 } }))} /></label>}
                  <label>Fade (s)<input type="number" min="0" step="0.1" value={settings.brand.fade} onChange={e => setSettings(s => ({ ...s, brand: { ...s.brand, fade: parseFloat(e.target.value) || 0 } }))} /></label>
                </div>
              </section>

              <section>
                <div className="sec-title">
                  <h3>Project folder <span className="hint" style={{ fontWeight: 400 }}> -  skip importing altogether</span></h3>
                </div>
                <p className="hint">Point VidHelm at one folder you keep your video work in. Every sub-folder inside it is a project, and opening one loads whatever footage is sitting in that folder. Drop more files in with Explorer and press ↻ in the Media Bin: they’re added, no import step, and your timeline stays as it is. Saving writes back into the same folder, so a project is just a folder you can copy, back up or move (moved files are found again by name).</p>
                <div className="recipe-files">
                  <div className="recipe-file">
                    <span>Folder:</span>
                    <button onClick={async () => { const p = await window.ipcRenderer.pickFolder('Choose the folder that holds your projects'); if (p) setSettings(s => ({ ...s, workspace: { ...s.workspace, root: p } })) }}>
                      {settings.workspace.root || 'Choose a folder…'}
                    </button>
                    {settings.workspace.root && <button title="Stop using a project folder" onClick={() => { setSettings(s => ({ ...s, workspace: { ...s.workspace, root: null } })); setCurrentProject(null) }}>✕</button>}
                  </div>
                  <label className="switch" title="Load every media file in the project folder when you open it">
                    <input type="checkbox" checked={settings.workspace.autoLoad} onChange={e => setSettings(s => ({ ...s, workspace: { ...s.workspace, autoLoad: e.target.checked } }))} /> load the folder’s media automatically
                  </label>
                </div>
                {settings.workspace.root && <p className="hint">{projects.length
                  ? `${projects.length} project${projects.length > 1 ? 's' : ''} in there. Switch between them from the Media Bin.`
                  : 'No sub-folders yet, use + in the Media Bin to start one.'}</p>}
              </section>

              <RecipeSection recipe={settings.recipe} onChange={r => setSettings(s => ({ ...s, recipe: r }))}
                logoPath={settings.brand.logoPath}
                onPickLogo={async () => { const p = await window.ipcRenderer.pickLogo(); if (p) setSettings(s => ({ ...s, brand: { ...s.brand, logoPath: p, enabled: true } })) }} />

              <section>
                <h3>Intro Clip Defaults</h3>
                <div className="grid2">
                  <label>Use segment
                    <select value={settings.intro.segment} onChange={e => setSettings(s => ({ ...s, intro: { ...s.intro, segment: e.target.value as any } }))}><option value="first">First seconds</option><option value="last">Last seconds</option></select>
                  </label>
                  <label>Seconds (0-20)<input type="number" min="0.5" max="20" step="0.5" value={settings.intro.seconds} onChange={e => setSettings(s => ({ ...s, intro: { ...s.intro, seconds: clamp(parseFloat(e.target.value) || 5, 0.5, 20) } }))} /></label>
                  <label>Fade (s)<input type="number" min="0" step="0.1" value={settings.intro.fade} onChange={e => setSettings(s => ({ ...s, intro: { ...s.intro, fade: parseFloat(e.target.value) || 0 } }))} /></label>
                  <label>At the start
                    <select value={settings.intro.treatment} onChange={e => setSettings(s => ({ ...s, intro: { ...s.intro, treatment: e.target.value as any } }))}><option value="ripple">Push everything later</option><option value="overlay">Overlay on top</option></select>
                  </label>
                </div>
                <p className="hint">Right-click any media item → “Add as intro clip” to apply these.</p>
              </section>

              <section>
                <h3>Audio</h3>
                <label className="switch"><input type="checkbox" checked={settings.audio.optimize} onChange={e => setSettings(s => ({ ...s, audio: { ...s.audio, optimize: e.target.checked } }))} /> Auto optimize loudness (−14 LUFS, YouTube target)</label>
                <label className="switch"><input type="checkbox" checked={settings.audio.noiseReduction} onChange={e => setSettings(s => ({ ...s, audio: { ...s.audio, noiseReduction: e.target.checked } }))} /> Noise reduction (FFT denoise + rumble filter)</label>
              </section>

              <section>
                <h3>Caption Style</h3>
                {(() => {
                  const cs = settings.caption
                  const classic = cs.theme === 'classic'
                  const choice = classic ? null : chooseTheme(themeRequest(cs))
                  const capCount = texts.filter(t => t.caption).length
                  const setCap = (patch: Partial<AppSettings['caption']>) => setSettings(s => ({ ...s, caption: { ...s.caption, ...patch } }))
                  return (
                    <div className="theme-picker">
                      <div className="theme-grid">
                        {THEMES.map(th => {
                          const f = THEME_FONTS[th.caption.font]
                          const on = !classic && choice?.theme.id === th.id
                          return (
                            <button key={th.id} type="button" className={`theme-chip ${on ? 'active' : ''}`} title={th.blurb} onClick={() => setCap({ theme: th.id })}>
                              <span className="theme-sample" style={{ fontFamily: `'${f.family}', sans-serif`, fontWeight: f.bold ? 700 : 400, color: th.caption.color, background: th.caption.box ? th.caption.boxColor : '#2a2f3a',
                                WebkitTextStroke: th.caption.outline && !th.caption.box ? `1px ${th.caption.outlineColor}` : undefined, letterSpacing: th.caption.tracking ? `${th.caption.tracking}em` : undefined,
                                textShadow: th.caption.motion === 'glow' ? `0 0 6px ${th.caption.accent}` : th.caption.shadow ? `1px 1px 0 ${th.caption.shadowColor}` : undefined }}>
                                {th.caption.uppercase ? 'SAY ' : 'Say '}<span style={{ color: th.caption.accentCycle?.[0] || th.caption.accent }}>{th.caption.uppercase ? 'HI' : 'hi'}</span>
                              </span>
                              <span className="theme-name">{th.name}</span>
                            </button>
                          )
                        })}
                        <button type="button" className={`theme-chip ${classic ? 'active' : ''}`} title="The plain style: your own font size, colour, position and box below" onClick={() => setCap({ theme: 'classic' })}>
                          <span className="theme-sample" style={{ background: '#2a2f3a' }}>Say hi</span><span className="theme-name">Classic (manual)</span>
                        </button>
                      </div>
                      {!classic && choice && <>
                        <label>Tweak it
                          <input type="text" value={cs.tweak || ''} placeholder="e.g. but blue, bigger, at the top, all caps, no box" onChange={e => setCap({ tweak: e.target.value })} />
                        </label>
                        <p className="hint"><b>{choice.theme.name}</b>: {choice.theme.blurb}{Object.keys(choice.tweaks).length ? ` Tweaked: ${Object.entries(choice.tweaks).map(([k, v]) => `${k} ${v}`).join(', ')}.` : ''}</p>
                        {capCount > 0 && <button type="button" className="ghost-btn" onClick={() => { const r = restyleCaptions(themeRequest(cs)); notify(`Restyled ${r.captions} caption${r.captions === 1 ? '' : 's'} as ${choice.theme.name}.`) }}>Restyle the {capCount} caption{capCount === 1 ? '' : 's'} on the timeline</button>}
                      </>}
                    </div>
                  )
                })()}
                {settings.caption.theme === 'classic' && <>
                <div className="grid2">
                  <label>Position
                    <select value={settings.caption.position} onChange={e => setSettings(s => ({ ...s, caption: { ...s.caption, position: e.target.value as any } }))}>
                      <option value="lower">Lower third</option><option value="center">Center</option><option value="top">Top</option>
                    </select>
                  </label>
                  <label>Color<input type="color" className="color-input" value={settings.caption.color} onChange={e => setSettings(s => ({ ...s, caption: { ...s.caption, color: e.target.value } }))} /></label>
                  <label>Size - {settings.caption.fontSize}px<input type="range" min="20" max="90" step="2" value={settings.caption.fontSize} onChange={e => setSettings(s => ({ ...s, caption: { ...s.caption, fontSize: parseInt(e.target.value) } }))} /></label>
                  <label>Box opacity - {Math.round(settings.caption.boxOpacity * 100)}%<input type="range" min="0" max="1" step="0.05" value={settings.caption.boxOpacity} onChange={e => setSettings(s => ({ ...s, caption: { ...s.caption, boxOpacity: parseFloat(e.target.value) } }))} /></label>
                </div>
                <label className="switch"><input type="checkbox" checked={settings.caption.box} onChange={e => setSettings(s => ({ ...s, caption: { ...s.caption, box: e.target.checked } }))} /> Background bar behind captions</label>
                </>}
                <div className="grid2">
                  <label>Accuracy / speed
                    <select value={settings.caption.model} onChange={e => setSettings(s => ({ ...s, caption: { ...s.caption, model: e.target.value as any } }))}>
                      <option value="tiny">Tiny, fastest</option><option value="base">Base, balanced</option><option value="small">Small, most accurate, slower</option>
                    </select>
                  </label>
                  <label>Language
                    <select value={settings.caption.language} onChange={e => setSettings(s => ({ ...s, caption: { ...s.caption, language: e.target.value } }))}>
                      {CAPTION_LANGS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                    </select>
                  </label>
                  <label>Style
                    <select value={settings.caption.mode} onChange={e => setSettings(s => ({ ...s, caption: { ...s.caption, mode: e.target.value as any } }))}>
                      <option value="phrase">Phrase (sentence cues)</option><option value="word">Word-by-word (karaoke)</option>
                    </select>
                  </label>
                </div>
                <p className="hint">The “Captions” button transcribes the whole timeline on-device (Whisper). Non-English languages use a larger multilingual model (bigger first download).</p>
              </section>

              <section>
                <h3>Performance</h3>
                <p className="hint">
                  VidHelm's analysis is deliberately thorough: reading speech word by word, decoding a whole clip to
                  plan a vertical crop. On a strong machine that is the right trade. On a thin laptop it is the
                  difference between slow and unusable, so the defaults come from your hardware.
                </p>
                <div className="grid2">
                  <label>Effort
                    <select value={settings.performance?.preference || 'auto'}
                      onChange={e => setSettings(s => ({ ...s, performance: { preference: e.target.value as TierPreference } }))}>
                      <option value="auto">Automatic{machine?.detected ? ` (detected: ${{ low: 'lighter', balanced: 'balanced', best: 'most accurate' }[machine.detected]})` : ''}</option>
                      <option value="low">Lighter, quicker</option>
                      <option value="balanced">Balanced</option>
                      <option value="best">Most accurate, slowest</option>
                    </select>
                  </label>
                  <label>In force now
                    <input readOnly value={`speech ${perf.speechModel} · framing ${perf.framingFps}fps · ${perf.thumbnailWorkers} job${perf.thumbnailWorkers === 1 ? '' : 's'} · ${perf.exportPreset}`} />
                  </label>
                </div>
                <p className="hint">{perf.note}</p>
                {machine?.specs && (
                  <p className="hint">
                    Detected: {machine.cpu || 'this machine'} · {machine.specs.cores} logical core{machine.specs.cores === 1 ? '' : 's'} ·{' '}
                    {machine.specs.memGB} GB memory · {machine.specs.hwEncoder ? 'hardware encoder' : 'software encoding'} ·{' '}
                    processor benchmark {Math.round(machine.specs.benchMs)}ms.
                    {machine.reasons?.length ? ` Because: ${machine.reasons.join(', ')}.` : ''}
                  </p>
                )}
                {!machine && <p className="hint">Measuring this machine…</p>}
              </section>
              <section>
                <h3>Cut Dead Space</h3>
                <div className="grid2">
                  <label>Detect by
                    <select value={settings.silence.detectBy} onChange={e => setSettings(s => ({ ...s, silence: { ...s.silence, detectBy: e.target.value as any } }))}>
                      <option value="auto">Auto (audio if present, else video)</option>
                      <option value="audio">Audio silence (voiceover/music)</option>
                      <option value="motion">Visual stillness (no audio)</option>
                    </select>
                  </label>
                  <label>Min length (s)<input type="number" min="0.2" step="0.1" value={settings.silence.minPause} onChange={e => setSettings(s => ({ ...s, silence: { ...s.silence, minPause: Math.max(0.2, parseFloat(e.target.value) || 0.8) } }))} /></label>
                  <label>Silence threshold (dB)<input type="number" max="0" step="1" value={settings.silence.thresholdDb} onChange={e => setSettings(s => ({ ...s, silence: { ...s.silence, thresholdDb: parseFloat(e.target.value) || -30 } }))} /></label>
                  <label>Stillness sensitivity (dB)<input type="number" max="0" step="1" value={settings.silence.freezeDb} onChange={e => setSettings(s => ({ ...s, silence: { ...s.silence, freezeDb: parseFloat(e.target.value) || -50 } }))} /></label>
                  <label>Keep padding (s)<input type="number" min="0" step="0.02" value={settings.silence.pad} onChange={e => setSettings(s => ({ ...s, silence: { ...s.silence, pad: Math.max(0, parseFloat(e.target.value) || 0) } }))} /></label>
                  <label>Transition (s)<input type="number" min="0" step="0.02" value={settings.silence.transition} disabled={!settings.silence.smooth} onChange={e => setSettings(s => ({ ...s, silence: { ...s.silence, transition: Math.max(0, parseFloat(e.target.value) || 0) } }))} /></label>
                </div>
                <label className="switch"><input type="checkbox" checked={settings.silence.smooth} onChange={e => setSettings(s => ({ ...s, silence: { ...s.silence, smooth: e.target.checked } }))} /> Smooth the cuts with a short fade</label>
                <p className="hint">“Cut Pauses” removes dead space and ripples everything left. <b>Audio</b> mode cuts silent gaps; <b>Visual stillness</b> cuts motionless/frozen stretches (for silent footage), raise the stillness sensitivity toward 0 to catch near-static shots.</p>
              </section>
            </div>
            <div className="modal-foot"><span>Settings save automatically and apply to every video.</span><button className="primary" onClick={() => setShowSettings(false)}>Done</button></div>
          </div>
        </div>
      )}

      {showQC && (
        <div className="modal-backdrop" onClick={() => setShowQC(false)}>
          <div className="modal qc" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Watch &amp; Verify {qcReport && !qcReport.error && <span className={`verdict ${qcReport.verdict}`}>{qcReport.verdict === 'pass' ? 'YouTube-ready' : qcReport.verdict === 'warn' ? 'Minor warnings' : 'Issues found'}</span>}</h2>
              <button className="modal-close" onClick={() => setShowQC(false)}>✕</button>
            </div>
            <div className="modal-body">
              {qcRunning && <div className="qc-loading">Analyzing render, loudness, peaks, black frames, sampling frames…</div>}
              {!qcRunning && qcReport?.error && <div className="qc-loading">{qcReport.error}</div>}
              {!qcRunning && qcReport && !qcReport.error && (
                <>
                  <div className="filmstrip">
                    {qcReport.frames?.map((f: any, i: number) => (
                      <div key={i} className="frame"><img src={`${fileUrl(f.path)}?t=${Date.now()}`} alt="" /><span>{f.t.toFixed(1)}s</span></div>
                    ))}
                  </div>
                  <div className="qc-checks">
                    {qcReport.checks?.map((c: any, i: number) => (
                      <div key={i} className={`qc-row ${c.status}`}>
                        <span className="dot" />
                        <span className="qc-label">{c.label}</span>
                        <span className="qc-detail">{c.detail}</span>
                      </div>
                    ))}
                  </div>
                  <p className="hint">Frames are sampled across the video so you can eyeball the picture. Loudness/peak are measured against YouTube's −14 LUFS / −1 dBTP target.</p>
                </>
              )}
            </div>
            <div className="modal-foot">
              <span>{qcReport?.probe ? `${qcReport.probe.width}×${qcReport.probe.height} · ${qcReport.probe.fps}fps · ${qcReport.probe.vcodec} · ${qcReport.probe.duration?.toFixed(1)}s` : ''}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                {lastExport && <button onClick={() => window.ipcRenderer.revealFile(lastExport)}>Show file</button>}
                <button className="primary" onClick={() => setShowQC(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** The editor inside its crash guard, so one bad state shows a recover-and-reload screen instead of
 *  a blank window. The bridge check lives here, ahead of the editor's hooks rather than among them. */
function App() {
  if (!window.ipcRenderer) {
    return (
      <div style={{ background: '#131314', color: '#ffb4ab', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '20px' }}>
        <div><h1>Bridge Error</h1><p>Electron IPC bridge (window.ipcRenderer) is missing.</p></div>
      </div>
    )
  }
  return <CrashGuard><Editor /></CrashGuard>
}

export default App
