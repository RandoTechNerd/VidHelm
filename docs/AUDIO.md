# Sound in VidHelm: Fix voice, the mix, and loudness

What VidHelm does to the sound between import and export, why, and the numbers it was tuned against. The code is in `electron/audiochain.ts` (the voice chain and every decision, pure), `electron/voicebake.ts` (runs it with ffmpeg), `electron/audiomix.ts` (the mix plan, pure), `electron/mixrender.ts` (runs the mix) and `src/previewAudio.ts` (the preview's copy of the mix). The settings were chosen in a six-chain shoot-out on a corpus of real and staged recordings, re-measured by two independent judges; the numbers below are from those renders.

## The short version

1. Every file with sound is measured once when it arrives (about a second per minute of sound, cached).
2. Every clip gets a **role**: Voice, Music, SFX or As is. Guessed until someone picks.
3. Every voice gets **Fix voice** (Studio by default): measured, cleaned only as far as its room needs, levelled, lifted to -16 LUFS. The result is baked once per file and cached; the preview plays it and the export reads it, so they cannot disagree.
4. Music sits 5 LU under the voice and dips 10 dB while someone speaks. SFX have their loudest moment set to the voice level and dip 6 dB.
5. The export lands on the loudness target (YouTube -14 LUFS by default) with ONE measured linear gain and a 4x oversampled -1.5 dBTP ceiling. Nothing compresses the whole mix.

## Roles

| Role | Bus | What happens |
|---|---|---|
| Voice | voice | Fix voice (Off, Light or Studio), no bus compressor; the bake owns its level |
| Music | music | set 5 LU under the voice, ducked 10 dB by keyframes from the voices' speech, a -6 dBFS bus limiter for drum hits |
| SFX | SFX | loudest 400 ms set to the voice level, ducked 6 dB, a -3.4 dBFS bus ceiling |
| As is | voice | played exactly as recorded, never ducked, never processed |

**The guess**, in order: set on the file wins; then where the file came from (booth, voiceover and narration takes are voices, `make_score` beds are music, the SFX library is effects) and the SFX track (`a2`); then the measured sound. Speech-like (pauses of 0.4 s or more exist, speech 25 to 92 percent of the time, a 400 ms loudness that moves by 2 dB or more) is a voice. Anything else is music on its own, and As is under a picture: a camera clip with music already mixed under the talking, processed as a voice, pumped 6.2 dB. A file that cannot be measured plays As is.

The role and the Fix voice level belong to the FILE (its bake and its guess are per file), so every clip cut from one recording follows. They are the only sound fields saved with a project (`mediaBin[].audio`, see PROJECT_FORMAT.md).

## Fix voice

| Preset | Head, channel, high-pass | Noise reduction | Levelling | Static lift | Knock dips | Room ease in pauses | 2:1 compressor + make-up | Limiter -3.3 dBFS |
|---|---|---|---|---|---|---|---|---|
| Off | format only, no gain | no | no | no | no | no | no | no |
| Light | yes | no | no | yes | yes | no | yes | yes |
| Studio (default) | yes | as the room needs (0 to 18 dB) | sections of 1.5 dB or more | yes | yes | up to 3 dB | yes | yes |

Inside Studio two guards downgrade on their own: a recording with no clear speech is left as is, and one with little speech (under 5 s, or under 25 percent of the time) runs the Light rules (noise reduction on sparse speech measured an 8.2 dB gain step; without it 1.1).

The principle: **a quiet recording is fixed by one measured static gain** that puts its speech at a known working level before any dynamics. Not peak normalising (a -0.2 dBFS knock blocked any lift), not a dynamic normaliser (it lifts the room one for one with the speech), not compressor make-up (every dB of gain reduction is a dB of room between syllables). Everything level-dependent then sits a known distance from the voice, so the compressor, the noise reduction and the limiter behave the same on a phone take and a studio take.

The chain, per file, at 48 kHz float stereo:

1. **Analysis** (streamed, never held in memory): BS.1770 K-weighted 10 ms blocks per channel, the room floor, the speech level, gated integrated loudness, a voice activity map (50 ms pre-roll, 150 ms hangover, gaps under 300 ms closed), the worst local speech-to-noise, the 4 to 9 kHz cost of folding the two sides together.
2. **Channel**: identical sides as they are; fold to mono unless it costs more than 1 dB of 4 to 9 kHz (two mics out of phase); else the cleaner side.
3. **High-pass** at 70 Hz (80 Hz raised the gain step on clean speech from 1.19 to 1.38 dB).
4. **Noise reduction** (`afftdn`) with a print learned from the recording's own longest pause, the noise floor told as floor + 6 dB (`nf`), only as many dB as the room needs and the worst speech-to-noise allows. The latency (round(0.025 x sample rate) samples) is trimmed off.
5. **Envelope**, as one gain file: the static lift (capped at +30 dB), the offline rider that levels quiet and loud sections, dips under knocks (taken before the compressor sees them), and the room eased down by at most 3 dB in pauses.
6. **Compressor** 2:1 with its threshold AT the working level (-16 dB, knee 4, attack 80, release 1000, RMS), so it only shapes the voice and never lifts the room.
7. **Make-up** measured, then the **limiter** at -3.3 dBFS, 4x oversampled (`aresample=192000,alimiter=...:level=disabled:latency=1,aresample=48000`). Measured again; up to 3 passes until the voice is at -16.0 LUFS.

The bake is a 24-bit FLAC in `userData/voice`, keyed on the file's path, size and time, the preset, the chain version and the ffmpeg build. Sample 0 is the media's own time zero, so `-ss sourceStart` lines it up with the picture exactly (lag 0 ms and length change 0 on every corpus file). A video on the timeline also gets a preview copy (its picture beside 256 kbps AAC of the bake) so the preview plays one file on one clock. The picture is the proxy when the footage needs one (the copy waits for it), copied as it is when that is cheap (a proxy, or an original up to 256 MB), else made small (1280 on the long side, H.264): copied whole, a folder of 4K phone clips came back as gigabytes each. A picture MP4 cannot carry as it is (VP8 from Chrome's recorder, Theora) is made small too. When no copy can be made the preview plays the recording lifted to the same level and the Inspector says so; the export has the bake either way. A voice still in the bin bakes its sound only.

What it says under the clip comes from the bake: "Lifted 18 dB, cleaned 16 dB of room noise", "Levelled 6 sections, up to +18 dB", "Tamed 6 knocks", "No clear speech, left as is".

### Measured on the corpus (Studio)

| File | Result |
|---|---|
| phone_raw (a real phone in a workshop) | -16.0 LUFS, -1.5 dBTP after the master, short-term spread 1.42 (raw 4.93), gain step 3.23, room -47.1 dBFS, the cleaner side kept (folding lost 3.7 dB of 4 to 9 kHz) |
| quiet_clean (VO at -36 LUFS) | gain step 1.19, room -58.0 |
| quiet_noisy (VO at -34 LUFS over a -62 dBFS room) | 16 dB cleaned, the room rose 4.1 dB for 18.1 dB of speech lift, gain step 1.20, room -56.5 |
| uneven (a speaker leaning away by up to 18 dB) | spread 1.38 (raw 6.28), 6 sections levelled up to +18, room -70.1 |
| peaky (knocks at -0.2 dBFS over quiet speech) | -3.2 dBTP, AAC -1.4 dBTP after the master (+0.1 before the 20 kHz low-pass) |

Five butt-joined clips from five sources land within 0.01 LU of each other (the old chain: 4.0 LU apart). A one-minute file bakes in 4 to 8 s; ten minutes in 46 s at a flat 205 MB.

## The mix

Three buses, summed, then the master:

- **Voice bus**: the bakes and the As is clips, each with the clip's own volume, automation and fades. No compressor.
- **Music bus**: each clip set to the bed level, `bedDb = (-16 - 5) - I_music`, then ducked. Speech segments from every voice (the bake's own, mapped to the timeline and joined across clips; pauses under 1.2 s stay ducked) become trapezoids: fully down 80 ms BEFORE the first syllable after a 200 ms dB-linear ramp, a 150 ms hold, a 300 ms release. A sidechain compressor cannot anticipate: with one, the first word landed on full-level music (ready at 3 percent of onsets). The keyframe duck is ready at every onset, flat under speech (gain stdev 0.00 dB), back in 0.55 s.
- **SFX bus**: each clip's loudest moment set to the voice, `sfxDb = -16 - M_sfx`, ducked 6 dB, a -3.4 dBFS ceiling so a whoosh under speech cannot push the sum past the master's linear window.
- **Sum**: the 20 kHz 4th-order Butterworth low-pass (it is linear, so it sits before the measurement), padded or trimmed to exactly the timeline's length.

The duck expression runs at a 1 ms step (`asetnsamples=n=48:p=0` before an `eval=frame` volume; at 480 samples the error on these ramps was 0.48 dB) and is written as a binary search on t: the flat sum of 200 ducks took 19 s per bus on a 10-minute timeline, the tree takes 0.5 s.

*Advanced mix* (Export tab) changes the music duck depth, the SFX duck depth and how far the bed sits under the voice. The preview and the export read the same three numbers.

Measured on the voice-over-music stems: voice over the bed 15.97 LU (worst segment 15.65), four ducks, music under speech flat to 0.00 dB, the master -14.02 LUFS.

## The master

1. **Pass 1**: the bus graph rendered once to a float premaster, measured as it is written (integrated loudness in JS to 0.01 LU, ffmpeg's ebur128 for the true peak).
2. **Gain**: `target - I_premaster`, plus the Master volume in dB. Then the 4x oversampled ceiling at -1.5 dBFS. When the ceiling may act (a hot Master volume, stacked SFX), the master is measured on the premaster and the loudness it cost folded back in (at most 3 audio-only passes) before the video pass starts.
3. The video export reads the premaster as its only sound.

Targets: YouTube and social -14 LUFS (default), Podcast -16, Broadcast EBU R128 -23, Audiobook -20, all at most -1 dBTP after AAC. *Optimize loudness* off: the Master volume and a -1 dBTP true-peak ceiling only.

**Where it will land** is measured before you export: a background scan renders the export's own bus graph to nothing (about 50x real time), debounced after edits and never while playing, and the Export panel reads "Export will land at -14.0 LUFS, -1.6 dBTP". Watch & Verify then measures the delivered file with the same meter and reports "planned -14.0, measured -14.0 LUFS, -1.4 dBTP (AAC)"; a true peak above -1.0 dBTP after AAC fails.

## The preview

The preview plays the export's mix rather than an approximation of it (`src/previewAudio.ts`):

- The DSP WebAudio cannot do (`afftdn`, the rider, the exact compressor) is not re-implemented: a voice plays its BAKE, the same file the export reads. While a bake runs, the original plays lifted by the predicted gain (`-16 - I`), so the level is right at once and the cleanup arrives when the bake does.
- Everything else is a gain, and WebAudio reproduces a gain exactly: each element feeds a clip gain (the role's level, the volume automation and the de-pop ramps, the fade-in ramp times the fade-out ramp as the export's two `afade` filters apply them), a bus gain (the ducks scheduled as 1 ms curves on the audio clock), and a master gain (the export's planMaster on the measured premaster, or on a prediction of -16, -16.5 with a bed, until the scan lands). `el.volume` stays 1: it clamps at 1.0, which is why the old preview could not play a lift or a +2 dB master.
- A safety DynamicsCompressor stands in for the ceiling. WebAudio's compressor adds its own make-up gain to everything ((1 / its gain at 0 dBFS) to the power 0.6, +0.86 dB at threshold -1.5, ratio 20), so a trim after it takes exactly that back off.
- The live meter is the momentary loudness (400 ms) of what is playing, read through the exact BS.1770 K-weighting (two IIR filters per side at the context's own rate), with the planned level marked.

`npm run test:previewaudio` turns the export's own filter strings back into JS and compares: the duck curve against the export's 1 ms frames (worst 0.05 dB), the clip gain against the planner's clip chain at 1,000 random times (worst 1e-6), and the roles, levels, ducks and master against the planner's.

What still differs, by construction: the bus limiters and the master's ceiling on the rare peak they catch (the safety stage stands in), and 256 kbps AAC in a video's preview copy.

## Gotchas (each one cost a measurement to find)

- **afftdn delays its output** by round(0.025 x sample rate) samples and nothing compensates; an untrimmed chain ships the voice 25 ms late.
- **`afftdn nf` is the noise floor, not a strength.** Telling it the room sits at -25 dBFS (the old Noise reduction checkbox) ate quiet speech: a 6.7 to 7.5 dB gain step.
- **loudnorm `linear=true` is not linear when it cannot be.** Whenever measured true peak plus the gain would pass its ceiling it silently falls back to its dynamic mode (an AGC). The master writes the gain itself.
- **A 48 kHz limiter lets inter-sample peaks through**: peaky measured -1.0 dBTP behind one, and the AAC went to +0.1. Every ceiling here runs at 192 kHz.
- **AAC overshoots on knocks** unless the top octave is gone first: the 20 kHz low-pass took the peaky master from +0.1 to -1.3 dBTP after AAC.
- **ffmpeg's attack and release are four time constants** (`FF_TC_DIVISOR`); `makeup` on acompressor is a linear factor (3 = +9.5 dB, not 3 dB).
- **Mono sources** upmixed by ffmpeg's own rematrix land 3 dB down; the mix copies a mono file to both sides at full level, as the preview plays it.
- **Head every graph with `aresample=48000:first_pts=0`**: an audio stream that starts after the picture is padded on the media's own clock, never slid onto the wrong frames.
- **No master compressor and no dynamic loudnorm**: both re-pump a ducked bed (music gain stdev 1.5 to 2.4 dB under speech). No parallel (NY) compression, no multiband, no gate, no speechnorm and no fixed EQ target: each was tried and measured worse.

## Where things live

- `userData/voice/<key>.flac`, `<key>.json`, `<key>.<picture>.mp4`: a bake, its decisions, a video's preview copy. The folder is held under 2 GB after each bake: least recently used bakes go first (they are made again if asked for), never one asked for since the app started.
- `userData/voice/<name>-sound-<hash>.json`: a file's measured sound as the mix reads it.
- `userData/voice/<name>-analysis-<hash>.json`: the import's measurement (what the Inspector and `analyze_audio` report).
- The corpus test, opt-in: `VIDHELM_AUDIO_CORPUS=<dir> npm run test:audiochain:corpus`.
