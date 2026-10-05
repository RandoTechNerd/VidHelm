/* The first screen. Before anything is on the timeline the preview, the largest thing in the
   window, used to be a black slab reading "1920×1080", and the only way in was a small + on the
   Media tab. These make the empty state say what to do and offer the buttons to do it. App.tsx
   owns the state and decides when they show. */
import type { ReactNode } from 'react'
import { IcAudio, IcCube, IcFilm, IcImage, IcImport, IcOpen } from './icons'

/** The empty stage: shown while the timeline has nothing on it, gone the moment it does. */
export function StageEmpty({ format, hasMedia, onImport, onOpen, recent, onRecent }: {
  /** what the export will be, "1920×1080 · Landscape · 30 fps" */
  format: string
  /** the Media Bin already has something in it, just not on the timeline yet */
  hasMedia: boolean
  onImport: () => void
  onOpen: () => void
  recent: { name: string; path: string }[]
  onRecent: (p: { name: string; path: string }) => void
}) {
  return (
    <div className="stage-empty">
      <div className="stage-empty-frame">
        <span className="stage-empty-icon"><IcFilm size={40} /></span>
        <h2>Drop footage here</h2>
        <p>{hasMedia
          ? 'or double-click something in the Media Bin to start the timeline'
          : 'Video, audio, images or a 3D model, dropped anywhere in the window'}</p>
        <div className="stage-empty-actions">
          <button className="btn primary" onClick={onImport}><IcImport /> Import media</button>
          <button className="btn" onClick={onOpen}><IcOpen /> Open project</button>
        </div>
        {recent.length > 0 && (
          <div className="stage-recent">
            <span>Recent</span>
            {recent.map(p => <button key={p.path} className="btn sm ghost" title={p.path} onClick={() => onRecent(p)}>{p.name}</button>)}
          </div>
        )}
        <div className="stage-format">{format}</div>
      </div>
    </div>
  )
}

/** The empty Media Bin: what it takes, and a way to fill it. `children` is the longer note. */
export function MediaEmpty({ onImport, children }: { onImport: () => void; children?: ReactNode }) {
  return (
    <div className="media-empty">
      <div className="media-empty-types" aria-label="What you can add">
        <span><IcFilm size={13} /> Video</span>
        <span><IcAudio size={13} /> Audio</span>
        <span><IcImage size={13} /> Images</span>
        <span><IcCube /> 3D</span>
      </div>
      <button className="btn primary sm" onClick={onImport}><IcImport size={13} /> Import media</button>
      <p className="hint">or drop files anywhere in the window</p>
      {children}
    </div>
  )
}

/** Shown over the whole window while files are dragged in from Explorer. It takes no clicks or
 *  drops itself: the timeline rows and the Media Bin still catch their own, and anything dropped
 *  elsewhere falls through to the window. */
export function DropOverlay({ startsTimeline }: { startsTimeline: boolean }) {
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div>
        <IcImport size={28} />
        <b>{startsTimeline ? 'Drop to start editing' : 'Drop to add to your Media Bin'}</b>
        <span>{startsTimeline ? 'The first video goes straight onto the timeline' : 'Or drop on a timeline row to place it right there'}</span>
      </div>
    </div>
  )
}
