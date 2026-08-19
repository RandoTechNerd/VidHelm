# B-roll, precise cuts, and vertical framing

Three things that go together, because they all depend on knowing exactly what was said and when.

## The short version

1. Drop your cutaway footage in a `broll` folder inside your project folder.
2. Ask your AI to look through it. It measures every clip and gets one contact sheet per clip.
3. It looks at each sheet and writes down what is in it. Those labels live in `.vidhelm-broll.json` next to the footage, so they survive and you can edit them yourself.
4. It matches the labels against what you actually say, shows you the plan, and only then puts anything on the timeline.

Your audio is never touched. A cutaway replaces the picture and hands it back.

## Why b-roll is its own track

`v2` sits above `v1` and is **picture only**. That is enforced everywhere: a `v2` clip contributes no audio to the export, to the preview, or to any of the audio mixes used for transcription and pause detection.

```
audio    ─────────────────────────────────────────────────────  your voice, untouched
picture  ──── you ────┤ beans going into the hopper ├──── you ──
                      ▲                              ▲
       cuts in on the first word of the sentence     cuts out after its last word,
                                                     before the next one starts
```

If you want the natural sound of a cutaway, add that clip to `a1` or `a2` separately and set its level. It is not automatic, on purpose: a cutaway that brings its own room tone in and out under a continuous voice track sounds like a fault.

## The rules a plan follows

| Rule | Default | Why |
|---|---|---|
| Covers a whole sentence | — | Cutting away mid-thought reads as a mistake |
| Shortest cutaway | 1.4s | Anything less is a flash frame |
| Longest cutaway | 5s | Longer and the viewer wonders where you went |
| Back on camera between cutaways | 4s | Otherwise it is a slideshow, not a video |
| Share of runtime | 35% max | A review where you never see the reviewer is a slideshow too |
| Opening left alone | first 8s | The viewer needs to see who is talking |
| Times one clip may be used | 2 | Reusing the same shot five times is obvious |
| Never stretched or looped | — | If the footage runs out, the cutaway is shorter, or skipped |

All of them are adjustable per run. If nothing matches a line well enough, nothing is cut in: staying on the speaker always beats cutting to footage that does not match the words.

## Cutting to a spoken line

The problem this solves, in one example. You want:

> Check out this portable espresso maker.

and the take actually runs on:

> Check out this portable espresso maker and this…

Cut at the end of that transcript segment and you keep the dangling half-clause. `find_phrase` and `cut_at_phrase` end on the last word of the **thought**: they walk back over trailing fillers ("um", "like"), over an unpunctuated run that begins with a clause starter ("and this", "so then"), and over a dangling article or preposition. A real sentence that happens to end in "that" or "it" is left alone.

The chosen point is then snapped to the actual waveform: a short window either side is decoded and the cut moves to the edge of silence, so no consonant is clipped and no dead air is left. If the window has no edge to snap to, the estimate is kept unchanged rather than dragged somewhere arbitrary.

Speech is read with word timings using the `small` Whisper model by default rather than `tiny`, because everything else measures from it. The first use downloads that model once; pass `model: "base"` if you would rather it were quicker.

The transcription windows also overlap by 1.5s and de-duplicate, because slicing every 30 seconds on the dot lands mid-word and loses it from both sides.

## Vertical framing for Shorts

A 9:16 crop out of 16:9 throws away two thirds of the width. `plan_framing` decodes the clip at 4fps and works out which third to keep, per shot, using column detail plus movement.

Two rules make it read as deliberate:

- **Hold.** Inside a shot the crop does not move unless the subject genuinely does, for at least 0.8s, by more than 9% of the frame width.
- **Ease.** Short holds are rate-limited so a flurry of reframes cannot read as a glitch. A hold that lasts a while is not rate-limited: it goes where the subject actually is.

Shot detection is relative to the clip's own median frame difference, not a fixed number. On real handheld footage at 4fps, consecutive frames inside one continuous shot already differ by a mean of ~23/255; a fixed threshold tuned for tripod footage calls almost every frame a cut, which turns every frame into its own shot and defeats the hold rule entirely.

### It cannot tell you what the subject is

Detail and motion find the biggest, busiest thing in frame. That is often the subject and sometimes not: on a coffee grinder review it framed a large black canister sitting next to the grinder, because the canister is bigger and higher contrast.

So `plan_framing` returns a **proof sheet**: the middle frame of every hold with the proposed crop drawn on it. Look at it. Where it is pointing at the wrong thing, pass `hints` (`"3@0.72, 9.5@0.35"` = at 3s the subject is 72% across, at 9.5s it is 35% across) and run it again. The hints win.

## Tools

| Tool | What it does |
|---|---|
| `scan_broll` | Measure a folder: length, sound, usable range, contact sheet per clip |
| `label_broll` | Record what is in one clip, after looking at its sheet |
| `plan_broll` | Match labels to spoken sentences; changes nothing |
| `place_broll` | Commit the plan to the `v2` track |
| `analyze_speech` | Read every word with timings; cached until the timeline changes |
| `find_phrase` | Exact in/out points for a spoken line; changes nothing |
| `cut_at_phrase` | The same, then cut (`end`, `start` or `split`) |
| `plan_framing` | Where a 9:16 crop should point, plus a proof sheet |

## Checking it on your own footage

The unit suites (`npm run test:speech`, `test:framing`, `test:broll`) cover the maths on synthetic input. To check the ffmpeg plumbing against a real file:

```
node scripts/livecheck.mjs "C:\path\to\a-real-video.mp4"
```

It decodes frames, plans a crop, renders it, builds a contact sheet and refines a cut, and tells you what it found.
