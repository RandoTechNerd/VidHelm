/**
 * Paint a loaded 3MF from its own object-level colours.
 *
 * three's ThreeMFLoader parses `<m:colorgroup>` but only applies it through
 * per-TRIANGLE properties, so a file that colours whole OBJECTS
 * (`<object pid pindex>` - BREPcode, and several slicers' multi-material
 * plates) arrives flat white. The reading is all in electron/threemf.ts, which
 * is pure and tested; this is the thin three-facing half that maps the result
 * onto the meshes the loader already built.
 */
import * as THREE from 'three'
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { partColours, pickModelEntry, hexInName } from '../electron/threemf'

export interface ThreeMFColorResult {
  /** meshes we actually painted */
  painted: number
  /** meshes we walked */
  total: number
  /** distinct colours applied, for the status line */
  palette: string[]
}

/** nearest ancestor whose name we have a colour for (meshes sit under named groups) */
function lookupUp(o: THREE.Object3D, table: Map<string, string>): string | null {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (p.name) {
      const exact = table.get(p.name)
      if (exact) return exact
      const inline = hexInName(p.name)
      if (inline) return inline
    }
  }
  return null
}

/**
 * Safe on any 3MF: a file with no object-level colours is left exactly as the
 * loader built it and `painted` comes back 0, so the caller can tell "brings
 * its own colours" apart from "loaded white, keep the colour picker live".
 */
export async function applyThreeMFObjectColours(
  root: THREE.Object3D,
  url: string,
  finish: Partial<THREE.MeshStandardMaterialParameters> = {},
): Promise<ThreeMFColorResult> {
  const meshes: THREE.Mesh[] = []
  root.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
  const result: ThreeMFColorResult = { painted: 0, total: meshes.length, palette: [] }
  if (!meshes.length) return result

  let table: Map<string, string>
  try {
    const files = unzipSync(new Uint8Array(await (await fetch(url)).arrayBuffer()))
    const entry = pickModelEntry(Object.keys(files))
    if (!entry) return result
    const xml = new TextDecoder().decode(files[entry])
    table = new Map(partColours(xml).map(p => [p.name, p.hex]))
  } catch {
    return result   // unreadable archive: leave the loader's result alone
  }
  if (!table.size) return result

  const seen = new Set<string>()
  for (const mesh of meshes) {
    const hex = lookupUp(mesh, table)
    if (!hex) continue
    const col = new THREE.Color(hex).convertSRGBToLinear()
    // a near-black part should read as plastic, a bright one as painted trim
    const lum = 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b
    mesh.material = new THREE.MeshStandardMaterial({
      color: col,
      metalness: lum < 0.06 ? 0.05 : 0.15,
      roughness: lum < 0.06 ? 0.55 : 0.4,
      ...finish,
    })
    result.painted++
    seen.add(hex)
  }
  result.palette = [...seen]
  return result
}
