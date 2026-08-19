#!/usr/bin/env node
// VidHelm MCP server, lets Claude (Code / Desktop) drive a running VidHelm instance.
// Zero dependencies: speaks MCP JSON-RPC over stdio and proxies to the app's localhost
// agent bridge (electron/main.ts, default http://127.0.0.1:5959). See docs/AGENT.md.
import http from 'node:http'
import readline from 'node:readline'

const BRIDGE = `http://127.0.0.1:${process.env.VH_AGENT_PORT || 5959}`
const NOT_RUNNING = 'VidHelm is not running. Start it first: `npm run dev` (or launch the installed app), then retry.'

const call = (method, path, body) => new Promise((resolve) => {
  const req = http.request(`${BRIDGE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, timeout: method === 'POST' && body?.action === 'export' ? 30 * 60 * 1000 : ['cut_pauses','run_recipe','sample_frames','compose_thumbnail','render_3d','prepare_analysis'].includes(body?.action) ? 5 * 60 * 1000 : ['scan_broll','plan_broll','place_broll','analyze_speech','find_phrase','cut_at_phrase','plan_framing'].includes(body?.action) ? 25 * 60 * 1000 : 20000 }, res => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => {
      const buf = Buffer.concat(chunks)
      if (res.headers['content-type']?.includes('image/png')) return resolve({ png: buf })
      try { resolve(JSON.parse(buf.toString() || '{}')) } catch { resolve({ error: 'bad response from app' }) }
    })
  })
  req.on('error', () => resolve({ error: NOT_RUNNING }))
  req.on('timeout', () => { req.destroy(); resolve({ error: 'app timed out' }) })
  if (body) req.write(JSON.stringify(body))
  req.end()
})

// Sent to the client on connect. Users who installed the app have no repo (so no CLAUDE.md
// or AGENTS.md), this is how a fresh assistant learns the working style anyway.
const INSTRUCTIONS = `VidHelm is a desktop video editor the human is watching while you drive it. Your edits appear in their window instantly, and they can move things between your calls.

How to work:
1. Call get_state first, and again after they have touched anything, never assume the timeline.
2. Make a few edits, then screenshot to see what they see. Report what happened in plain language; they cannot see your tool calls.
3. Tag points are the shared language: they press M at beats that matter. Hang SFX, text and narration on tag times from get_state rather than hardcoded numbers.
4. get_state.startRecipe is their standing workflow ("#" = a disabled line). "Run my workflow" means call run_recipe for the app-native steps, then do the lines meant for you: pitch title options in chat, propose a thumbnail subtitle, then compose_thumbnail.
5. export_video blocks until rendered and returns a quality check (loudness, peaks, black frames), relay that verdict.
6. Tracks: v1 video, v2 b-roll (picture only, sits over v1), a1 voice/music, a2 sound effects. Times are seconds; text x/y are 0-1 of the frame.
7. Ask before destructive edits (deleting their clips, exporting over an existing file). Prefer adding to rearranging.

Handy: cut_pauses strips dead air; set_booth_script writes a read-along script into the karaoke booth for a clean one-take re-record; open_panel model3d {path} loads an STL/3MF/OBJ/GLB and render_3d turns it into a spinning clip (transparent + still gives an alpha PNG that overlays footage).

Cutting to a spoken line: never read a timestamp off a transcript and use it. find_phrase and cut_at_phrase end on the last word of the THOUGHT and drop whatever trails after it, then snap to the waveform, so you get "...espresso maker" rather than "...espresso maker and this".

B-roll: scan_broll measures a folder and gives you a contact sheet per clip. LOOK at each sheet and label_broll what is in it; those labels are all plan_broll has to match against. Then plan_broll (nothing moves yet), read it, and place_broll commits it to v2. Cutaways are picture only, so the audio runs straight through underneath.

Vertical crops: plan_framing measures where the subject is and returns steady holds plus a proof sheet with the crop drawn on each one. Open the proof: detail and motion find the biggest busy object, which is not always the subject, and you fix that with hints rather than trusting the numbers.

If a tool says VidHelm is not running, the app is closed, ask them to open it. If they cannot connect at all, tell them to click the robot "AI" button in VidHelm's header for live diagnostics.`

const num = { type: 'number' }, str = { type: 'string' }, bool = { type: 'boolean' }
const TOOLS = [
  { name: 'get_state', description: 'Full editor state: format, duration, playhead, media bin, clips (all tracks), texts, and tag points. Call this first and after batches of edits.', inputSchema: { type: 'object', properties: {} } },
  { name: 'screenshot', description: 'PNG screenshot of the VidHelm window, see what the human sees.', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_media', description: 'Import a video/audio/image file by absolute path into the media bin, and (by default) append it to the timeline. chromaKey marks it as green-screen footage: that colour is removed on export and in the preview so the clip underneath shows through.', inputSchema: { type: 'object', properties: { path: str, place: { ...bool, description: 'false = bin only' }, start: { ...num, description: 'explicit timeline position (s)' }, chromaKey: { ...str, description: 'hex key colour to remove, e.g. #00e800' } }, required: ['path'] } },
  { name: 'add_clip', description: 'Place an already-imported media item on the timeline. media = bin item name (fuzzy) or id. track: v1=video, a1=voice/music, a2=sfx.', inputSchema: { type: 'object', properties: { media: str, track: { ...str, enum: ['v1', 'a1', 'a2'] }, start: num, duration: num, sourceStart: num, volume: num, fadeIn: num, fadeOut: num }, required: ['media'] } },
  { name: 'update_clip', description: 'Patch a clip (by clipId from get_state): start, duration, sourceStart, volume, fadeIn, fadeOut, trackId.', inputSchema: { type: 'object', properties: { clipId: str, start: num, duration: num, sourceStart: num, volume: num, fadeIn: num, fadeOut: num, trackId: str }, required: ['clipId'] } },
  { name: 'split_clip', description: 'Split a clip at timeline time t (seconds).', inputSchema: { type: 'object', properties: { clipId: str, t: num }, required: ['clipId', 't'] } },
  { name: 'delete_item', description: 'Delete a clip, text, or tag by id.', inputSchema: { type: 'object', properties: { id: str }, required: ['id'] } },
  { name: 'add_text', description: 'Add a text overlay. x/y are 0..1 of frame (0.5,0.5 = center); fontSize is px at 1080p.', inputSchema: { type: 'object', properties: { text: str, start: num, duration: num, x: num, y: num, fontSize: num, color: str, fadeIn: num, fadeOut: num, box: bool, boxOpacity: num }, required: ['text'] } },
  { name: 'update_text', description: 'Patch a text overlay by textId.', inputSchema: { type: 'object', properties: { textId: str, text: str, start: num, duration: num, x: num, y: num, fontSize: num, color: str }, required: ['textId'] } },
  { name: 'add_tag', description: 'Drop a tag point (marker) at time t with an optional label. Tags are the beat map of the video - SFX and narration line up with them.', inputSchema: { type: 'object', properties: { t: num, label: str } } },
  { name: 'update_tag', description: 'Move or rename a tag by tagId.', inputSchema: { type: 'object', properties: { tagId: str, t: num, label: str }, required: ['tagId'] } },
  { name: 'list_sfx', description: 'List the sound-effect library (13 built-ins + user customs).', inputSchema: { type: 'object', properties: {} } },
  { name: 'place_sfx', description: 'Place a library sound effect on the SFX track at time t (defaults to the playhead). Try whoosh, pop, boing, squish, gummy-squish, gloop, poof, spoosh, sparkle, party, riser, ding, thud.', inputSchema: { type: 'object', properties: { name: str, t: num, volume: num }, required: ['name'] } },
  { name: 'transport', description: 'Move the playhead and/or start/stop playback in the app window.', inputSchema: { type: 'object', properties: { seek: { ...num, description: 'seconds' }, play: bool } } },
  { name: 'set_format', description: 'Set export format: orientation landscape|portrait|square, resolution 4K|1440p|1080p|720p, fps 24|30|60.', inputSchema: { type: 'object', properties: { orientation: str, resolution: str, fps: num } } },
  { name: 'export_video', description: 'Render the timeline to an mp4 at outputPath (absolute). Blocks until done; returns the automatic quality-check verdict (loudness, peaks, black frames).', inputSchema: { type: 'object', properties: { outputPath: str, qualityCheck: bool }, required: ['outputPath'] } },
  { name: 'open_panel', description: 'Open/close a panel in the app for the user: booth (karaoke recorder), narration (cloned voice), sfx (sound library tab), media (bin tab), settings, thumbnail (frame picker), connect (AI connection setup + troubleshooter), help (first-run tour, credits and licences), model3d (3D Studio, pass path to load an STL/3MF/OBJ for the user to pose and render as a turntable clip).', inputSchema: { type: 'object', properties: { panel: { ...str, enum: ['booth', 'narration', 'sfx', 'media', 'settings', 'thumbnail', 'connect', 'model3d', 'help', 'takes'] }, open: bool, path: { ...str, description: 'model3d only: absolute path to a .stl/.3mf/.obj to load' } }, required: ['panel'] } },
  { name: 'render_3d', description: "Render the model currently open in the 3D Studio (open_panel model3d first). Returns a clip in the media bin: a spinning turntable, or a still. transparent:true renders with no backdrop and drops it on the video track AT THE PLAYHEAD so it composites on top of the footage underneath, that is how you put a spinning print over a video. Blocks for roughly `seconds` while it records.", inputSchema: { type: 'object', properties: { seconds: { ...num, description: 'turntable length, 1-30 (default 6)' }, transparent: { ...bool, description: 'no backdrop; becomes an overlay on top of the footage' }, still: { ...bool, description: 'true = single frame instead of a spin' } } } },
  { name: 'prepare_analysis', description: "Get the current work into a shape a video-analysis service (Adversal's process_video, or similar) can take, and find out what still needs looking at. scope 'timeline' flattens the whole timeline to a small mp4 whose timestamps match the timeline exactly; scope 'clip' skips rendering and hands back the original file with in/out points. Either way you get `gaps`, the stretches with no tag point within gapPad seconds: analyse only those on a second pass so already-marked material is not re-examined, and add tags at (returned timestamp + toTimeline.add).", inputSchema: { type: 'object', properties: { scope: { ...str, enum: ['timeline', 'clip'], description: "default 'timeline'" }, clipId: { ...str, description: 'clip scope: which clip, defaults to the first video clip' }, gapPad: { ...num, description: 'seconds either side of a tag counted as already covered (default 10)' }, minGap: { ...num, description: 'ignore gaps shorter than this (default 5)' }, outputPath: { ...str, description: 'timeline scope: where to write the flattened mp4' } } } },
  { name: 'open_project', description: "The human can point VidHelm at a project folder whose sub-folders are projects, each holding its own footage. Call with no arguments to list them (and see which is open); pass name to open one, which loads that folder's media into the bin and restores any saved timeline. Errors if no project folder is configured.", inputSchema: { type: 'object', properties: { name: { ...str, description: 'project (sub-folder) name; omit to just list' } } } },
  { name: 'set_booth_script', description: "Put a read-along script into the karaoke booth and open it (one line per beat; lines pin to the user's tag points). Use after analyzing footage, e.g. from a transcript, your own writing, or video-analysis notes, so the user can re-record clean narration in one take.", inputSchema: { type: 'object', properties: { script: { ...str, description: 'the lines, newline-separated' }, open: bool }, required: ['script'] } },
  { name: 'cut_pauses', description: 'Detect and remove dead space (silent pauses, or motionless stretches for silent footage) across the whole timeline, splicing seamlessly with short crossfades. Uses the thresholds from Settings. Undoable.', inputSchema: { type: 'object', properties: {} } },
  { name: 'find_repeats', description: "Read the timeline's speech on-device and find the spots where the same line was said more than once (retakes, false starts). Returns each group with every attempt's words, timing, and which one is picked by default (longest, finished, fewest fillers, later on a tie). Cuts nothing: it opens the Takes & history panel so the human sees the same list. Follow with apply_takes.", inputSchema: { type: 'object', properties: {} } },
  { name: 'apply_takes', description: "Cut the rejected takes found by find_repeats out of the timeline, rippling the rest left. Pass keep to overrule which attempt survives, and drop for extra transcript lines to cut (a flub with no retake). Undoable with the app's own undo. Re-running with different choices re-cuts from the pre-cut state as long as the human has not edited the timeline since.", inputSchema: { type: 'object', properties: { keep: { ...str, description: 'per-group choice as group:member pairs using find_repeats indexes, e.g. "0:2, 1:0". Omit to use the defaults it picked.' }, drop: { ...str, description: 'extra transcript line indexes to cut, e.g. "4, 9"' } } } },
  { name: 'run_recipe', description: "Run the user's Start Recipe (their standing workflow, shown in get_state.startRecipe), executes the app-native steps (cut-pauses, intro-audio, logo, thumbnail picker) and reports which steps are yours to do (titles, subtitle...).", inputSchema: { type: 'object', properties: {} } },
  { name: 'sample_frames', description: 'Sample N evenly-spaced frames from the first timeline video (or an explicit path), returns times + jpg paths for choosing a thumbnail moment.', inputSchema: { type: 'object', properties: { count: num, path: str } } },
  { name: 'compose_thumbnail', description: "Compose a 1280x720 YouTube thumbnail: video frame at time t + catchy subtitle (bottom-left) + the user's brand logo (top-right, automatic). Writes PNG to outPath.", inputSchema: { type: 'object', properties: { t: num, subtitle: str, outPath: str, path: str }, required: ['t', 'outPath'] } },
  { name: 'scan_broll', description: "Look through a folder of b-roll and measure every clip: length, sound, the steady part worth using, and a CONTACT SHEET image per clip. Defaults to the `broll` sub-folder of the open project. You then open each sheet, see what is in it, and call label_broll: those labels are the only thing plan_broll can match against, so unlabelled footage is never used. Labels are remembered in the folder itself (.vidhelm-broll.json), so a re-scan keeps them.", inputSchema: { type: 'object', properties: { folder: { ...str, description: 'absolute path; defaults to <project>/broll' }, refresh: { ...bool, description: 're-measure and rebuild contact sheets even if they exist' } } } },
  { name: 'label_broll', description: "Say what is in one b-roll clip, after looking at its contact sheet. Short concrete nouns work best ('coffee beans', 'grinder', 'pouring', 'portafilter'): they are matched against the words actually spoken. Optionally narrow the usable part with bestStart/bestEnd, or cap how often it may appear with maxUses.", inputSchema: { type: 'object', properties: { id: { ...str, description: 'the file name from scan_broll' }, labels: { ...str, description: 'comma-separated, e.g. "coffee beans, pouring, close up"' }, description: { ...str, description: 'one sentence about the shot' }, bestStart: num, bestEnd: num, maxUses: num, folder: str }, required: ['id'] } },
  { name: 'plan_broll', description: "Work out which cutaway goes over which line, WITHOUT touching the timeline. Reads the timeline's speech word by word, splits it into sentences, and matches labelled b-roll to what is being said. A cutaway only ever covers a whole sentence, never starts in the opening seconds, keeps its distance from the next one, and is capped as a share of the runtime, so the video does not turn into a slideshow. Returns what it would do and why; place_broll commits it.", inputSchema: { type: 'object', properties: { minDuration: { ...num, description: 'shortest cutaway, default 1.4s' }, maxDuration: { ...num, description: 'longest cutaway, default 5s' }, gapBetween: { ...num, description: 'seconds back on camera between cutaways, default 4' }, coverage: { ...num, description: 'most of the runtime that may be b-roll, 0-1, default 0.35' }, protectStart: { ...num, description: 'leave this many opening seconds alone, default 8' }, minScore: { ...num, description: 'how good a match must be, 0-1, default 0.34' }, protect: { ...str, description: 'stretches that must stay on camera, as "start-end" seconds: "0-12, 300-330"' }, model: { ...str, description: "whisper model: tiny, base or small. Default small (slower, more accurate)" } } } },
  { name: 'place_broll', description: "Put the planned cutaways on the timeline's B-ROLL track. Picture only: the audio underneath keeps playing straight through, and each cutaway ends on a word boundary so the picture comes back cleanly. Pass drop to leave some out.", inputSchema: { type: 'object', properties: { drop: { ...str, description: 'plan indexes to skip, e.g. "0, 3"' } } } },
  { name: 'analyze_speech', description: "Read every word on the timeline with its timing, and split it into sentences. This is the pass that find_phrase, cut_at_phrase and plan_broll all measure from; it is cached until the timeline changes. Defaults to the `small` Whisper model because accuracy matters more here than speed (first use downloads it once).", inputSchema: { type: 'object', properties: { model: { ...str, description: 'tiny, base or small (default small)' }, refresh: { ...bool, description: 'ignore the cache and read it again' } } } },
  { name: 'find_phrase', description: "Find where a line was said and get exact in/out points for it, without cutting anything. Tolerant of transcription slips. Crucially it TRIMS WHAT DANGLES: ask for 'check out this portable espresso maker' when the recording runs on into 'and this...' and the out point lands after 'maker', not after 'this'. The point is then snapped to the real waveform so no consonant is clipped and no dead air is left.", inputSchema: { type: 'object', properties: { text: { ...str, description: 'roughly what was said' }, after: { ...num, description: 'only look after this time, for a line said more than once' }, before: num, refine: { ...bool, description: 'set false to skip waveform snapping' }, model: str }, required: ['text'] } },
  { name: 'cut_at_phrase', description: "Cut the timeline at a spoken phrase, precisely. mode 'end' (default) drops everything after the phrase, 'start' drops everything before it, 'split' only cuts the clips there and removes nothing. Same dangling-clause trimming as find_phrase, so 'cut after the fine grind line' does not leave half of the next sentence attached.", inputSchema: { type: 'object', properties: { text: { ...str, description: 'roughly what was said' }, mode: { ...str, enum: ['end', 'start', 'split'] }, after: num, before: num, refine: bool, model: str }, required: ['text'] } },
  { name: 'plan_framing', description: "Work out where a 9:16 crop should point, measured from the footage rather than guessed: decodes the clip and finds the subject per shot, then HOLDS the crop still inside a shot unless the subject really moves, and limits how fast it may travel. Returns one entry per steady hold plus a ready-made ffmpeg crop expression. Pass hints if you have looked at frames yourself and know where the subject is.", inputSchema: { type: 'object', properties: { path: { ...str, description: 'defaults to the first timeline video' }, sourceStart: num, duration: num, fps: { ...num, description: 'analysis sample rate, default 4' }, aspect: { ...num, description: 'target aspect, default 0.5625 (9:16)' }, hints: { ...str, description: 'subject positions you can see yourself, as "time@x" with x 0-1 across the frame: "3@0.72, 9.5@0.35"' } } } },
  { name: 'set_recipe', description: "Change the user's Start Recipe (their standing workflow) and have it persist. mode 'append' (default) adds lines at the end, 'prepend' at the top, 'replace' swaps the lot, 'show' just returns it. Always go through this rather than editing the settings file: the running app owns that file and rewrites it from memory whenever anything changes, so an outside edit looks like it worked and then quietly disappears.", inputSchema: { type: 'object', properties: { text: { ...str, description: 'the lines to add' }, mode: { ...str, enum: ['append', 'prepend', 'replace', 'show'] } } } },
  { name: 'search_sfx', description: "Search free sound-effect libraries and get results with their LICENCES. Wikimedia Commons is always searched (no key needed); Freesound is searched too when the user has pasted a free token in Settings, and it is far bigger and better tagged. Non-commercial and unlicensed sounds are hidden by default, because they are not safe on a monetised channel. Results are ranked, and each says whether it needs crediting.", inputSchema: { type: 'object', properties: { query: { ...str, description: 'what the sound is, e.g. "coffee beans pour" or "electronic door"' }, limit: num, maxSeconds: { ...num, description: 'default 15, keeps music out' }, safeOnly: { ...bool, description: 'set false to also see non-commercial and unlicensed results' } }, required: ['query'] } },
  { name: 'download_sfx', description: "Save one search result into the user's own sound folder so it can be placed on the timeline. Anything that needs crediting is also written into CREDITS.txt beside the file, and the credit line comes back so it can go in the video description.", inputSchema: { type: 'object', properties: { index: { ...num, description: 'which result from the last search_sfx, starting at 0' } } } },
  { name: 'make_sfx', description: "Synthesize a sound effect from a physical model rather than downloading one: coffee beans poured into a hopper (metal, plastic or glass), a sci-fi door opening or closing, a podracer starting, and one flying past with real Doppler. Call with no recipe to list them. A different seed gives another take of the same sound, and intensity changes how much of it there is.", inputSchema: { type: 'object', properties: { recipe: { ...str, description: 'coffee-beans, coffee-beans-plastic, coffee-beans-glass, door-electronic, door-electronic-close, podracer-start, podracer-pass' }, seed: { ...num, description: 'change it for a different take' }, intensity: { ...num, description: '0-1' }, duration: num } } },
]

async function runTool(name, args = {}) {
  switch (name) {
    case 'get_state': return call('GET', '/state')
    case 'screenshot': {
      const r = await call('GET', '/screenshot')
      if (r.png) return { __image: r.png.toString('base64') }
      return r
    }
    case 'transport': {
      const out = {}
      if (typeof args.seek === 'number') Object.assign(out, await call('POST', '/command', { action: 'seek', t: args.seek }))
      if (typeof args.play === 'boolean') Object.assign(out, await call('POST', '/command', { action: 'play', playing: args.play }))
      return Object.keys(out).length ? out : { error: 'pass seek and/or play' }
    }
    case 'export_video': return call('POST', '/command', { action: 'export', ...args })
    case 'open_panel': return call('POST', '/command', { action: 'ui', ...args })
    case 'cut_pauses': return call('POST', '/command', { action: 'cut_pauses' })
    case 'find_repeats': return call('POST', '/command', { action: 'find_repeats' })
    case 'apply_takes': return call('POST', '/command', { action: 'apply_takes', ...args })
    case 'run_recipe': return call('POST', '/command', { action: 'run_recipe' })
    case 'sample_frames': return call('POST', '/command', { action: 'sample_frames', ...args })
    case 'compose_thumbnail': return call('POST', '/command', { action: 'compose_thumbnail', ...args })
    case 'prepare_analysis': return call('POST', '/command', { action: 'prepare_analysis', ...args })
    case 'open_project': return call('POST', '/command', { action: 'open_project', ...args })
    case 'set_booth_script': return call('POST', '/command', { action: 'booth_script', ...args })
    case 'render_3d': return call('POST', '/command', { action: 'render_3d', ...args })
    case 'search_sfx': case 'download_sfx': case 'make_sfx':
    case 'set_recipe':
    case 'scan_broll': case 'label_broll': case 'plan_broll': case 'place_broll':
    case 'analyze_speech': case 'find_phrase': case 'cut_at_phrase': case 'plan_framing':
      return call('POST', '/command', { action: name, ...args })
    case 'add_media': case 'add_clip': case 'update_clip': case 'split_clip': case 'delete_item':
    case 'add_text': case 'update_text': case 'add_tag': case 'update_tag': case 'list_sfx':
    case 'place_sfx': case 'set_format':
      return call('POST', '/command', { action: name, ...args })
    default: return { error: `unknown tool ${name}` }
  }
}

// ---- MCP stdio plumbing ----
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  line = line.trim()
  if (!line) return
  let req
  try { req = JSON.parse(line) } catch { return }
  const { id, method, params } = req
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'vidhelm', version: '1.6.1' }, instructions: INSTRUCTIONS } })
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  // Empty (not method-not-found) so strict clients that probe these at startup
  // (LM Studio, Jan, some IDE integrations) don't log errors or bail.
  if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } })
  if (method === 'resources/templates/list') return send({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } })
  if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } })
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {}
    const result = await runTool(name, args)
    if (result?.__image) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'image', data: result.__image, mimeType: 'image/png' }] } })
    const isError = !!result?.error
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], isError } })
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
})
