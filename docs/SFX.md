# Sound effects: finding them, and making them

Two ways to get a sound into a video. Find one that somebody already recorded, or model the thing that makes it.

## Finding one (the 🔎 Find button in the SFX panel)

VidHelm searches free libraries and shows you the **licence** next to every result, because that is the part that matters if the video is monetised.

| Provider | Setup | What it is good for |
|---|---|---|
| **Wikimedia Commons** | none | Works out of the box. A thin, patchy selection: some genuinely good industrial field recordings, and a lot that is not a sound effect at all |
| **Freesound** | free API token | The real library. Hundreds of thousands of well-tagged effects with explicit per-sound licences |

**Get the Freesound token.** Without it, search is close to useless: a live test for "electronic door" against Commons alone returned two State of the Union addresses and an AI-generated music track. Create a free account, visit [freesound.org/apiv2/apply](https://freesound.org/apiv2/apply/), and paste the key into the 🔑 box. It is stored in your settings and used only for search.

### Licences are enforced, not just displayed

Every result is classified, and by default anything that cannot be used on a monetised video is **hidden**:

| Badge | Meaning |
|---|---|
| `free` (green) | CC0 or public domain. Use it, credit nothing |
| `credit` (amber) | CC BY or CC BY-SA. Use it, but the credit must appear in the description |
| hidden | Non-commercial, no-derivatives, or **no stated licence** |

Anything whose licence cannot be read is treated as unusable rather than assumed fine. The cost of being wrong is a copyright strike on somebody's channel, and "it came from a free site" is not a defence.

When you save a sound that needs crediting, the credit line is written into `CREDITS.txt` next to the file. A credit that only exists in a chat log is a credit that will be missing from the description.

Internet Archive was tested and deliberately left out: relevance was poor and most items came back with `licenseurl: null`.

## Favourites

Every sound in the list has a star. Starred sounds sort to the top and stay there, so the handful you actually use stop being buried under thirty you do not. It is stored with your settings, not with the project.

## Describing one (the ✨ AI button)

Type what you want. If it is something the app can model, it says what it is about to make, fills in a name you can edit, and builds it: no generator to install, no command line.

    "coffee beans into a glass jar, lots of them"  ->  coffee beans, into a glass jar, a lot of it
    "sci-fi door closing"                          ->  electronic door closing
    "jet zooming past"                             ->  engine flying past

Words like *lots*, *gentle*, *long*, *short* or a number of seconds shape it, and 🎲 rolls another take of the same sound. If the description is not something that can be modelled ("a dog barking"), it says so and points at the 🔎 Find button rather than pretending.

The external text-to-audio generator is still there, moved under "Use an external AI generator instead". It used to be the only option, which meant installing a model and pasting a command line before the feature did anything at all.

## Making one (`make_sfx`, or the built-in list)

The older built-ins (pop, boing, whoosh, ding) are ffmpeg expressions: one closed-form formula per sample. That is a fine way to make a beep and a hopeless way to make coffee beans hitting a hopper, because that sound is a couple of hundred separate impacts all exciting the same resonant container. You cannot write that as a formula, you have to run the events.

So `electron/sfxsynth.ts` renders actual samples, and `electron/sfxrecipes.ts` composes them into models of real things.

| Recipe | What is modelled |
|---|---|
| `coffee-beans` (+`-plastic`, `-glass`) | A stream of impacts at Poisson-random intervals, a density envelope with stragglers at the end, pile-up as beans start landing on beans, and one shared container resonance |
| `door-electronic` (+`-close`) | Four beats: latch click, pneumatic release whose noise band falls as pressure drops, servo whine, panel seating |
| `podracer-start` | Individual combustion events at a rate that climbs until they fuse into a note: burble, then a deep bass growl powering up |
| `podracer-pass` | The engine flown past the listener with real Doppler |

Every recipe takes a **seed**, so the same seed is the same take and a different seed is another take of the same idea. `intensity` changes how much of the thing there is (more beans, a bigger door).

### The Doppler is geometry, not a pitch bend

`passBy()` computes the source's distance every sample and uses it as a **delay**. The pitch shift then falls out of the geometry exactly as it does in air, along with inverse-distance loudness, air absorption (distance eats the top end) and the stereo angle. One consistent set of physics instead of three automation curves that never quite agree.

Verified against the textbook, on a pure 200Hz tone:

| Speed | Approaching (measured / theory) | Receding (measured / theory) |
|---|---|---|
| 25 m/s | 213 / 216 Hz | 186 / 186 Hz |
| 60 m/s | 234 / 242 Hz | 166 / 170 Hz |
| 95 m/s | 255 / 277 Hz | 145 / 157 Hz |

The measured values sit just inside the theoretical extremes because the analysis window spans a range of velocities. A stationary source shifts by 0 Hz, which is the test that catches a hidden pitch ramp pretending to be physics.

## How this is tested without ears

`npm run test:sfxsynth` asserts **acoustic properties**, not sample values:

- a pour is made of many separate onsets, gets duller as the pile builds, and thins to stragglers rather than cutting to silence
- a glass jar rings brighter than a plastic tub
- the door's pneumatic release falls in pitch, and the panel seats with a thud
- the engine note rises as it spools up
- the pass-by peaks at the closest point, travels left to right, dulls as it leaves, and drops in pitch by the amount the geometry demands

That is also how the tuning got done. Three examples of measurement changing the model:

- **420 beans/second was a flat "shhhh".** The impacts overlapped fourteen deep. At 150/s individual beans start poking through, which is also roughly what a scoop really is.
- **The air rush was laid over the top of the pass-by**, so it kept its level while the engine fell away with distance, and the racer ended up *brighter* leaving than passing (measured 754Hz against 1466Hz). It is now part of the source and gets flown past with everything else.
- **The start and the fly-past want opposite things.** A racer on the line is all chest, and the scream only arrives once it is moving, so the start is modelled an octave down with 83% of its energy under 320Hz while the pass-by keeps the turbine partials.
- **The podracer sat under 200Hz and rumbled like a tractor.** Turbines scream, so the model gained two high partials of the shaft speed and a filter that opens far enough to let them out.

`node scripts/sfxlab.mjs [outDir]` renders every recipe to WAV and prints the measurements, which is the loop to use when tuning.
