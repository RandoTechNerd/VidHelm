/* Line icons for the app chrome. One stroke weight and one grid (24) so the bar reads as a
   single set; emoji render differently on every machine and were what made it look homemade. */
import type { ReactNode } from 'react'

const I = ({ size = 15, children, fill }: { size?: number; children: ReactNode; fill?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'}
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

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
export const IcPlus = () => <I size={14}><path d="M12 5v14M5 12h14" /></I>
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
