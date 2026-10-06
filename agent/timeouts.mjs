// How long one agent command may take. ONE table, read by both ends of the bridge:
// electron/main.ts (bundled in, decides when the app gives up waiting on the editor) and
// agent/mcp-server.mjs (ships beside this file in resources/agent/, decides when the MCP proxy
// hangs up). Two hand-kept copies drifted apart: export was 30 min on one side and 4 h on the
// other, and make_captions / generate_clip were missing from both, so they reported a timeout
// while the work (and the fal.ai bill) carried on. Keys are bridge actions, not MCP tool names
// (export_video -> export, open_panel -> ui, set_booth_script -> booth_script, transport -> seek/play).
// Dependency-free on purpose.

export const QUICK_MS = 15_000
export const MEDIUM_MS = 2 * 60_000
export const LONG_MS = 20 * 60_000
/** electron/videogen.ts caps the whole model chain at 12 minutes; frame grabs, the download and the write fit in the rest */
export const GEN_CLIP_MS = 15 * 60_000
/** a fourteen minute cut takes about half an hour to render, so a flat 30 minute cap reported a timeout on an export that was going perfectly well */
export const EXPORT_MS = 4 * 60 * 60_000
/** the MCP proxy always waits this much longer than the bridge, so the bridge's own (clearer) timeout message is what arrives */
export const PROXY_SLACK_MS = 60_000

export const ACTION_TIMEOUTS = {
  export: EXPORT_MS,
  generate_clip: GEN_CLIP_MS,
  // whole-timeline renders, Whisper passes, footage decoding, network and synthesis
  cut_pauses: LONG_MS, run_recipe: LONG_MS, sample_frames: LONG_MS, compose_thumbnail: LONG_MS,
  render_3d: LONG_MS, prepare_analysis: LONG_MS, open_project: LONG_MS,
  scan_broll: LONG_MS, plan_broll: LONG_MS, place_broll: LONG_MS, plan_framing: LONG_MS, look_through: LONG_MS,
  analyze_speech: LONG_MS, find_phrase: LONG_MS, cut_at_phrase: LONG_MS, find_word: LONG_MS,
  make_captions: LONG_MS, find_repeats: LONG_MS, apply_takes: LONG_MS,
  capture_site: LONG_MS, make_score: LONG_MS, make_sfx: LONG_MS, search_sfx: LONG_MS, download_sfx: LONG_MS,
  // a first measurement decodes every file it is asked about (about a second per minute of sound)
  analyze_audio: LONG_MS,
  // usually quick, but the first call can do real work (the SFX library renders itself once, probes, model loads)
  add_media: MEDIUM_MS, list_sfx: MEDIUM_MS, place_sfx: MEDIUM_MS, ui: MEDIUM_MS,
}

/** Milliseconds the app's bridge waits for the editor to answer `cmd`. */
export function bridgeTimeoutMs(cmd) {
  // own keys only: a caller's action 'constructor' or '__proto__' must not find Object.prototype's
  // members (a function as the timeout became 1 ms and a "NaNs" message)
  const base = typeof cmd?.action === 'string' && Object.prototype.hasOwnProperty.call(ACTION_TIMEOUTS, cmd.action) ? ACTION_TIMEOUTS[cmd.action] : QUICK_MS
  // A word anchor (at:"some words") reads the timeline's speech first, which is a full Whisper
  // pass when it is not cached yet. A numeric `at` (generate_clip's source time) is not an anchor.
  return typeof cmd?.at === 'string' && cmd.at.trim() ? Math.max(base, LONG_MS) : base
}

/** Milliseconds the MCP proxy keeps the socket open for `cmd`: always longer than the bridge. */
export const proxyTimeoutMs = (cmd) => bridgeTimeoutMs(cmd) + PROXY_SLACK_MS
