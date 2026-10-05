/* Line icons for the app chrome. One stroke weight and one grid (24) so the bar reads as a
   single set; emoji render differently on every machine and were what made it look homemade.
   This is the only icon set: App.tsx and the panels draw from here, nothing defines its own. */
import type { ReactNode } from 'react'

const I = ({ size = 15, children, fill, weight = 1.8, className }: { size?: number; children: ReactNode; fill?: boolean; weight?: number; className?: string }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'}
    strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
/** most icons default to the size their usual spot wants; a few spots ask for another */
type S = { size?: number }

export const IcSave = () => <I><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8M7 3v5h8" /></I>
export const IcOpen = () => <I><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></I>
export const IcCloud = () => <I><path d="M12 13v8M8 17l4 4 4-4" /><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" /></I>
export const IcRecipe = () => <I><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" /></I>
export const IcCube = () => <I><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></I>
export const IcSparkle = () => <I><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" /></I>
export const IcBot = () => <I><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4M9 4h6M9 13v1M15 13v1M2 13v2M22 13v2" /></I>
export const IcSun = () => <I><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></I>
export const IcMoon = () => <I><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></I>
export const IcHelp = () => <I><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" /></I>
export const IcRefresh = () => <I size={14}><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></I>
export const IcFolder = () => <I size={14}><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></I>
export const IcPlus = ({ size = 14 }: S) => <I size={size}><path d="M12 5v14M5 12h14" /></I>
export const IcBooth = () => <I size={14}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8" /></I>
export const IcVoice = () => <I size={14}><path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3" /></I>
export const IcCut = () => <I size={14}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" /></I>
export const IcList = () => <I size={14}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></I>
export const IcCheck = () => <I size={13}><path d="M20 6 9 17l-5-5" /></I>
export const IcEye = () => <I size={13}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></I>
export const IcEyeOff = () => <I size={13}><path d="M10.7 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.3 3.2M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20" /></I>
export const IcSearch = () => <I size={13}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></I>
export const IcRecord = () => <I size={13} fill><circle cx="12" cy="12" r="6" /></I>
export const IcPlaySm = () => <I size={11} fill><path d="M7 4.5v15l12.5-7.5Z" /></I>
export const IcChat = () => <I><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01" /></I>
export const IcSend = () => <I size={15}><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></I>
export const IcMail = () => <I size={13}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></I>
export const IcDiscord = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18.2 18.2 0 0 0-5.6 0L8.6 3a19.5 19.5 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18a19.7 19.7 0 0 0 6 3l1.3-2a12.7 12.7 0 0 1-2-1l.5-.4a14 14 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.6 19.6 0 0 0 6-3c.5-5.1-.8-9.5-3.6-13.6ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" /></svg>
export const IcStop = () => <I size={12} fill><rect x="6" y="6" width="12" height="12" rx="1.5" /></I>
export const IcClose = () => <I size={12}><path d="M18 6 6 18M6 6l12 12" /></I>
export const IcDice = () => <I size={13}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 8h.01M16 16h.01M12 12h.01" /></I>
export const IcKey = () => <I size={13}><circle cx="7.5" cy="15.5" r="4.5" /><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" /></I>

// the editor's own controls (these were drawn inline in App.tsx at a heavier stroke)
export const IcExport = ({ size = 18 }: S) => <I size={size}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></I>
export const IcAudio = ({ size = 16 }: S) => <I size={size}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></I>
export const IcTrash = () => <I size={14}><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></I>
export const IcPlay = ({ size = 16 }: S) => <I size={size} fill><path d="M8 5v14l11-7Z" /></I>
export const IcPause = ({ size = 16 }: S) => <I size={size} fill><path d="M6 4h4v16H6ZM14 4h4v16h-4Z" /></I>
export const IcText = () => <I size={14}><path d="M4 7V4h16v3M9 20h6M12 4v16" /></I>
export const IcMic = ({ size = 14 }: S) => <I size={size}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" /></I>
export const IcExpand = () => <I size={14}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></I>
export const IcVolume = () => <I size={14}><path d="M11 5 6 9H2v6h4l5 4V5Z" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" /></I>
export const IcUndo = ({ size = 14 }: S) => <I size={size}><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" /></I>
export const IcRedo = () => <I size={14}><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" /></I>
export const IcCaptions = () => <I size={14}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M7 13h2M7 10h2M13 10h4M13 13h4" /></I>
/** A disclosure arrow, pointing right when closed and down when open (App.css .ic-chevron). It
 *  is drawn heavier than the set: at 12px the shared weight all but disappears. */
export const IcChevron = ({ open = false, size = 12 }: { open?: boolean; size?: number }) =>
  <I size={size} weight={2.6} className={`ic-chevron ${open ? 'open' : ''}`}><path d="m9 18 6-6-6-6" /></I>
export const IcGear = () => <I size={14}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></I>

// panels and dialogs (each of these replaced an emoji or a text glyph)
export const IcCamera = () => <I size={14}><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></I>
export const IcGlobe = ({ size = 14 }: S) => <I size={size}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" /></I>
export const IcFilm = ({ size = 14 }: S) => <I size={size}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4" /></I>
export const IcImage = ({ size = 14 }: S) => <I size={size}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></I>
export const IcTerminal = () => <I size={14}><path d="m4 17 6-6-6-6M12 19h8" /></I>
/** a favourite: filled when it is one */
export const IcStar = ({ filled = false }: { filled?: boolean }) => <I size={14} fill={filled}><path d="M12 2.8l2.85 5.8 6.4.93-4.63 4.5 1.1 6.37L12 17.4l-5.72 3 1.1-6.37-4.63-4.5 6.4-.93Z" /></I>
export const IcDownload = () => <I size={14}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></I>
/** bring files in: an arrow into a tray, drawn unlike Export's so the two never read the same */
export const IcImport = ({ size = 15 }: S) => <I size={size}><path d="M12 3v11M8 10l4 4 4-4" /><path d="M8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3" /></I>
export const IcCopy = () => <I size={14}><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15" /></I>
/** a link that leaves the app for the browser */
export const IcExternal = () => <I size={12}><path d="M7 17 17 7M8 7h9v9" /></I>
export const IcInfo = ({ size = 13 }: S) => <I size={size}><circle cx="12" cy="12" r="10" /><path d="M12 16v-5M12 8h.01" /></I>
/** the handle you drag a floating panel by */
export const IcGrip = () => <I size={14} fill><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></I>

// community links in the Help menu
export const IcGithub = () => <I size={15} fill><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-1.94c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.67.41.35.77 1.05.77 2.12v3.15c0 .3.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" /></I>
export const IcYoutube = () => <I size={16} fill><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.3 31.3 0 0 0 0 12a31.3 31.3 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.3 31.3 0 0 0 24 12a31.3 31.3 0 0 0-.5-5.8ZM9.5 15.5v-7L15.8 12l-6.3 3.5Z" /></I>
export const IcInstagram = () => <I size={15}><rect x="2" y="2" width="20" height="20" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" /></I>
export const IcCoffee = () => <I size={15}><path d="M17 8h1a4 4 0 0 1 0 8h-1" /><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" /><path d="M6 2v2M10 2v2M14 2v2" /></I>
/** a file that is not where the project says it is */
export const IcMissing = () => <I><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M12 12v3M12 18h.01" /></I>

/** The VidHelm mark: a ship's helm around a play triangle. */
export const VidHelmMark = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="0" y="0" width="24" height="24" rx="6" fill="var(--accent-primary)" />
    <g stroke="#fff" strokeWidth="1.6" strokeLinecap="round" fill="none">
      <circle cx="12" cy="12" r="6" />
      <path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2 18 18M18 6l-1.8 1.8M7.8 16.2 6 18" />
    </g>
    <path d="M10.6 9.6v4.8l3.9-2.4Z" fill="#fff" />
  </svg>
)
