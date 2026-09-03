# Cut-synced music (`make_score`)

VidHelm composes an original score that lands ON the edit, instead of a track
laid underneath it. Everything is synthesised (`electron/score.ts`), so there is
nothing to license and nothing to credit.

## What "synced" means here

- The **tempo is fitted to the cuts** you already made (`fitBpm`): candidate
  BPMs are scored by how close every cut sits to a beat, so downbeats and cuts
  agree instead of drifting past each other.
- A **stereo whoosh is centred on every cut** and pans across the field in the
  transition's direction. Fast cuts get a shorter, lighter whoosh.
- Every **tag point becomes a cinematic impact** (boom, crack, early
  reflections), and the bed **side-chain ducks** underneath it: 12 ms dive, 50 ms
  hold, 420 ms recovery. The pocket of silence is what makes a hit feel attached
  to the picture.
- **Bars containing 3+ cuts play denser** (16th hats, hotter riff); after the
  last tag the arrangement **calms down** to offbeat brushes; past the final cut
  the groove yields to a **drone** under your end card.
- Braams (detuned trailer swells) rise INTO section starts and a sub pitch-dive
  lands on them.

## Workflow

1. Edit the video first. The score is derived from the cuts, so it comes last.
2. Tag the moments that matter (press `M`, or `add_tag`): tags are the hits.
3. `make_score` — fits the tempo, renders, and places the bed on `a1`.
4. Listen. `seed` gives a different take of the same arrangement, `intensity`
   (chill / standard / epic) changes how hard it hits, `bpm` overrides the fit.
5. Re-edited the video? Just run `make_score` again.

## Hard-won engineering notes (why the code is the way it is)

- **Duck after saturation.** The low band is soft-clipped in the master, and
  tanh is compressive: ducking before it re-expands an 8 dB pocket to ~2 dB.
- **Saturate the low end, never shelve it.** A +4 dB shelf raises the peak, the
  normaliser takes the whole bed back down, and the result is mud at the same
  loudness. Soft-clipping raises low-end RMS without the peak, and its harmonics
  let a phone speaker imply bass it cannot reproduce.
- **Nothing near Nyquist.** Noise "brightened" with sample differencing parks
  energy at the top of the spectrum; AAC then overshoots by ~6 dB and rings.
  Everything is band-passed and the master is low-passed at 15.5 kHz.
- **Hats are humans, not clocks.** Accent patterns, per-hit resynthesis, random
  dropouts, and a calm-down after the last tag. A metronomic tick is most
  fatiguing exactly when the shots slow down and expose it.

## Two palettes

`make_score {style}` picks the kit:

- **electronic** (default): kick, clap, dynamic hats, an arp riff, braams into
  the sections, drone tail. The original.
- **cinematic**: bowed strings (three detuned voices per note), a **cello
  ostinato** (eighths in the groove, quarters once it calms), **felt piano** on
  the downbeats, **taiko** on 1 and 3 (every beat plus the "and of 4" when the
  edit is fast), a **choir** that blooms once the groove is under way (from the
  first bar in `epic`), braams and sub-dives into the sections, a **riser into
  every hit**, and a **pocket of silence** (`POCKET_SEC`, 340 ms) in the bed
  right before each drop. That pocket is why the drops land: the bed vanishes,
  the impact arrives into nothing, the bed returns ducked.

Both palettes share the same master (low-band saturation, post-saturation
duck, 15.5 kHz ceiling) and the same whoosh/impact fx bus; the cinematic bed
runs its whooshes at about half level so they read as air, not swishes.

## Making the hits exact: `snap_to_grid`

`make_score` fits a tempo TO the cuts. `snap_to_grid` (`electron/grid.ts`)
goes the other way: every join between picture clips is **rolled** onto the
nearest beat (the left clip grows or shrinks, the right clip slides its
in-point, nothing downstream moves, runtime unchanged) and every tag slides
onto the nearest **bar** line. Run it first, then `make_score` at the same
bpm, and every impact sits exactly on a downbeat. Rolls that would starve a
clip or run past its source are skipped and reported; `dryRun` previews.

Tests: `npm run test:score` asserts the musical properties (tempo recovery,
duck depth, stereo width only at cuts, hats calming, clean spectrum,
determinism per seed) rather than sample values.
