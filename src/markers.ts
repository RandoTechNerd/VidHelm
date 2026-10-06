// Tag points: the type and how a new one is made. Kept out of extras.tsx, which holds only
// components, so React Fast Refresh can hot-swap the panels (react-refresh/only-export-components).

export interface Marker { id: string; t: number; label: string; color: string }

const rid = () => Math.random().toString(36).substr(2, 9)
export const MARKER_COLORS = ['#f472b6', '#60a5fa', '#4ade80', '#facc15', '#c084fc', '#fb923c']
export const newMarker = (t: number, label = ''): Marker => ({ id: rid(), t, label, color: MARKER_COLORS[Math.floor(Math.random() * MARKER_COLORS.length)] })
