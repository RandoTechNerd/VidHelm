/* In-app help: one knowledge base serving two answerers.
 *  - Online, VidHelm Cloud's /api/help/chat puts helpSystemPrompt() in front of a small Claude model.
 *  - Offline (or before the endpoint is deployed), localAnswer() picks the best-matching entry here.
 * Both read the same entries, so the chat and the fallback can never describe two different apps.
 * Pure: no Electron or Node imports (the cloud copies it via scripts/sync-shared.mjs).
 *
 * Answers may end with action tags like [[open:booth]]; parseActions() turns them into buttons. */

export type HelpAction = 'media' | 'sfx' | 'booth' | 'narration' | 'thumbnail' | 'settings' | 'connect' | 'model3d' | 'takes' | 'aiclip' | 'tour' | 'export' | 'tags'

export const ACTION_LABELS: Record<HelpAction, string> = {
  media: 'Open the Media panel', sfx: 'Open Sound FX', booth: 'Open the Booth', narration: 'Open Narrate',
  thumbnail: 'Open Thumbnails', settings: 'Open Settings', connect: 'Connect your AI', model3d: 'Open the 3D Studio',
  takes: 'Open Takes & history', aiclip: 'Open AI clip', tour: 'Replay the tour', export: 'Show Export settings', tags: 'Show Tag points',
}

export interface HelpEntry { id: string; topic: string; keys: string[]; answer: string; action?: HelpAction }

export const HELP_ENTRIES: HelpEntry[] = [
  { id: 'layout', topic: 'Finding your way around', keys: ['layout', 'where', 'find', 'start', 'begin', 'new', 'overview', 'how do i use'],
    answer: 'Left: your Media and Sound FX. Middle: the preview, with the timeline across the bottom. Right: Export, Tags and Inspector tabs. The top bar has Save, Open, Import, Recipe, 3D, AI clip, the frame format (Landscape, Portrait, Square), Connect AI and Export.', action: 'tour' },
  { id: 'import', topic: 'Bringing in footage', keys: ['import', 'add footage', 'add a video', 'add video', 'file', 'footage', 'drag', 'drop', 'media', 'bin', 'audio', 'image', 'photo', 'mp4', 'mov', 'heic', 'iphone photo'],
    answer: 'Drag files onto the timeline, or onto the Media panel and double-click them to add. The + button at the top of the Media panel opens a file picker. Video, audio, images and 3D models (STL, 3MF, OBJ, GLB) all work; anything VidHelm cannot read is refused with a reason. iPhone HEIC photos cannot be exported yet, so save them as JPG or PNG first.', action: 'media' },
  { id: 'project-folder', topic: 'Project folders', keys: ['project', 'folder', 'workspace', 'organise', 'organize', 'save', 'open', 'backup'],
    answer: 'Set a project folder in Settings and every sub-folder becomes a project: open one from the dropdown in the Media panel and its footage loads. Drop more files into the folder and press the refresh button next to the dropdown to bring them in; your timeline stays as it is. Save (Ctrl+S) writes back to that same folder, so a project is just a folder you can copy, move or back up. Save and Open in the top bar also work with single project files. VidHelm keeps a recovery copy of unsaved work and asks before anything would throw it away.', action: 'settings' },
  { id: 'edit', topic: 'Cutting and arranging', keys: ['cut', 'split', 'trim', 'delete', 'move', 'arrange', 'clip', 'shorten', 'undo', 'redo', 'razor'],
    answer: 'Drag clips to move them and drag their edges to trim. Drag a clip up or down to move it between Video and B-roll, or between Voice / music and SFX. Select a clip and press Split to cut it at the playhead; Delete removes the selection. Everything is undoable with Ctrl+Z (Ctrl+Shift+Z to redo), and your original files are never touched.' },
  { id: 'tags', topic: 'Tag points', keys: ['tag', 'marker', 'mark', 'beat', 'm key', 'flag', 'point'],
    answer: 'Press M while playing to drop a tag point at a beat that matters. Tags show as flags on the ruler and are listed in the Tags tab on the right, where you can rename, jump to or delete them. Sound effects, captions, narration lines and your AI all line up to them.', action: 'tags' },
  { id: 'pauses', topic: 'Removing dead air', keys: ['pause', 'silence', 'dead air', 'gap', 'tighten', 'cut pauses', 'ums', 'quiet'],
    answer: 'Cut Pauses on the toolbar finds long silences (or motionless stretches in silent footage) and ripples them out with tiny audio fades so the cuts do not click. Run it early; Ctrl+Z puts it all back.' },
  { id: 'takes', topic: 'Repeated takes', keys: ['take', 'retake', 'repeat', 'mistake', 'flub', 'transcript', 'history', 'best take'],
    answer: 'Takes on the toolbar transcribes your footage, groups lines you said more than once, and lets you keep the best one. It also keeps a full record of everything that was cut.', action: 'takes' },
  { id: 'captions', topic: 'Captions', keys: ['caption', 'subtitle', 'subtitles', 'cc', 'words', 'transcribe', 'whisper', 'theme', 'style'],
    answer: 'Captions on the toolbar transcribes the whole timeline on your machine (Whisper) and adds caption text. The look comes from the caption theme in Settings: 15 styles such as Bold creator, Clean, Hype, Karaoke and News, with word-by-word motion.', action: 'settings' },
  { id: 'text', topic: 'Text and titles', keys: ['text', 'title', 'lower third', 'font', 'words on screen', 'label'],
    answer: 'Text on the toolbar adds a text layer at the playhead. Drag it on the preview to place it, double-click to type, and use the Inspector tab on the right for size, colour, timing, fades and a background bar.' },
  { id: 'voiceover', topic: 'Voiceover and narration', keys: ['voice', 'voiceover', 'record', 'mic', 'microphone', 'narrate', 'narration', 'booth', 'script', 'clone', 'tts'],
    answer: 'Voiceover records your microphone at the playhead. Booth plays the video while your script scrolls in time so you can read it in one take. Takes are saved in the project folder\'s voice sub-folder (or in VidHelm\'s own recordings folder until a project is open, and moved into the project when you save it). Narrate generates lines in a cloned voice with a local engine; its setup wizard installs a free one for you.', action: 'booth' },
  { id: 'sfx', topic: 'Sound effects', keys: ['sfx', 'sound', 'effect', 'whoosh', 'swoosh', 'pop', 'ding', 'freesound', 'library'],
    answer: 'The Sound FX tab on the left has built-in effects made on your machine. Click play to audition, + to place one at the playhead. Find searches free libraries (add a free Freesound key for the big one), and you can record or generate your own.', action: 'sfx' },
  { id: 'music', topic: 'Music', keys: ['music', 'song', 'score', 'soundtrack', 'background music', 'bed', 'duck'],
    answer: 'Drop any music file on the timeline; it goes on the voice/music track and you can draw its volume in the Inspector. A connected AI can also compose a cut-synced score that hits your edits (electronic or cinematic) and ducks under speech.', action: 'connect' },
  { id: 'broll', topic: 'B-roll', keys: ['b-roll', 'broll', 'cutaway', 'overlay', 'cover', 'insert'],
    answer: 'The B-roll track sits over the video track: pictures there cover the main video while its audio keeps playing. Drag a clip from the Media panel (or a file from a folder) onto the B-roll row, right-click a media item and choose Add as B-roll at the playhead, or select a clip and set its Track to B-roll in the Inspector. A connected AI can scan a folder of b-roll and place it on the matching words.', action: 'media' },
  { id: 'format', topic: 'Vertical, square and landscape', keys: ['vertical', 'portrait', 'short', 'shorts', 'tiktok', 'reels', '9:16', 'square', 'landscape', 'aspect', 'format', 'crop'],
    answer: 'Pick Landscape (16:9), Portrait (9:16) or Square at the top of the window. The preview and the export both follow it. Resolution and frame rate are in the Export tab.', action: 'export' },
  { id: 'export', topic: 'Exporting', keys: ['export', 'render', 'save video', 'mp4', 'upload', 'youtube', 'quality', 'resolution', 'fps', 'loudness', 'lufs'],
    answer: 'Press Export at the top right (or Export Video in the Export tab). Set resolution, frame rate and quality in the Export tab; loudness is optimised to -14 LUFS by default. Afterwards, Watch & Verify checks the file for resolution, loudness, true peak and black frames so you know it is upload-ready.', action: 'export' },
  { id: 'thumbnail', topic: 'Thumbnails', keys: ['thumbnail', 'thumb', 'cover', 'youtube thumbnail'],
    answer: 'VidHelm builds thumbnails from your own photo first (an image in the project named like thumb, cover or photo), otherwise from the best real frame of your video, with your caption theme on the text.', action: 'thumbnail' },
  { id: 'brand', topic: 'Logo and brand kit', keys: ['logo', 'brand', 'watermark', 'intro', 'outro'],
    answer: 'Settings has a brand kit: add your logo, choose its corner, size and opacity, and whether it shows for the whole video or just the intro or outro.', action: 'settings' },
  { id: '3d', topic: '3D models', keys: ['3d', 'stl', '3mf', 'obj', 'glb', 'model', 'turntable', 'spin', 'print'],
    answer: 'The 3D button opens the 3D Studio: load an STL, 3MF, OBJ or GLB, pose it, and render a spinning turntable clip into your Media. A transparent backdrop gives an overlay you can put over footage.', action: 'model3d' },
  { id: 'aiclip', topic: 'AI-generated shots', keys: ['ai clip', 'generate', 'veo', 'kling', 'luma', 'fal', 'gemini', 'ai video', 'morph', 'animate'],
    answer: 'AI clip makes a shot from a description, or morphs one picture (or the current frame) into another. It needs your own fal.ai or Gemini key, entered in that panel; VidHelm picks the best model the keys allow.', action: 'aiclip' },
  { id: 'recipe', topic: 'Start Recipe', keys: ['recipe', 'workflow', 'automate', 'every video', 'routine', 'template'],
    answer: 'Your Start Recipe is the routine you want on every video, such as cut pauses, add the intro sound and logo, make a thumbnail. Recipe in the top bar runs it on the current timeline; edit it in Settings. A connected AI also handles the lines meant for it, like pitching titles.', action: 'settings' },
  { id: 'connect', topic: 'Connecting an AI assistant', keys: ['ai', 'claude', 'chatgpt', 'assistant', 'connect', 'mcp', 'agent', 'copilot', 'codex', 'gemini cli'],
    answer: 'Connect AI in the top bar sets up an assistant (Claude Desktop, Claude Code and others) to drive VidHelm with you: it reads your tags, places effects, writes titles and runs your recipe. The panel checks your setup and writes the exact command for your machine. It is free if you already use one of those assistants.', action: 'connect' },
  { id: 'theme', topic: 'Light and dark', keys: ['dark', 'light', 'theme', 'colour', 'color', 'mode', 'appearance'],
    answer: 'The sun and moon button at the top right switches between the dark and light interface. That is separate from the caption theme, which is in Settings.' },
  { id: 'shortcuts', topic: 'Keyboard shortcuts', keys: ['shortcut', 'keyboard', 'hotkey', 'space', 'keys'],
    answer: 'Space plays and pauses, M drops a tag point, S splits the selected clip at the playhead, Delete removes the selection, the arrow keys step one frame (Shift for one second) and Home jumps to the start. Ctrl+S saves (Ctrl+Shift+S saves a copy as a file), Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes, and Ctrl+scroll on the timeline zooms around the mouse.' },
  { id: 'slow', topic: 'Slow or choppy playback', keys: ['slow', 'lag', 'choppy', 'stutter', 'proxy', 'preview copy', 'hdr', '4k', 'freeze'],
    answer: 'Heavy files (4K, HDR, some phone formats) get a lighter preview copy built in the background; the Media panel shows its progress. Editing uses the copy. A High quality export always reads your original files. A Standard export uses the copy only when it is at least as big and as smooth as the export (a small analysis render always does), so the picture is never smaller or choppier than the export needs.' },
  { id: 'bug', topic: 'Reporting a problem', keys: ['bug', 'broken', 'crash', 'error', 'not working', 'report', 'issue', 'feature'],
    answer: 'Sorry about that. Report it on GitHub (the (i) button at the top lists the link) with what you clicked and what happened, and include the VidHelm version shown there.' },
]

/** Where people get a human. Shown in the chat's FAQ and handed to the model. */
export const SUPPORT = {
  email: 'randotechnerd@gmail.com',
  discord: 'https://discord.gg/8fjQHDX8PQ',
  issues: 'https://github.com/RandoTechNerd/VidHelm/issues',
}

export interface FaqItem { q: string; a: string; action?: HelpAction }
export interface FaqSection { title: string; items: FaqItem[] }

/** The FAQ tab in Help chat: how to use it, how to connect an agent, and what to do when stuck. */
export const FAQ: FaqSection[] = [
  { title: 'Getting started', items: [
    { q: 'How do I make my first video?', a: 'Pick the shape at the top (Landscape, Portrait or Square). Drop your footage on the timeline. Run Cut Pauses to strip dead air, tap M on the beats that matter, add text, sound effects and captions, then press Export at the top right.', action: 'tour' },
    { q: 'How do I bring in footage?', a: 'Drag files onto the timeline, or into the Media panel and double-click them. Video, audio, images and 3D models all work.', action: 'media' },
    { q: 'How do I cut, trim and undo?', a: 'Drag a clip to move it, drag its edges to trim. Select it and press Split (or S) to cut at the playhead. Ctrl+Z undoes anything, and your original files are never changed.' },
    { q: 'How do I make a vertical Short or Reel?', a: 'Click Portrait at the top of the window. The preview and the export both switch to 9:16.' },
    { q: 'How do I add captions?', a: 'Press Captions on the toolbar. VidHelm transcribes the video on your own computer and adds styled captions. Pick the look in Settings, under Caption Style.', action: 'settings' },
    { q: 'What are tag points?', a: 'Press M while the video plays to mark a beat. Sound effects, captions and narration line up to tags, and a connected AI reads them too. The Tags tab on the right lists them all.', action: 'tags' },
    { q: 'How do I export and check the result?', a: 'Press Export at the top right. When it is done, Watch & Verify checks resolution, loudness, peaks and black frames so you know it is ready to upload.', action: 'export' },
  ] },
  { title: 'Connect an AI agent', items: [
    { q: 'What does connecting an AI do?', a: 'An assistant such as Claude edits the same timeline you see: it reads your tag points, drops sound effects on every beat, writes titles, cuts on exact words and runs your Start Recipe from one sentence. It works through a local bridge, so nothing about your project leaves your computer through VidHelm.', action: 'connect' },
    { q: 'How do I connect Claude Desktop?', a: '1. Install Node.js 18 or newer (nodejs.org). 2. Click Connect AI and choose Claude Desktop. 3. Copy the config it shows into Claude Desktop: Settings, Developer, Edit Config. 4. Fully quit and reopen Claude Desktop, and keep VidHelm open.', action: 'connect' },
    { q: 'How do I connect Claude Code?', a: 'Click Connect AI, choose Claude Code and press Copy & open a terminal. Paste, press Enter, then restart Claude Code. The command already has your real install path in it.', action: 'connect' },
    { q: 'Can I use Cursor, VS Code, Codex, Gemini CLI or a local model?', a: 'Yes. Any assistant that speaks MCP works, and Connect AI writes the setup for each one. Local models (LM Studio, Ollama with a front-end, Jan) work fully offline, as long as the model supports tool calling.', action: 'connect' },
    { q: 'Does it cost anything?', a: 'VidHelm and its bridge are free. If you already use an assistant such as Claude, connecting it costs nothing extra.' },
  ] },
  { title: 'Troubleshooting', items: [
    { q: 'My AI says "VidHelm is not running"', a: 'The bridge only exists while VidHelm is open. Open VidHelm, then ask again. If it still fails, open Connect AI and press Test connection.', action: 'connect' },
    { q: 'The AI connected but no VidHelm tools show up', a: 'Fully restart the AI app: most only read their setup when they start. Check the config pasted cleanly (no stray commas). In Claude Code, type /mcp to see the server.', action: 'connect' },
    { q: 'Tools show up but every call fails', a: 'Open Connect AI and press Test connection. If the bridge is green, the assistant cannot start the server: usually Node.js is missing or the path in the config is old. Copy a fresh config from Connect AI.', action: 'connect' },
    { q: 'Playback is slow or choppy', a: 'Heavy files (4K, HDR, some phone formats) get a lighter preview copy built in the background, and the Media panel shows its progress. High quality exports read your original files; Standard exports use the copy only when it already matches the export size and frame rate.' },
    { q: 'Something is broken or I want a feature', a: 'Tell us on Discord or open a GitHub issue with what you clicked, what happened and your VidHelm version (shown under the (i) button at the top).' },
  ] },
]

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9:\- ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Offline answer: the best keyword match, or null when nothing fits well enough. */
export function localAnswer(question: string): HelpEntry | null {
  const q = ' ' + norm(question) + ' '
  let best: HelpEntry | null = null, bestScore = 0
  for (const e of HELP_ENTRIES) {
    let score = 0
    for (const k of e.keys) {
      const nk = norm(k)
      if (q.includes(' ' + nk + ' ')) score += nk.includes(' ') ? 3 : 2       // whole word or phrase
      else if (nk.length > 3 && q.includes(' ' + nk)) score += 2              // plurals, -ing forms
      else if (nk.length > 3 && q.includes(nk)) score += 1                    // inside a longer word
    }
    if (score > bestScore) { bestScore = score; best = e }
  }
  return bestScore >= 2 ? best : null
}

const ACTION_RE = /\[\[open:([a-z0-9]+)\]\]/g
/** Pull [[open:x]] tags out of a reply: the text without them, plus the valid actions in order. */
export function parseActions(text: string): { text: string; actions: HelpAction[] } {
  const actions: HelpAction[] = []
  for (const m of text.matchAll(ACTION_RE)) {
    const a = m[1] as HelpAction
    if (a in ACTION_LABELS && !actions.includes(a)) actions.push(a)
  }
  return { text: text.replace(ACTION_RE, '').replace(/[ \t]+\n/g, '\n').trim(), actions: actions.slice(0, 3) }
}

/** What the app tells the helper about the moment the question was asked. */
export interface HelpContext { version?: string; clips?: number; duration?: number; format?: string; aiKeys?: boolean; assistantConnected?: boolean }

export function helpSystemPrompt(ctx: HelpContext = {}): string {
  const facts = HELP_ENTRIES.map(e => `- ${e.topic}: ${e.answer}${e.action ? ` [[open:${e.action}]]` : ''}`).join('\n')
  const now = [
    ctx.version && `version ${ctx.version}`,
    typeof ctx.clips === 'number' && `${ctx.clips} item(s) on the timeline`,
    typeof ctx.duration === 'number' && ctx.duration > 0 && `${Math.round(ctx.duration)} s long`,
    ctx.format && `format ${ctx.format}`,
    typeof ctx.aiKeys === 'boolean' && (ctx.aiKeys ? 'AI clip keys added' : 'no AI clip keys yet'),
    typeof ctx.assistantConnected === 'boolean' && (ctx.assistantConnected ? 'an AI assistant is connected' : 'no AI assistant connected yet'),
  ].filter(Boolean).join(', ')
  return `You are the built-in help for VidHelm, a desktop video editor for Windows. You answer questions from the person using it, right now, inside the app.

How to answer:
- Short and practical: 1 to 4 sentences, or a few numbered steps when there are steps. Plain words, no jargon, no markdown headings, no em dashes.
- Name buttons exactly as they appear (for example "Cut Pauses on the toolbar", "the Export tab on the right").
- Only describe features listed below. If something is not listed, say VidHelm does not do that yet and suggest the closest thing it does, or reporting it on GitHub as a feature request.
- When a panel would help, end with its tag on its own, e.g. [[open:booth]]. At most two tags. Valid tags: ${Object.keys(ACTION_LABELS).join(', ')}.
- You cannot click or change anything yourself; the tags become buttons the person can press.
- Stay on VidHelm and video making. Politely decline anything else.

The app right now: ${now || 'unknown'}.

Where to get a person: Discord ${SUPPORT.discord} (fastest), email ${SUPPORT.email}, or a GitHub issue at ${SUPPORT.issues}. Offer these when you cannot solve something, when something seems broken, or when they ask for a human.

What VidHelm does:
${facts}

Common questions and the answers to give:
${FAQ.map(sec => sec.items.map(i => `- ${i.q}: ${i.a}`).join('\n')).join('\n')}`
}
