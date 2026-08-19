// Searching free sound-effect libraries from inside the app.
//
// Two providers, chosen after testing what is actually reachable:
//
//   FREESOUND      the real library: hundreds of thousands of well-tagged effects, explicit
//                  per-sound licences, and previews that need only an API token (not OAuth).
//                  The token is free but the user has to create it themselves.
//   WIKIMEDIA      no key at all, proper licence metadata, and a much smaller and patchier
//   COMMONS        selection. It is here so that search works the moment the app is installed.
//
// Deliberately NOT included: Internet Archive. It has plenty of audio, but a test search returned
// mostly irrelevant items and, worse, `licenseurl: null` on most of them. A sound with no stated
// licence is worse than no sound at all for someone monetising a channel.
//
// Everything here is pure: URL building, response parsing, licence classification and
// attribution. The HTTP lives in main.ts so `npm run test:sfxsearch` needs no network.

export type Provider = 'freesound' | 'commons'

export interface LicenseInfo {
  code: 'cc0' | 'pd' | 'by' | 'by-sa' | 'by-nc' | 'by-nd' | 'sampling+' | 'unknown'
  name: string
  /** must credit the author somewhere the audience can see it */
  needsAttribution: boolean
  /** safe on a monetised video */
  commercialOk: boolean
  /** derivative works must carry the same licence (matters if the video is the derivative) */
  shareAlike: boolean
  url?: string
}

export interface SoundHit {
  provider: Provider
  id: string
  name: string
  seconds: number
  author: string
  license: LicenseInfo
  /** the file to audition and to save */
  audioUrl: string
  /** where a human can see it in context */
  pageUrl: string
  tags: string[]
}

// ---------------------------------------------------------------------------
// licences
// ---------------------------------------------------------------------------

const LICENSES: Record<string, LicenseInfo> = {
  cc0: { code: 'cc0', name: 'CC0 (public domain)', needsAttribution: false, commercialOk: true, shareAlike: false, url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  pd: { code: 'pd', name: 'Public domain', needsAttribution: false, commercialOk: true, shareAlike: false },
  by: { code: 'by', name: 'CC BY (credit required)', needsAttribution: true, commercialOk: true, shareAlike: false, url: 'https://creativecommons.org/licenses/by/4.0/' },
  'by-sa': { code: 'by-sa', name: 'CC BY-SA (credit + share alike)', needsAttribution: true, commercialOk: true, shareAlike: true, url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  'by-nc': { code: 'by-nc', name: 'CC BY-NC (non-commercial only)', needsAttribution: true, commercialOk: false, shareAlike: false, url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
  'by-nd': { code: 'by-nd', name: 'CC BY-ND (no derivatives)', needsAttribution: true, commercialOk: false, shareAlike: false },
  'sampling+': { code: 'sampling+', name: 'Sampling+', needsAttribution: true, commercialOk: false, shareAlike: false },
  unknown: { code: 'unknown', name: 'Licence not stated', needsAttribution: true, commercialOk: false, shareAlike: false },
}

/**
 * Work out what a licence string means, from either provider's wording.
 *
 * Unrecognised means `unknown`, and unknown is treated as NOT safe to use. That is the
 * conservative direction on purpose: the cost of being wrong is a copyright strike on somebody's
 * channel, and "it probably came from a free site" is not a defence.
 */
export function classifyLicense(raw: string | undefined | null): LicenseInfo {
  const s = (raw || '').toLowerCase().trim()
  if (!s) return LICENSES.unknown
  // "Creative Commons 0" is Freesound's own wording and matches none of the obvious patterns,
  // so without it every CC0 sound on the biggest provider reads as unlicensed and gets hidden
  if (s.includes('publicdomain/zero') || s.includes('cc0') || s.includes('creative commons 0')) return LICENSES.cc0
  if (s.includes('public domain') || s === 'pd' || s.includes('/publicdomain/')) return LICENSES.pd
  // order matters: "attribution noncommercial sharealike" must not read as plain attribution
  const nc = s.includes('noncommercial') || s.includes('non-commercial') || s.includes('-nc')
  const sa = s.includes('sharealike') || s.includes('share alike') || s.includes('-sa')
  const nd = s.includes('noderiv') || s.includes('-nd')
  if (s.includes('sampling+') || s.includes('sampling plus')) return LICENSES['sampling+']
  if (nd) return LICENSES['by-nd']
  if (nc) return LICENSES['by-nc']
  if (sa) return LICENSES['by-sa']
  if (s.includes('attribution') || s.includes('cc by') || s.includes('/licenses/by')) return LICENSES.by
  return LICENSES.unknown
}

/** The default filter for someone who monetises: usable commercially, licence actually stated. */
export const isSafeForYouTube = (l: LicenseInfo): boolean => l.commercialOk && l.code !== 'unknown'

// ---------------------------------------------------------------------------
// request building
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** seconds; sound effects are short, and the default keeps music out of the results */
  maxSeconds?: number
  minSeconds?: number
  pageSize?: number
  /** only return things that can be used on a monetised video */
  safeOnly?: boolean
  /** anything longer than this cannot be a sound effect at all (default 300s) */
  hardMaxSeconds?: number
}

/**
 * Freesound text search. Sorted by downloads rather than relevance: on a query like "door" the
 * most-downloaded results are the clean, usable ones, while pure relevance surfaces whatever
 * happens to have the word in its description.
 */
export function freesoundUrl(query: string, token: string, opts: SearchOptions = {}): string {
  const maxS = opts.maxSeconds ?? 15
  const minS = opts.minSeconds ?? 0.15
  const filters = [`duration:[${minS} TO ${maxS}]`]
  if (opts.safeOnly !== false) {
    // Freesound spells them out; anything Noncommercial is excluded
    filters.push('license:("Creative Commons 0" OR "Attribution" OR "Attribution 4.0")')
  }
  const p = new URLSearchParams({
    query,
    filter: filters.join(' '),
    fields: 'id,name,tags,license,duration,username,previews,url',
    sort: 'downloads_desc',
    page_size: String(Math.min(50, opts.pageSize ?? 20)),
    token,
  })
  return `https://freesound.org/apiv2/search/text/?${p.toString()}`
}

/** Wikimedia Commons: no key, so this is what makes search work on a fresh install. */
export function commonsUrl(query: string, opts: SearchOptions = {}): string {
  const p = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrsearch: `filetype:audio ${query}`,
    gsrnamespace: '6',
    gsrlimit: String(Math.min(50, opts.pageSize ?? 20)),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|metadata|extmetadata',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ObjectName',
  })
  return `https://commons.wikimedia.org/w/api.php?${p.toString()}`
}

// ---------------------------------------------------------------------------
// response parsing
// ---------------------------------------------------------------------------

const stripHtml = (s: string): string => (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

export function parseFreesound(json: any): SoundHit[] {
  const out: SoundHit[] = []
  for (const r of (json?.results || [])) {
    const previews = r.previews || {}
    const audioUrl = previews['preview-hq-mp3'] || previews['preview-lq-mp3'] || previews['preview-hq-ogg'] || ''
    if (!audioUrl) continue
    out.push({
      provider: 'freesound',
      id: String(r.id),
      name: String(r.name || `sound ${r.id}`),
      seconds: Math.round((r.duration || 0) * 100) / 100,
      author: String(r.username || 'unknown'),
      license: classifyLicense(r.license),
      audioUrl,
      pageUrl: r.url || `https://freesound.org/s/${r.id}/`,
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 8) : [],
    })
  }
  return out
}

/**
 * How long a Commons file is.
 *
 * Ogg files carry `length` in their metadata. Anything else is estimated from the file size at a
 * nominal 128kbps, which is rough but decisive: the point is telling a three second door from a
 * forty minute speech, and a live search for "electronic door" really did return two State of the
 * Union addresses.
 */
function commonsSeconds(ii: any): number {
  const md: any[] = Array.isArray(ii?.metadata) ? ii.metadata : []
  const len = md.find(m => String(m?.name).toLowerCase() === 'length')?.value
  if (typeof len === 'number' && len > 0) return Math.round(len * 100) / 100
  const size = Number(ii?.size) || 0
  return size > 0 ? Math.round((size * 8 / 128000) * 10) / 10 : 0
}

export function parseCommons(json: any): SoundHit[] {
  const pages = json?.query?.pages || {}
  const out: SoundHit[] = []
  for (const key of Object.keys(pages)) {
    const p = pages[key]
    const ii = (p.imageinfo || [])[0]
    if (!ii?.url) continue
    const em = ii.extmetadata || {}
    const title = String(p.title || '').replace(/^File:/, '')
    out.push({
      provider: 'commons',
      id: String(p.pageid ?? title),
      name: title.replace(/\.[^.]+$/, ''),
      seconds: commonsSeconds(ii),
      author: stripHtml(em.Artist?.value || '') || 'unknown',
      license: classifyLicense(em.LicenseShortName?.value || em.LicenseUrl?.value),
      audioUrl: ii.url,
      pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(p.title || ''))}`,
      tags: [],
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// using what you found
// ---------------------------------------------------------------------------

/** The credit line to paste into a video description. Empty when none is required. */
export function attributionLine(hit: SoundHit): string {
  if (!hit.license.needsAttribution) return ''
  const who = hit.author && hit.author !== 'unknown' ? hit.author : 'unknown author'
  return `"${hit.name}" by ${who} (${hit.pageUrl}) licensed under ${hit.license.name.replace(/ \(.*\)$/, '')}`
}

/** A filename that will survive Windows, without losing which sound it is. */
export function safeFilename(hit: SoundHit): string {
  const base = (hit.name || 'sound')
    .replace(/[<>:"/\\|?* -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'sound'
  const ext = (hit.audioUrl.match(/\.(mp3|ogg|wav|flac|m4a|oga)(?:$|\?)/i) || [, 'mp3'])[1]
  return `${base} [${hit.provider}-${hit.id}].${ext.toLowerCase()}`
}

/** Rank results so the useful ones come first, and say why each one placed where it did. */
export function rank(hits: SoundHit[], query: string, opts: SearchOptions = {}): SoundHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const maxS = opts.maxSeconds ?? 15
  const score = (h: SoundHit): number => {
    let s = 0
    const name = h.name.toLowerCase()
    for (const t of terms) {
      if (name.includes(t)) s += 2
      if (h.tags.some(tag => tag.toLowerCase().includes(t))) s += 1
    }
    if (!h.license.needsAttribution) s += 1.5          // no credit needed is genuinely easier
    if (!h.license.commercialOk) s -= 6                // effectively unusable here
    if (h.license.code === 'unknown') s -= 8
    if (h.seconds > 0 && h.seconds <= maxS) s += 1.5   // already the right length to drop in
    if (h.seconds > 30) s -= 2                         // usable, but it needs trimming first
    return s
  }
  return [...hits].sort((a, b) => score(b) - score(a))
}

/** Merge providers, drop duplicates, and optionally hide anything not safe to publish. */
export function collate(lists: SoundHit[][], query: string, opts: SearchOptions = {}): SoundHit[] {
  const seen = new Set<string>()
  const all: SoundHit[] = []
  for (const list of lists) {
    for (const h of list) {
      const key = `${h.provider}:${h.id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (opts.safeOnly !== false && !isSafeForYouTube(h.license)) continue
      // Only throw away what cannot possibly be an effect. A first attempt dropped anything over
      // twice the requested length, which also binned the industrial field recordings that are
      // the best thing Commons has (a three minute "coffee beans into the silo" is very usable,
      // you just trim it). Speeches and albums are what the cap is for.
      if (h.seconds > 0 && h.seconds > (opts.hardMaxSeconds ?? 300)) continue
      all.push(h)
    }
  }
  return rank(all, query, opts)
}
