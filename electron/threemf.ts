/**
 * Object-level colours out of a 3MF model file.
 *
 * three's ThreeMFLoader parses `<m:colorgroup>`, but only ever applies it
 * through per-TRIANGLE properties (buildVertexColorMesh). A 3MF that colours
 * whole OBJECTS instead - `<object id="4" pid="1" pindex="2">`, which is what
 * BREPcode and several slicers write for a multi-material plate - misses that
 * path entirely and every part arrives flat white.
 *
 * Pure string work, no DOM and no three, so it runs in the renderer and under
 * `npm run test:threemf` alike. Regex rather than a parser because the model
 * XML is machine-generated and can be tens of megabytes: we only want two
 * attributes off two element kinds, not a tree.
 */

/** `#RRGGBB` or `#RRGGBBAA` -> `#rrggbb`, or null if it is not a colour */
export function normHex(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.trim().match(/^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/)
  return m ? '#' + m[1].toLowerCase() : null
}

/** a hex written into a part's name, e.g. "lid - #E8890C" */
export function hexInName(name: string | null | undefined): string | null {
  const m = name?.match(/#([0-9a-fA-F]{6})\b/)
  return m ? '#' + m[1].toLowerCase() : null
}

const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))?.[1] ?? null

/**
 * Ordered colour lists keyed by resource id. `colorgroup` (colour extension)
 * and `basematerials` (core) are both indexed by an object's `pindex`, so they
 * share one table.
 */
export function colourGroups(xml: string): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  const scan = (openRe: RegExp, closeTag: string, childRe: RegExp) => {
    for (const open of xml.matchAll(openRe)) {
      const id = attr(open[0], 'id')
      if (!id) continue
      const from = open.index! + open[0].length
      const to = xml.indexOf(closeTag, from)
      const body = xml.slice(from, to < 0 ? undefined : to)
      const colours: string[] = []
      for (const c of body.matchAll(childRe)) colours.push(normHex(c[1]) ?? '#ffffff')
      if (colours.length) groups.set(id, colours)
    }
  }
  scan(/<(?:\w+:)?colorgroup\b[^>]*>/g, 'colorgroup>', /<(?:\w+:)?color\b[^>]*\bcolor\s*=\s*"([^"]*)"/g)
  scan(/<basematerials\b[^>]*>/g, 'basematerials>', /<base\b[^>]*\bdisplaycolor\s*=\s*"([^"]*)"/g)
  return groups
}

export interface PartColour {
  /** the object's `name`, which is the only field ThreeMFLoader carries onto the Object3D */
  name: string
  hex: string
  /** how we worked it out, for logging */
  via: 'pindex' | 'name'
}

/**
 * Every object that resolves to a colour, keyed by the name three will use.
 * Objects with no name are skipped: without one there is nothing to match a
 * loaded mesh back to, and guessing by traversal order silently mis-paints.
 */
export function partColours(xml: string): PartColour[] {
  const groups = colourGroups(xml)
  const out: PartColour[] = []
  const seen = new Set<string>()
  for (const m of xml.matchAll(/<object\b[^>]*>/g)) {
    const tag = m[0]
    const name = attr(tag, 'name')
    if (!name || seen.has(name)) continue
    const pid = attr(tag, 'pid')
    const pindex = Number(attr(tag, 'pindex'))
    let hex: string | null = null
    let via: PartColour['via'] = 'pindex'
    const list = pid ? groups.get(pid) : undefined
    if (list && Number.isInteger(pindex) && pindex >= 0 && pindex < list.length) hex = list[pindex]
    if (!hex) { hex = hexInName(name); via = 'name' }
    if (!hex) continue
    seen.add(name)
    out.push({ name, hex, via })
  }
  return out
}

/** the model part inside the .3mf archive, given the unzipped file table */
export function pickModelEntry(names: string[]): string | null {
  return names.find(n => /\.model$/i.test(n) && /^3d\//i.test(n))
    || names.find(n => /\.model$/i.test(n))
    || null
}
