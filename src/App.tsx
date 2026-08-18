import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'
import { SfxPanel, MarkerPanel, KaraokeBooth, NarrationModal, RecipeSection, ThumbnailModal, ConnectModal, DEFAULT_RECIPE, recipeActive, newMarker, type Marker, type SfxItem, type RecipeSettings } from './extras'
import { Model3DModal, KEY_GREEN, KEY_MAGENTA, type Model3DApi } from './model3d'
import { HelpModal, InfoNote, type HelpPanel } from './help'
import { TakesModal, takeStats, type TakeAnalysis } from './takes'
import { groupTakes, removalRanges, removedSeconds, chunksFromWords } from '../electron/takes'
import { planProxy, isHdr } from '../electron/playable'

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
  // frames). Only the preview uses it; exports always read the original file.
  proxyPath?: string
  proxyPct?: number    // 0-100 while it is being made
  proxyNote?: string   // why it needed one, shown in the bin
  hdr?: boolean        // HLG/PQ source: export tone-maps it, or the colour comes out flat
}

interface TimelineClip {
  id: string
  mediaId: string
  type: 'video' | 'audio' | 'image'
  trackId: 'v1' | 'a1' | 'a2'   // video · voice/music · SFX
  start: number       // seconds on timeline
  duration: number    // seconds
  sourceStart: number // seconds into source
  volume: number      // 0.0 - 2.0 (flat gain when no automation points)
  fadeIn: number      // seconds
  fadeOut: number     // seconds
  volumePoints?: { t: number; v: number }[] // automation: t = seconds from clip start, v = gain 0..2
}

interface AppSettings {
  brand: { enabled: boolean; logoPath: string | null; position: 'tl' | 'tr' | 'bl' | 'br' | 'center'; sizePct: number; margin: number; opacity: number; showMode: 'whole' | 'intro' | 'outro'; windowSec: number; fade: number }
  intro: { segment: 'first' | 'last'; seconds: number; fade: number; treatment: 'ripple' | 'overlay' }
  audio: { optimize: boolean; noiseReduction: boolean }
  caption: { fontSize: number; color: string; position: 'lower' | 'top' | 'center'; box: boolean; boxOpacity: number; model: 'tiny' | 'base' | 'small'; language: string; mode: 'phrase' | 'word' }
  silence: { minPause: number; thresholdDb: number; pad: number; smooth: boolean; transition: number; detectBy: 'auto' | 'audio' | 'motion'; freezeDb: number }
  narration: { command: string }
  sfxGen: { command: string }
  workspace: { root: string | null; autoLoad: boolean }
  recipe: RecipeSettings
}

const DEFAULT_SETTINGS: AppSettings = {
  brand: { enabled: false, logoPath: null, position: 'br', sizePct: 16, margin: 40, opacity: 0.85, showMode: 'whole', windowSec: 5, fade: 0.5 },
  intro: { segment: 'first', seconds: 5, fade: 0.6, treatment: 'ripple' },
  audio: { optimize: true, noiseReduction: false },
  caption: { fontSize: 44, color: '#ffffff', position: 'lower', box: true, boxOpacity: 0.5, model: 'tiny', language: 'en', mode: 'phrase' },
  silence: { minPause: 0.8, thresholdDb: -30, pad: 0.12, smooth: true, transition: 0.12, detectBy: 'auto', freezeDb: -50 },
  narration: { command: '' },
  sfxGen: { command: '' },
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
type Probe = { duration: number; hasVideo: boolean; hasAudio: boolean; ok?: boolean; error?: string; format?: string; videoCodec?: string; pixFmt?: string; colorTransfer?: string; width?: number; height?: number; fps?: number }
const JUNK_FORMAT = /(^|,)(tty|ansi|image2pipe|srt|ass|ssa|webvtt|lrc|microdvd|subviewer|jacosub|mpsub|pjs|realtext|sami|vplayer)(,|$)/
const classifyMedia = (name: string, meta: Probe | null): { type: 'video' | 'audio' | 'image' } | { reject: string } => {
  const ext = extOf(name)
  if (WRONG_TYPE[ext]) return { reject: WRONG_TYPE[ext] }
  const knownImage = IMAGE_EXT.has(ext)
  const knownAV = VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)
  if (!meta) return { reject: 'could not be read' }
  if (meta.ok === false || JUNK_FORMAT.test(meta.format || '') || meta.videoCodec === 'ansi') {
    if (knownImage) return { type: 'image' }   // a few image types ffprobe can't parse still display fine
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
}

type OrientationKey = 'landscape' | 'portrait' | 'square'
type ResolutionKey = '4K' | '1440p' | '1080p' | '720p'

const ORIENTATIONS: Record<OrientationKey, { label: string; sub: string; ratio: number; dims: Record<ResolutionKey, [number, number]> }> = {
  landscape: { label: 'Landscape', sub: '16:9', ratio: 16 / 9, dims: { '4K': [3840, 2160], '1440p': [2560, 1440], '1080p': [1920, 1080], '720p': [1280, 720] } },
  portrait:  { label: 'Portrait',  sub: '9:16', ratio: 9 / 16, dims: { '4K': [2160, 3840], '1440p': [1440, 2560], '1080p': [1080, 1920], '720p': [720, 1280] } },
  square:    { label: 'Square',    sub: '1:1',  ratio: 1,      dims: { '4K': [2160, 2160], '1440p': [1440, 1440], '1080p': [1080, 1080], '720p': [720, 720] } },
}

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

// Opacity of a clip at time t given its fades (used for preview + mirrors export)
function fadeFactor(c: { start: number; duration: number; fadeIn: number; fadeOut: number }, t: number) {
  const into = t - c.start
  const toEnd = c.start + c.duration - t
  let o = 1
  if (c.fadeIn > 0) o = Math.min(o, into / c.fadeIn)
  if (c.fadeOut > 0) o = Math.min(o, toEnd / c.fadeOut)
  return clamp(o, 0, 1)
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
function removeRange(clips: TimelineClip[], texts: TextClip[], s: number, e: number, transition: number) {
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
    if (left > 0.05) outClips.push({ ...c, duration: left, fadeOut: overlap > 0 ? 0 : (td > 0 ? td : c.fadeOut) })
    if (right > 0.05) outClips.push({
      ...c, id: rid(),
      start: s - overlap,
      duration: right + overlap,
      sourceStart: c.sourceStart + (e - cs) - overlap,   // pull the source back so motion stays continuous
      fadeIn: overlap > 0 ? overlap : (td > 0 ? td : c.fadeIn),
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
  return { clips: outClips, texts: outTexts }
}

function App() {
  if (!window.ipcRenderer) {
    return (
      <div style={{ background: '#131314', color: '#ffb4ab', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '20px' }}>
        <div><h1>Bridge Error</h1><p>Electron IPC bridge (window.ipcRenderer) is missing.</p></div>
      </div>
    )
  }

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
  const [showSettings, setShowSettings] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [showModel3D, setShowModel3D] = useState(false)
  const [model3DPath, setModel3DPath] = useState<string | null>(null)
  const [boothScript, setBoothScript] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const [showLinks, setShowLinks] = useState(false)
  const [projects, setProjects] = useState<{ name: string; path: string; media: number; saved: boolean; modified: number }[]>([])
  const [currentProject, setCurrentProject] = useState<{ dir: string; name: string } | null>(null)
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
  const [thumbs, setThumbs] = useState<Record<string, { sig: string; path: string }>>({})
  const thumbsRef = useRef<Record<string, { sig: string; path: string }>>({})
  const [collapsed, setCollapsed] = useState<{ text: boolean; video: boolean; audio: boolean; sfx: boolean }>({ text: false, video: false, audio: false, sfx: false })
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
  const [isRecording, setIsRecording] = useState(false)

  const timelineRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageH, setStageH] = useState(400)
  const videoEls = useRef<Map<string, HTMLVideoElement>>(new Map())
  const audioEls = useRef<Map<string, HTMLAudioElement>>(new Map())
  const recorderRef = useRef<{ rec: MediaRecorder; chunks: Blob[]; startTime: number } | null>(null)
  const draggingRef = useRef(false)

  // Undo/redo history over the editable document (clips + texts).
  // Changes are coalesced: a snapshot is taken ~450ms after the last edit,
  // so a drag or a slider sweep collapses into a single undo step.
  const history = useRef<{ clips: TimelineClip[]; texts: TextClip[] }[]>([{ clips: [], texts: [] }])
  const histIndex = useRef(0)
  const skipRecord = useRef(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const [w, h] = ORIENTATIONS[orientation].dims[resolution]
  const totalDuration = (() => {
    const ends = [...clips.map(c => c.start + c.duration), ...texts.map(t => t.start + t.duration)]
    return ends.length ? Math.max(...ends) : 0
  })()

  const selClip = clips.find(c => c.id === selectedId) || null
  const selText = texts.find(t => t.id === selectedId) || null

  const activeVideoClips = clips.filter(c => c.trackId === 'v1' && currentTime >= c.start && currentTime < c.start + c.duration)
  const activeTexts = texts.filter(t => currentTime >= t.start && currentTime < t.start + t.duration)
  const activeKey = activeVideoClips.map(c => c.id).join(',')

  // ---- effects ----
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
    activeVideoClips.forEach(c => {
      const media = mediaBin.find(m => m.id === c.mediaId)
      if (media?.type !== 'video') return
      const el = map.get(c.id)
      if (!el) return
      el.volume = clamp(gainAt(c, currentTime) * masterVolume * fadeFactor(c, currentTime), 0, 1)
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
      el.volume = clamp(gainAt(c, currentTime) * masterVolume * fadeFactor(c, currentTime), 0, 1)
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
      const snap = { clips, texts }
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
  }, [clips, texts])

  const applyHistory = (i: number) => {
    const snap = history.current[i]
    if (!snap) return
    skipRecord.current = true
    setClips(snap.clips)
    setTexts(snap.texts)
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
    const vids = clips.filter(c => c.trackId === 'v1' && mediaBin.find(m => m.id === c.mediaId)?.type === 'video')
    if (!vids.length) return
    const handle = setTimeout(() => {
      vids.forEach(c => {
        const media = mediaBin.find(m => m.id === c.mediaId)
        if (!media) return
        // While a proxy is building, pulling frames from the 4K HEVC original would queue a dozen
        // slow ffmpeg jobs behind it. Wait: the strip regenerates from the proxy once it lands.
        if (media.proxyPct !== undefined) return
        // The strip is stretched across the clip, so a fixed eight frames turn into billboards
        // once you zoom in. Ask for roughly one frame per 110px of clip instead, bucketed so a
        // nudge of the zoom slider does not re-render every filmstrip.
        const widthPx = c.duration * pxPerSec
        const count = clamp(Math.round(widthPx / 110), 6, 120)
        const bucket = Math.round(count / 4)
        const sig = `${Math.round(c.sourceStart * 2)}:${Math.round(c.duration * 2)}:${bucket}:${media.proxyPath ? 'p' : 'o'}`
        if (thumbsRef.current[c.id]?.sig === sig) return
        // the proxy is small and h264: far quicker to pull frames from than a 4K HEVC original
        window.ipcRenderer.makeThumbnails({ filePath: media.proxyPath || media.path, sourceStart: c.sourceStart, duration: c.duration, count: bucket * 4 || 8 })
          .then(r => { const p = r?.path; if (p) setThumbs(prev => ({ ...prev, [c.id]: { sig, path: p } })) })
      })
    }, 400)
    return () => clearTimeout(handle)
  }, [clips, mediaBin, pxPerSec])

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
        const { type } = verdict
        const m = meta as Probe   // a non-reject verdict means the probe succeeded
        const entry: MediaFile = {
          id: rid(), name: file.name, path, type,
          duration: type === 'image' ? 5 : (m.duration || 5),
          hasVideo: m.hasVideo || type === 'image',
          hasAudio: m.hasAudio,
          hdr: isHdr({ colorTransfer: m.colorTransfer }),
        }
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
  // watchable stand-in built in the background. The original stays the master: exports read from
  // it, this is only what plays while you edit. Cached in userData, so it happens once per file.
  const ensureProxies = useCallback(async (items: MediaFile[], probes: Map<string, Probe>) => {
    for (const m of items) {
      if (m.type !== 'video') continue
      const info = probes.get(m.id)
      if (!info) continue
      const plan = planProxy({ ...info, hasVideo: true })
      if (!plan.needed) continue
      setMediaBin(prev => prev.map(x => x.id === m.id ? { ...x, proxyPct: 0, proxyNote: plan.reason } : x))
      const r = await window.ipcRenderer.makeProxy({ filePath: m.path, info: { ...info, hasVideo: true } })
      if (r.path) {
        setMediaBin(prev => prev.map(x => x.id === m.id ? { ...x, proxyPath: r.path, proxyPct: undefined } : x))
        if (!r.cached) notify(`${m.name}: ${plan.reason}, so VidHelm made a preview copy. Your export still uses the original file.`, 9000)
      } else {
        setMediaBin(prev => prev.map(x => x.id === m.id ? { ...x, proxyPct: undefined, proxyNote: 'preview unavailable' } : x))
        notify(`${m.name}: ${plan.reason}, and the preview copy could not be made (${r.error || 'unknown error'}). Editing still works, the preview will stay blank.`, 11000)
      }
    }
  }, [])

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) await importFiles(Array.from(e.target.files))
    e.target.value = ''
  }

  const placeOnTimeline = (media: MediaFile, at: number) => {
    const isAudio = media.type === 'audio'
    setClips(prev => [...prev, {
      id: rid(), mediaId: media.id, type: media.type,
      trackId: isAudio ? 'a1' : 'v1',
      start: Math.max(0, at), duration: media.duration, sourceStart: 0,
      volume: 1.0, fadeIn: 0, fadeOut: 0,
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
    switch (cmd.action) {
      case 'get_state':
        return {
          format: { orientation, resolution, fps, width: w, height: h },
          duration: totalDuration, currentTime, isPlaying,
          mediaBin: mediaBin.map(m => ({ id: m.id, name: m.name, type: m.type, duration: m.duration, path: m.path, chromaKey: m.chromaKey })),
          clips: clips.map(c => ({ id: c.id, track: c.trackId, media: mediaBin.find(m => m.id === c.mediaId)?.name, start: +c.start.toFixed(3), duration: +c.duration.toFixed(3), sourceStart: +c.sourceStart.toFixed(3), volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, automationPoints: c.volumePoints?.length || 0 })),
          texts: texts.map(t => ({ id: t.id, text: t.text, start: +t.start.toFixed(3), duration: +t.duration.toFixed(3), x: t.x, y: t.y, fontSize: t.fontSize, color: t.color })),
          tags: [...markers].sort((a, b) => a.t - b.t).map(m => ({ id: m.id, t: +m.t.toFixed(3), label: m.label })),
          startRecipe: { instructions: settings.recipe.text, active: Object.entries(recipeActive(settings.recipe.text)).filter(([, v]) => v).map(([k]) => k), introAudioPath: settings.recipe.introAudioPath, note: "The user's standing workflow (like start G-code). # lines are OFF. Lines like 'titles 5' are for YOU to do in chat." },
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
        const media: MediaFile = { id: rid(), name: cmd.path.split(/[\\/]/).pop() || 'media', path: cmd.path, type, duration: type === 'image' ? (cmd.duration || 5) : (m.duration || 5), hasVideo: m.hasVideo || type === 'image', hasAudio: m.hasAudio, hdr: isHdr({ colorTransfer: m.colorTransfer }), chromaKey: typeof cmd.chromaKey === 'string' ? cmd.chromaKey : undefined }
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
        const isAudio = media.type === 'audio'
        const clip: TimelineClip = { id: rid(), mediaId: media.id, type: media.type, trackId: cmd.track || (isAudio ? 'a1' : 'v1'), start: cmd.start ?? 0, duration: cmd.duration ?? media.duration, sourceStart: cmd.sourceStart ?? 0, volume: cmd.volume ?? 1, fadeIn: cmd.fadeIn ?? 0, fadeOut: cmd.fadeOut ?? 0 }
        setClips(prev => [...prev, clip])
        return { ok: true, clipId: clip.id }
      }
      case 'update_clip': {
        if (!clips.find(c => c.id === cmd.clipId)) return { error: `clip not found: ${cmd.clipId}` }
        const patch: Partial<TimelineClip> = {}
        for (const k of ['start', 'duration', 'sourceStart', 'volume', 'fadeIn', 'fadeOut', 'trackId'] as const) if (cmd[k] !== undefined) (patch as any)[k] = cmd[k]
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
        const a = { ...c0, id: rid(), duration: off, fadeOut: 0 }
        const b = { ...c0, id: rid(), start: t, duration: c0.duration - off, sourceStart: c0.sourceStart + off, fadeIn: 0 }
        setClips(prev => { const i = prev.findIndex(c => c.id === c0.id); const n = [...prev]; n.splice(i, 1, a, b); return n })
        return { ok: true, left: a.id, right: b.id }
      }
      case 'add_text': {
        const t: TextClip = { id: rid(), text: cmd.text || 'text', start: cmd.start ?? currentTime, duration: cmd.duration ?? 3, x: cmd.x ?? 0.5, y: cmd.y ?? 0.5, fontSize: cmd.fontSize ?? 64, color: cmd.color || '#ffffff', fadeIn: cmd.fadeIn ?? 0.3, fadeOut: cmd.fadeOut ?? 0.3, box: cmd.box, boxOpacity: cmd.boxOpacity }
        setTexts(prev => [...prev, t])
        return { ok: true, textId: t.id }
      }
      case 'update_text': {
        if (!texts.find(t => t.id === cmd.textId)) return { error: `text not found: ${cmd.textId}` }
        const patch: Partial<TextClip> = {}
        for (const k of ['text', 'start', 'duration', 'x', 'y', 'fontSize', 'color', 'fadeIn', 'fadeOut', 'box', 'boxOpacity'] as const) if (cmd[k] !== undefined) (patch as any)[k] = cmd[k]
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
      case 'run_recipe': { await runRecipe(); return { ok: true } }
      case 'sample_frames': {
        const v = cmd.path ? { path: cmd.path } : firstVideo()
        if (!v) return { error: 'no video on the timeline' }
        return await window.ipcRenderer.sampleFrames({ filePath: v.path, count: cmd.count || 8 })
      }
      case 'compose_thumbnail': {
        const v = cmd.path ? { path: cmd.path, name: 'video' } : firstVideo()
        if (!v) return { error: 'no video on the timeline' }
        if (!cmd.outPath) return { error: 'outPath required' }
        return await window.ipcRenderer.composeThumbnail({ filePath: v.path, t: cmd.t ?? 1, subtitle: cmd.subtitle, logoPath: cmd.logoPath ?? settings.brand.logoPath, outPath: cmd.outPath })
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
        await openProjectFolder(hit.path, hit.name)
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
        if (cmd.orientation && ORIENTATIONS[cmd.orientation as OrientationKey]) setOrientation(cmd.orientation)
        if (cmd.resolution) setResolution(cmd.resolution)
        if (cmd.fps) setFps(cmd.fps)
        return { ok: true }
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
        const out: string = cmd.outputPath || await window.ipcRenderer.analysisPath(currentProject?.name || 'timeline')
        setIsPlaying(false)
        setExportProgress(0); setEta(null); exportStartRef.current = Date.now()
        try {
          await window.ipcRenderer.exportVideo({
            clips: clips.map(c => { const m = mediaBin.find(x => x.id === c.mediaId); return { ...c, path: m?.path, hasVideo: m?.hasVideo, hasAudio: m?.hasAudio, hdr: m?.hdr } }),
            texts, brand: { ...settings.brand, enabled: false }, audio: settings.audio, outputPath: out,
            settings: { width: 1280, height: 720, fps: 30, quality: 'analysis', masterVolume },
          })
        } catch (e) { setExportProgress(null); setEta(null); return { error: 'could not render the timeline for analysis: ' + String(e) } }
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
        setIsPlaying(false)
        const payload = {
          clips: clips.map(c => { const media = mediaBin.find(m => m.id === c.mediaId); return { ...c, path: media?.path, hasVideo: media?.hasVideo, hasAudio: media?.hasAudio, hdr: media?.hdr, chromaKey: media?.chromaKey } }),
          texts, brand: settings.brand, audio: settings.audio, outputPath: cmd.outputPath,
          settings: { width: w, height: h, fps, quality: exportQuality, masterVolume },
        }
        // Drive the same progress state the button uses: the human watches it render, and
        // the button re-enables afterwards (it stayed stuck and disabled before).
        setExportProgress(0); setEta(null); exportStartRef.current = Date.now()
        try { await window.ipcRenderer.exportVideo(payload) }
        catch (e) { setExportProgress(null); setEta(null); return { error: 'export failed: ' + String(e) } }
        setExportProgress(100); setEta(null)
        setTimeout(() => setExportProgress(null), 3000)
        setLastExport(cmd.outputPath)
        const qc = cmd.qualityCheck === false ? null : await window.ipcRenderer.qualityCheck(cmd.outputPath).catch(() => null)
        return { ok: true, outputPath: cmd.outputPath, qualityCheck: qc ? { verdict: qc.verdict, checks: qc.checks?.map((c: any) => `${c.status}: ${c.label} - ${c.detail}`) } : undefined }
      }
      default:
        return { error: `unknown action: ${cmd.action}` }
    }
  }
  useEffect(() => {
    const h = async (_e: any, cmd: any) => {
      if (typeof cmd?.id === 'number') {
        if (handledAgentCmds.has(cmd.id)) return           // already ran for this id
        handledAgentCmds.add(cmd.id)
        if (handledAgentCmds.size > 500) for (const id of [...handledAgentCmds].slice(0, 250)) handledAgentCmds.delete(id)
      }
      let result: any
      try { result = await agentExec.current(cmd) } catch (e) { result = { error: String(e) } }
      window.ipcRenderer.send('agent-response', { id: cmd.id, result })
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

  const onTimelineDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const dropTime = timeAtClientX(e.clientX)
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    const added = await importFiles(files)
    let cursor = dropTime
    added.forEach(m => { placeOnTimeline(m, m.type === 'audio' ? dropTime : cursor); if (m.type !== 'audio') cursor += m.duration })
  }

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
    const a = { ...selClip, id: rid(), duration: off, fadeOut: 0 }
    const b = { ...selClip, id: rid(), start: currentTime, duration: selClip.duration - off, sourceStart: selClip.sourceStart + off, fadeIn: 0 }
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

  const addText = () => {
    const t: TextClip = { id: rid(), text: 'New text', start: currentTime, duration: 3, x: 0.5, y: 0.5, fontSize: 64, color: '#ffffff', fadeIn: 0.3, fadeOut: 0.3 }
    setTexts(prev => [...prev, t])
    setSelectedId(t.id)
    startTextEdit(t.id, t.text)   // straight into typing, rather than hunting for a box in the sidebar
  }

  // Local Whisper captions for the WHOLE timeline → timed text cues styled by caption settings
  const generateCaptions = async () => {
    const audioClips = clips.filter(c => c.trackId === 'a1' || mediaBin.find(m => m.id === c.mediaId)?.hasAudio)
    if (!audioClips.length) { notify('Add a clip with audio to the timeline first.'); return }
    const cs = settings.caption
    setCaptioning('Mixing audio…'); setCaptionPct(null)
    try {
      const payload = clips.map(c => { const m = mediaBin.find(x => x.id === c.mediaId); return { path: m?.path, hasAudio: m?.hasAudio, start: c.start, duration: c.duration, volume: c.volume } })
      const mix = await window.ipcRenderer.renderMixAudio({ clips: payload })
      if (mix.error || !mix.path) { notify('Captions: ' + (mix.error || 'could not prepare audio')); return }
      const res = await window.ipcRenderer.transcribe(mix.path, { model: cs.model, language: cs.language, word: cs.mode === 'word' })
      if (res.error) { notify('Captions: ' + res.error); return }
      const cues: TextClip[] = []
      for (const c of res.chunks || []) {
        const text = (c.text || '').trim()
        if (!text) continue
        const dur = Math.max(cs.mode === 'word' ? 0.2 : 0.4, (c.end || c.start + (cs.mode === 'word' ? 0.4 : 2)) - c.start)
        cues.push({ id: rid(), text, start: c.start, duration: dur, x: 0.5, y: CAPTION_Y[cs.position], fontSize: cs.fontSize, color: cs.color, fadeIn: cs.mode === 'word' ? 0 : 0.08, fadeOut: cs.mode === 'word' ? 0 : 0.08, box: cs.box, boxOpacity: cs.boxOpacity })
      }
      if (cues.length) setTexts(prev => [...prev, ...cues])
      else notify('No speech detected.')
    } catch (e) { console.error(e); notify('Captioning failed.') }
    setCaptioning(null); setCaptionPct(null)
  }

  // Transcribe the timeline audio into read-along lines for the karaoke booth (one per phrase).
  // Used by the booth's "Draft from timeline audio" button and the agent's booth_script flow.
  const draftBoothScript = async (): Promise<string | null> => {
    const audioClips = clips.filter(c => c.trackId === 'a1' || mediaBin.find(m => m.id === c.mediaId)?.hasAudio)
    if (!audioClips.length) return null
    try {
      const payload = clips.map(c => { const m = mediaBin.find(x => x.id === c.mediaId); return { path: m?.path, hasAudio: m?.hasAudio, start: c.start, duration: c.duration, volume: c.volume } })
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
    const hasAudio = clips.some(c => c.trackId !== 'v1' || mediaBin.find(m => m.id === c.mediaId)?.hasAudio)
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
        const payload = clips.map(c => { const m = mediaBin.find(x => x.id === c.mediaId); return { path: m?.path, hasAudio: m?.hasAudio, start: c.start, duration: c.duration, sourceStart: c.sourceStart, volume: c.volume } })
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
      if (!ranges.length) return { error: useMotion ? 'No long static stretches found (lower the min length or stillness sensitivity in settings).' : 'No long pauses found (try lowering the minimum pause length in settings).' }
      ranges.sort((a, b) => b.start - a.start) // apply last→first so earlier times stay valid
      let nc = clips, nt = texts, removed = 0
      for (const r of ranges) { const out = removeRange(nc, nt, r.start, r.end, S.smooth ? S.transition : 0); nc = out.clips; nt = out.texts; removed += (r.end - r.start) }
      setClips(nc); setTexts(nt); setSelectedId(null); setCurrentTime(0)
      return { removed: ranges.length, seconds: +removed.toFixed(1), mode: useMotion ? 'stillness' : 'silence' }
    } catch (e) { console.error(e); return { error: 'Cut pauses failed: ' + String(e) } }
    finally { setSilenceBusy(null) }
  }
  const cutDeadSpace = async () => {
    const r = await runCutDeadSpace()
    if (r.error) notify(r.error)
    else notify(`Removed ${r.removed} ${r.mode === 'stillness' ? 'static stretch(es)' : 'pause(s)'} (~${r.seconds}s). Undo with Ctrl+Z if needed.`)
  }

  // ---- Takes & history ----
  // Transcribe the timeline, group the lines that are retakes of each other, and hand the result
  // to the panel. Detection is in electron/takes.ts; nothing is cut until the user applies.
  const stateKey = () => JSON.stringify({ c: clips, t: texts })

  const scanTakes = async (): Promise<{ error?: string; groups?: number; lines?: number; analysis?: TakeAnalysis }> => {
    const hasAudio = clips.some(c => c.trackId !== 'v1' || mediaBin.find(m => m.id === c.mediaId)?.hasAudio)
    if (!hasAudio) return { error: 'Nothing with speech on the timeline yet.' }
    setTakesBusy('Mixing audio…')
    try {
      const payload = clips.map(c => { const m = mediaBin.find(x => x.id === c.mediaId); return { path: m?.path, hasAudio: m?.hasAudio, start: c.start, duration: c.duration, sourceStart: c.sourceStart, volume: c.volume } })
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
    let baseClips = clips, baseTexts = texts
    const snap = takeSnap.current
    if (analysis.applied) {
      if (!snap || snap.after !== stateKey()) return { error: 'The timeline changed since these cuts were applied, re-scan to change takes.' }
      const before = JSON.parse(snap.before) as { c: TimelineClip[]; t: TextClip[] }
      baseClips = before.c; baseTexts = before.t
    }
    const beforeKey = JSON.stringify({ c: baseClips, t: baseTexts })
    let nc = baseClips, nt = baseTexts
    for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
      const out = removeRange(nc, nt, r.start, r.end, settings.silence.smooth ? settings.silence.transition : 0)
      nc = out.clips; nt = out.texts
    }
    setClips(nc); setTexts(nt); setSelectedId(null)
    takeSnap.current = { before: beforeKey, after: JSON.stringify({ c: nc, t: nt }) }
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
        const buf = new Uint8Array(await blob.arrayBuffer())
        const b64 = btoa(Array.from(buf).map(b => String.fromCharCode(b)).join(''))
        const path = await window.ipcRenderer.saveRecording(b64)
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
      let finalPath = customExportPath
      if (!finalPath) {
        finalPath = await window.ipcRenderer.selectSavePath('vidhelm_export.mp4')
        if (!finalPath) { setExportProgress(null); return }
        setCustomExportPath(finalPath)
      }
      const payload = {
        clips: clips.map(c => {
          const media = mediaBin.find(m => m.id === c.mediaId)
          return { ...c, path: media?.path, hasVideo: media?.hasVideo, hasAudio: media?.hasAudio, chromaKey: media?.chromaKey }
        }),
        texts,
        brand: settings.brand,
        audio: settings.audio,
        outputPath: finalPath,
        settings: { width: w, height: h, fps, quality: exportQuality, masterVolume },
      }
      await window.ipcRenderer.exportVideo(payload)
      setExportProgress(100)
      setLastExport(finalPath)
      setTimeout(() => setExportProgress(null), 3000)
      runQualityCheck(finalPath) // auto "watch & verify" the result
    } catch (err) { console.error('Export failed', err); setExportProgress(null) }
  }

  // ---- project folders ----
  // A workspace root holds one sub-folder per project. Opening a project pulls in whatever
  // media is sitting in that folder, so dropping files in with Explorer is the "import".
  const projectData = () => ({ version: 2, mediaBin, clips, texts, markers, orientation, resolution, fps, masterVolume, exportQuality })

  const refreshProjects = async (root: string | null) => {
    if (!root) { setProjects([]); return }
    const r = await window.ipcRenderer.listProjects(root)
    if (r.projects) setProjects(r.projects)
    else { setProjects([]); if (r.error) notify(`Project folder: ${r.error}`) }
  }
  useEffect(() => { refreshProjects(settings.workspace.root) }, [settings.workspace.root])   // eslint-disable-line react-hooks/exhaustive-deps

  const openProjectFolder = async (dir: string, name: string) => {
    const r = await window.ipcRenderer.scanProject(dir)
    if (r.error) { notify(`Could not open ${name}: ${r.error}`); return }
    setIsPlaying(false)
    setCurrentProject({ dir, name })

    // a saved timeline in the folder wins; otherwise start clean with the folder's media
    if (r.project) {
      setMediaBin(r.project.mediaBin || [])
      setClips(r.project.clips || [])
      setTexts(r.project.texts || [])
      setMarkers(r.project.markers || [])
      if (r.project.orientation) setOrientation(r.project.orientation)
      if (r.project.resolution) setResolution(r.project.resolution)
      if (r.project.fps) setFps(r.project.fps)
      if (typeof r.project.masterVolume === 'number') setMasterVolume(r.project.masterVolume)
    } else {
      setClips([]); setTexts([]); setMarkers([]); setMediaBin([])
    }
    setSelectedId(null); setCurrentTime(0)

    if (!settings.workspace.autoLoad) { notify(`Opened ${name}.`); return }
    // pull in everything in the folder that isn't already in the bin
    const known = new Set((r.project?.mediaBin || []).map((m: MediaFile) => m.path))
    const fresh = (r.files || []).filter(f => !known.has(f.path))
    const added: MediaFile[] = []
    for (const f of fresh) {
      const meta = await window.ipcRenderer.getMetadata(f.path).catch(() => null)
      const verdict = classifyMedia(f.name, meta)
      if ('reject' in verdict) continue
      const m = meta as Probe
      added.push({
        id: rid(), name: f.name, path: f.path, type: verdict.type,
        duration: verdict.type === 'image' ? 5 : (m.duration || 5),
        hasVideo: m.hasVideo || verdict.type === 'image', hasAudio: m.hasAudio,
      })
    }
    if (added.length) setMediaBin(prev => [...prev, ...added])
    notify(`${name} - ${added.length ? `${added.length} file${added.length > 1 ? 's' : ''} ready in the Media Bin` : 'no new media in the folder'}${r.project ? ', timeline restored' : ''}.`)
  }

  const newProjectFolder = async () => {
    const root = settings.workspace.root
    if (!root) return
    const name = `Project ${new Date().toISOString().slice(0, 10)}`
    const r = await window.ipcRenderer.createProject({ root, name })
    if (r.error || !r.path) { notify(`Could not create the project: ${r.error || 'unknown error'}`); return }
    await refreshProjects(root)
    setCurrentProject({ dir: r.path, name: r.name || name })
    setMediaBin([]); setClips([]); setTexts([]); setMarkers([]); setCurrentTime(0)
    notify(`Created ${r.name}. Drop footage into that folder and hit ↻, no import needed.`)
    window.ipcRenderer.revealFolder(r.path)
  }

  const saveProject = async () => {
    try {
      // inside a project folder this is silent; otherwise fall back to the file dialog
      if (currentProject) {
        const r = await window.ipcRenderer.saveProjectTo({ dir: currentProject.dir, data: projectData() })
        notify(r.path ? `Saved into ${currentProject.name}.` : `Save failed: ${r.error || 'unknown error'}`)
        refreshProjects(settings.workspace.root)
        return
      }
      await window.ipcRenderer.saveProject(projectData())
    } catch (e) { console.error(e) }
  }

  const loadProject = async () => {
    try {
      const data = await window.ipcRenderer.loadProject()
      if (!data) return
      setIsPlaying(false)
      setMediaBin(data.mediaBin || [])
      setClips(data.clips || [])
      setTexts(data.texts || [])
      setMarkers(data.markers || [])
      if (data.orientation) setOrientation(data.orientation)
      if (data.resolution) setResolution(data.resolution)
      if (data.fps) setFps(data.fps)
      if (typeof data.masterVolume === 'number') setMasterVolume(data.masterVolume)
      if (data.exportQuality) setExportQuality(data.exportQuality)
      setSelectedId(null)
      setCurrentTime(0)
      // reset history to the loaded state
      skipRecord.current = true
      history.current = [{ clips: data.clips || [], texts: data.texts || [] }]
      histIndex.current = 0
      setCanUndo(false); setCanRedo(false)
    } catch (e) { console.error(e) }
  }

  // ---- generic drags on timeline ----
  const startClipMove = (e: React.MouseEvent, clip: TimelineClip) => {
    e.stopPropagation()
    setSelectedId(clip.id)
    const startX = e.clientX
    const origStart = clip.start
    draggingRef.current = false
    const others = clips.filter(c => c.trackId === clip.trackId && c.id !== clip.id)
    const move = (m: MouseEvent) => {
      const dx = m.clientX - startX
      if (Math.abs(dx) > 3) draggingRef.current = true
      let ns = Math.max(0, origStart + dx / pxPerSec)
      // snap to 0, playhead, tag points and neighbour edges
      const snaps = [0, currentTime, ...markers.map(mk => mk.t), ...others.flatMap(o => [o.start, o.start + o.duration])]
      for (const s of snaps) { if (Math.abs(ns - s) < 6 / pxPerSec) { ns = s; break } }
      setClips(prev => prev.map(c => c.id === clip.id ? { ...c, start: ns } : c))
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setTimeout(() => { draggingRef.current = false }, 0) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  const startTrim = (e: React.MouseEvent, clip: TimelineClip, side: 'left' | 'right') => {
    e.stopPropagation()
    const startX = e.clientX
    const o = { ...clip }
    const move = (m: MouseEvent) => {
      const dt = (m.clientX - startX) / pxPerSec
      setClips(prev => prev.map(c => {
        if (c.id !== clip.id) return c
        if (side === 'left') {
          const newStart = Math.max(0, Math.min(o.start + dt, o.start + o.duration - 0.3))
          return { ...c, start: newStart, duration: o.duration - (newStart - o.start), sourceStart: o.sourceStart + (newStart - o.start) }
        }
        return { ...c, duration: Math.max(0.3, o.duration + dt) }
      }))
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
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

  const patchClip = (patch: Partial<TimelineClip>) => setClips(prev => prev.map(c => c.id === selectedId ? { ...c, ...patch } : c))
  const patchText = (patch: Partial<TextClip>) => setTexts(prev => prev.map(t => t.id === selectedId ? { ...t, ...patch } : t))

  // ---- render ----
  // Pick a tick spacing that leaves room for its own label, otherwise zooming out prints every
  // five seconds on top of itself. Steps climb through the units people actually think in.
  const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  const tickStep = TICK_STEPS.find(step => step * pxPerSec >= 58) ?? TICK_STEPS[TICK_STEPS.length - 1]
  // seconds while they fit, m:ss once a tick is a minute or more
  const tickLabel = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  const rulerTicks = []
  for (let s = 0; s <= Math.ceil(totalDuration) + tickStep; s += tickStep) {
    rulerTicks.push(<div key={s} className={`tick ${tickStep >= 60 && s % (tickStep * 2) === 0 ? 'major' : ''}`} style={{ left: s * pxPerSec }}><span>{tickLabel(s)}</span></div>)
  }

  const renderClip = (c: TimelineClip) => {
    const media = mediaBin.find(m => m.id === c.mediaId)
    let bg: string | undefined
    let bgSize = '100% 100%'
    if (c.trackId === 'v1' && media) {
      if (media.type === 'image') { bg = `url("${fileUrl(media.path)}")`; bgSize = 'cover' }
      else if (thumbs[c.id]?.path) bg = `url("${fileUrl(thumbs[c.id].path)}")`
    }
    return (
      <div
        key={c.id}
        onMouseDown={(e) => startClipMove(e, c)}
        className={`clip ${c.trackId !== 'v1' ? 'a-clip' : 'v-clip'} ${c.type} ${bg ? 'has-thumb' : ''} ${selectedId === c.id ? 'selected' : ''}`}
        style={{ left: c.start * pxPerSec, width: c.duration * pxPerSec, backgroundImage: bg, backgroundSize: bgSize, backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }}
        title={media?.name}
      >
        <div className="trim-handle left" onMouseDown={(e) => startTrim(e, c, 'left')} />
        {c.fadeIn > 0 && <div className="fade-tri in" style={{ width: c.fadeIn * pxPerSec }} />}
        <span className="clip-label">{media?.name}</span>
        {c.fadeOut > 0 && <div className="fade-tri out" style={{ width: c.fadeOut * pxPerSec }} />}
        <div className="trim-handle right" onMouseDown={(e) => startTrim(e, c, 'right')} />
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
        <div className="logo-section">
          <h1>VidHelm</h1>
          <button className="hdr-btn" onClick={saveProject} title="Save project">Save</button>
          <button className="hdr-btn" onClick={loadProject} title="Open project">Open</button>
          <button className="hdr-btn" onClick={runRecipe} title="Run your Start Recipe on this timeline">🚀 Recipe</button>
          <button className="hdr-btn" onClick={() => { setModel3DPath(null); setShowModel3D(true) }} title="3D Studio, turn an STL / 3MF / OBJ into a spinning turntable clip">🧊 3D</button>
          <button className="hdr-btn" onClick={() => setShowConnect(true)} title="Connect your AI, one-click setup + troubleshooter">🤖 AI</button>
        </div>
        <div className="orientation-switch">
          {(Object.keys(ORIENTATIONS) as OrientationKey[]).map(key => (
            <button key={key} className={`orient-btn ${orientation === key ? 'active' : ''}`} onClick={() => setOrientation(key)} title={`${ORIENTATIONS[key].label} (${ORIENTATIONS[key].sub})`}>
              <span className={`orient-glyph ${key}`} />{ORIENTATIONS[key].label}
            </button>
          ))}
        </div>
        <div className="header-info">
          <span className="hdr-count">{clips.length + texts.length} items • {fmt(currentTime)} / {fmt(totalDuration)}</span>
          <div className="hdr-right">
            <button className="hdr-btn icon" onClick={e => { e.stopPropagation(); setShowLinks(v => !v) }} title="Links and contact">
              <IconInfo />
            </button>
            <button className="hdr-btn icon" onClick={() => setShowHelp(true)} title="Take the tour, and see credits and licences">?</button>
            <button className="hdr-btn icon" onClick={() => setShowSettings(true)} title="Brand kit & settings"><IconGear /></button>
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
        </div>
      </header>

      <main className={expanded ? 'expanded' : ''}>
        {!expanded && (
          <div className="sidebar left">
            <div className="section-header tabs">
              <button className={`tab ${sidebarTab === 'media' ? 'active' : ''}`} onClick={() => setSidebarTab('media')}>Media Bin</button>
              <button className={`tab ${sidebarTab === 'sfx' ? 'active' : ''}`} onClick={() => setSidebarTab('sfx')} title="Sound effects, audition and drop on the SFX track">SFX</button>
              {sidebarTab === 'media' && <label className="add-btn" title="Add video, audio or images, or a 3D model (STL / 3MF / OBJ / GLB)"><IconPlus /><input type="file" accept={ACCEPT_ATTR} multiple onChange={handleFileUpload} hidden /></label>}
            </div>
            {sidebarTab === 'sfx' && <SfxPanel onPlace={placeSfx} genCommand={settings.sfxGen.command} onGenCommand={c => setSettings(s => ({ ...s, sfxGen: { command: c } }))} />}
            {sidebarTab === 'media' && settings.workspace.root && (
              <div className="proj-bar">
                <select value={currentProject?.dir || ''} title="Each sub-folder of your project folder is a project"
                  onChange={e => { const p = projects.find(x => x.path === e.target.value); if (p) openProjectFolder(p.path, p.name) }}>
                  <option value="" disabled>Open a project…</option>
                  {projects.map(p => <option key={p.path} value={p.path}>{p.name}{p.media ? ` · ${p.media} file${p.media > 1 ? 's' : ''}` : ''}{p.saved ? ' ✓' : ''}</option>)}
                </select>
                <button onClick={newProjectFolder} title="Create a new project folder">+</button>
                <button title="Rescan this folder for new files" disabled={!currentProject}
                  onClick={() => currentProject && openProjectFolder(currentProject.dir, currentProject.name)}>↻</button>
                <button title="Show the folder in Explorer" disabled={!currentProject}
                  onClick={() => currentProject && window.ipcRenderer.revealFolder(currentProject.dir)}>📂</button>
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
                <div key={m.id} className="media-item" onDoubleClick={() => addToTimeline(m)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, mediaId: m.id }) }} title="Double-click to add • right-click for options">
                  <div className="media-icon">
                    {m.type === 'image'
                      ? <img className="media-still" src={fileUrl(m.path)} alt="" />
                      : m.type === 'video'
                        ? <video className="media-still" src={`${fileUrl(m.proxyPath || m.path)}#t=0.5`} muted preload="metadata" />
                        : <IconAudio/>}
                  </div>
                  <div className="media-info">
                    <span className="name">{m.name}</span>
                    <span className="duration">
                      {m.type === 'image' ? 'Image • 5s' : `${Math.round(m.duration)}s`}
                      {m.proxyPct !== undefined && <span className="prox building" title={`${m.proxyNote}. Building a preview copy, the original is untouched.`}> · preview copy {m.proxyPct}%</span>}
                      {m.proxyPct === undefined && m.proxyPath && <span className="prox" title={`${m.proxyNote}. Editing plays a preview copy; your export still uses the original file.`}> · proxy</span>}
                      {m.proxyPct === undefined && !m.proxyPath && m.proxyNote && <span className="prox warn" title={m.proxyNote}> · no preview</span>}
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
              {activeVideoClips.map(c => {
                const media = mediaBin.find(m => m.id === c.mediaId)
                if (!media) return null
                const op = fadeFactor(c, currentTime)
                return media.type === 'image'
                  ? <img key={c.id} className="layer" style={{ opacity: op, filter: media.chromaKey ? `url(#${keyFilterFor(media.chromaKey)})` : undefined }} src={fileUrl(media.path)} alt="" />
                  : <video key={c.id} ref={el => { if (el) videoEls.current.set(c.id, el); else videoEls.current.delete(c.id) }} className="layer"
                      style={{ opacity: op, filter: media.chromaKey ? `url(#${keyFilterFor(media.chromaKey)})` : undefined }} src={fileUrl(media.proxyPath || media.path)} />
              })}
              {activeTexts.map(t => (
                <div key={t.id} className={`text-layer ${selectedId === t.id && !isPlaying ? 'editing' : ''} ${editingTextId === t.id ? 'typing' : ''}`}
                  style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%`, fontSize: `${t.fontSize / 1080 * stageH}px`, color: t.color, opacity: fadeFactor(t, currentTime), background: t.box ? `rgba(0,0,0,${t.boxOpacity ?? 0.5})` : 'transparent', padding: t.box ? '0.15em 0.4em' : 0, borderRadius: t.box ? '4px' : 0 }}
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

          <div className="timeline-actions">
            <button className="tool-btn play" onClick={() => setIsPlaying(p => !p)} disabled={totalDuration <= 0}>{isPlaying ? <IconPause /> : <IconPlay />} {isPlaying ? 'Pause' : 'Play'}</button>
            <div className="divider" />
            <button className="tool-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)"><IconUndo /> Undo</button>
            <button className="tool-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"><IconRedo /> Redo</button>
            <div className="divider" />
            <button className="tool-btn" onClick={splitAtPlayhead} disabled={!selClip}><IconScissors /> Split</button>
            <button className="tool-btn" onClick={deleteSelected} disabled={!selectedId}><IconTrash /> Delete</button>
            <button className="tool-btn" onClick={addText}><IconText /> Text</button>
            <button className={`tool-btn ${isRecording ? 'recording' : ''}`} onClick={toggleRecord}><IconMic /> {isRecording ? 'Stop' : 'Voiceover'}</button>
            <button className={`tool-btn ${showBooth ? 'active' : ''}`} onClick={() => setShowBooth(b => !b)} title="Karaoke booth, read a script along with the video in one take">🎙 Booth</button>
            <button className="tool-btn" onClick={() => setShowNarration(true)} title="Generate narration with a cloned voice (external TTS tool)">🗣 Narrate</button>
            <button className="tool-btn captions-btn" onClick={generateCaptions} disabled={captioning !== null || totalDuration <= 0} title="Auto-caption the whole timeline (on-device Whisper)">
              <IconCaptions /> {captioning ? `${captioning}${captionPct !== null ? ` ${captionPct}%` : '…'}` : 'Captions'}
              {captioning && captionPct !== null && <span className="cap-bar"><span className="cap-fill" style={{ width: `${captionPct}%` }} /></span>}
            </button>
            <button className="tool-btn" onClick={cutDeadSpace} disabled={silenceBusy !== null || totalDuration <= 0} title="Detect & remove long silent pauses (great for faceless videos)"><IconScissors /> {silenceBusy || 'Cut Pauses'}</button>
            <button className="tool-btn tk-btn" onClick={() => setShowTakes(true)} disabled={takesBusy !== null}
              title="Takes & history: find repeated takes, keep the best one, and see the full transcript of what was cut">
              📋 {takesBusy || 'Takes'}{takeStats(takes).cuts > 0 && <span className="tk-badge">{takeStats(takes).cuts}</span>}
            </button>
            <div className="spacer" />
            <div className="zoom">
              <button onClick={() => setPxPerSec(p => clamp(p / 1.4, 2, 200))}>−</button><span>Zoom</span><button onClick={() => setPxPerSec(p => clamp(p * 1.4, 2, 200))}>+</button>
              <button className="zoom-fit" title="Zoom to fit, see every clip at once (Ctrl+scroll on the timeline also zooms)" disabled={totalDuration <= 0}
                onClick={() => { const w = timelineRef.current?.clientWidth || 800; setPxPerSec(clamp((w - 60) / Math.max(totalDuration, 0.5), 2, 200)); if (timelineRef.current) timelineRef.current.scrollLeft = 0 }}>Fit</button>
            </div>
          </div>

          <div className="resize-handle" onMouseDown={startResizeTimeline} title="Drag to resize timeline" />

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
              <div className="time-ruler" title="Drag to scrub" {...scrubHandlers}>{rulerTicks}</div>
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
              <div className="tracks">
                <button className="track-label" onClick={() => setCollapsed(c => ({ ...c, text: !c.text }))}><IconChevron open={!collapsed.text} /> TEXT</button>
                {!collapsed.text && (
                  <div className="track text-track">
                    {texts.map(t => (
                      <div key={t.id} onMouseDown={(e) => { e.stopPropagation(); setSelectedId(t.id) }}
                        onDoubleClick={(e) => { e.stopPropagation(); setCurrentTime(t.start + Math.min(0.2, t.duration / 2)); startTextEdit(t.id) }}
                        className={`clip text-clip ${selectedId === t.id ? 'selected' : ''}`} style={{ left: t.start * pxPerSec, width: t.duration * pxPerSec }} title={`${t.text}  (double-click to type)`}>
                        <span className="clip-label"><IconText /> {t.text}</span>
                      </div>
                    ))}
                  </div>
                )}
                <button className="track-label" onClick={() => setCollapsed(c => ({ ...c, video: !c.video }))}><IconChevron open={!collapsed.video} /> VIDEO</button>
                {!collapsed.video && <div className="track v-track">{clips.filter(c => c.trackId === 'v1').map(renderClip)}</div>}
                <button className="track-label" onClick={() => setCollapsed(c => ({ ...c, audio: !c.audio }))}><IconChevron open={!collapsed.audio} /> VOICE / MUSIC</button>
                {!collapsed.audio && <div className="track a-track">{clips.filter(c => c.trackId === 'a1').map(renderClip)}</div>}
                <button className="track-label" onClick={() => setCollapsed(c => ({ ...c, sfx: !c.sfx }))}><IconChevron open={!collapsed.sfx} /> SFX</button>
                {!collapsed.sfx && <div className="track a-track sfx-track">{clips.filter(c => c.trackId === 'a2').map(renderClip)}</div>}
              </div>
            </div>
          </div>
        </div>

        {!expanded && (
          <div className="sidebar right">
            <div className="control-group">
              <h3 className="group-title">Export Settings</h3>
              <div className="card">
                <div className="field"><label>Format</label><div className="format-readout">{ORIENTATIONS[orientation].label} · {ORIENTATIONS[orientation].sub} · {w}×{h}</div></div>
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
                    <button className="reveal-link" onClick={() => window.ipcRenderer.revealFile(lastExport)}>✓ Show in folder</button>
                    <button className="reveal-link" onClick={() => runQualityCheck(lastExport)}>🔍 Watch &amp; Verify</button>
                  </div>
                )}
              </div>
            </div>

            <div className="control-group">
              <h3 className="group-title">Tag Points {markers.length > 0 && <span className="count-badge">{markers.length}</span>}</h3>
              <div className="card">
                <MarkerPanel markers={markers} currentTime={currentTime} onChange={setMarkers} onSeek={t => setCurrentTime(t)} />
              </div>
            </div>

            {selClip && (
              <div className="control-group">
                <h3 className="group-title">Clip Adjustments</h3>
                <div className="card">
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
                  <div className="field"><label>Duration (s)</label><input type="number" step="0.1" min="0.1" className="duration-input" value={selClip.duration.toFixed(2)} onChange={e => patchClip({ duration: parseFloat(e.target.value) || 0.1 })} /></div>
                  <p className="hint">Overlap two video clips and give them fades for a transparent crossfade.</p>
                </div>
              </div>
            )}

            {selText && (
              <div className="control-group">
                <h3 className="group-title">Text</h3>
                <div className="card">
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
              </div>
            )}
          </div>
        )}
      </main>

      <div className="toasts">{toasts.map(t => <div key={t.id} className="toast" onClick={() => setToasts(x => x.filter(y => y.id !== t.id))}>{t.text}</div>)}</div>

      <KaraokeBooth open={showBooth} onClose={() => setShowBooth(false)} markers={markers}
        totalDuration={totalDuration} currentTime={currentTime} isPlaying={isPlaying}
        onSeek={t => setCurrentTime(t)} onPlay={p => setIsPlaying(p)} onRecorded={boothRecorded}
        script={boothScript} onScript={setBoothScript} onDraft={draftBoothScript} />
      <NarrationModal open={showNarration} onClose={() => setShowNarration(false)}
        command={settings.narration.command}
        onCommand={c => setSettings(s => ({ ...s, narration: { command: c } }))}
        onGenerated={narrationGenerated} />

      <ConnectModal open={showConnect} onClose={() => setShowConnect(false)} />
      <HelpModal open={showHelp} onClose={() => setShowHelp(false)} version={appVersion}
        onOpenPanel={(p: HelpPanel) => {
          if (p === 'media' || p === 'sfx') setSidebarTab(p)
          else if (p === 'booth') setShowBooth(true)
          else if (p === 'narration') setShowNarration(true)
          else if (p === 'thumbnail') setShowThumbnail(true)
          else if (p === 'settings') setShowSettings(true)
          else if (p === 'connect') setShowConnect(true)
          else if (p === 'model3d') { setModel3DPath(null); setShowModel3D(true) }
        }} />
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
        videoPath={firstVideo()?.path || null} videoName={firstVideo()?.name || 'video'} logoPath={settings.brand.logoPath} />

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
            <button onClick={() => { addToTimeline(media); setCtxMenu(null) }}>Add to timeline</button>
            <button onClick={() => { addAsIntro(media); setCtxMenu(null) }}>Add as intro clip ({settings.intro.segment} {settings.intro.seconds}s)</button>
            {media.type !== 'audio' && <button title="Remove a solid green or magenta backdrop so the clip below shows through, applied on export and in the preview"
              onClick={() => { setMediaBin(prev => prev.map(m => m.id === media.id ? { ...m, chromaKey: m.chromaKey ? undefined : KEY_GREEN } : m)); setCtxMenu(null) }}>
              {media.chromaKey ? 'Stop keying the backdrop' : 'Key out a green screen'}
            </button>}
            <div className="ctx-sep" />
            <button onClick={() => { setMediaBin(prev => prev.filter(m => m.id !== media.id)); setCtxMenu(null) }}>Remove from bin</button>
          </div>
        )
      })()}

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
                <p className="hint">Point VidHelm at one folder you keep your video work in. Every sub-folder inside it is a project, and opening one loads whatever footage is sitting in that folder, drop files in with Explorer and they’re simply there, no import step. Saving writes back into the same folder, so a project is just a folder you can copy, back up or move.</p>
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

export default App
