# Cloned-voice narration

RandoSnap's **🗣 Narrate** button runs any local TTS / voice-clone tool through a simple contract, then places the generated lines on your timeline (pinned to tag points when you have enough).

## The contract

In the Narrate dialog you configure one **command template**. Two placeholders are substituted at run time:

| Placeholder | Becomes |
|---|---|
| `{script}` | path to a UTF-8 text file containing your script, **one line per scene** |
| `{outdir}` | path to an empty folder your tool must fill with **one `.wav` per line** |

Rules:
- Output files are collected as `*.wav` from `{outdir}`, sorted **naturally** (`scene_1.wav, scene_2.wav, … scene_10.wav` sorts correctly).
- Exit normally when done; stdout/stderr stream into the dialog's log.
- That's the whole interface — any CLI that can read a text file and write WAVs works (XTTS, Piper, Coqui, ElevenLabs wrappers, `say` scripts…).

## Free local voice cloning with XTTS-v2

XTTS-v2 clones a voice from ~10 seconds of reference audio and runs fully offline. Setup (Windows, Python 3.10/3.11):

```bash
python -m venv xtts-venv
xtts-venv\Scripts\pip install TTS
```

Save this as `clone_voice.py` next to the venv:

```python
# clone_voice.py — RandoSnap narration adapter for XTTS-v2
# usage: python clone_voice.py <reference_voice.wav> <script.txt> <outdir>
import sys, os
from TTS.api import TTS

voice, script, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(outdir, exist_ok=True)
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")  # first run downloads the model

lines = [l.strip() for l in open(script, encoding="utf-8") if l.strip()]
for i, line in enumerate(lines, 1):
    print(f"[{i}/{len(lines)}] {line[:60]}", flush=True)
    tts.tts_to_file(
        text=line,
        speaker_wav=voice,
        language="en",
        file_path=os.path.join(outdir, f"scene_{i:03d}.wav"),
        # smoother deliveries: lower temperature = steadier, higher = livelier
        temperature=0.65,
        repetition_penalty=5.0,
        top_k=50, top_p=0.85,
        enable_text_splitting=True,
    )
print("done", flush=True)
```

Then in RandoSnap's Narrate dialog, set the command to:

```
xtts-venv\Scripts\python.exe clone_voice.py C:\voices\me.wav {script} {outdir}
```

**Reference audio tips**: 10–30 s of clean, dry speech (no music/room echo), 22 kHz+ WAV. Record a paragraph at your natural pace.

## Script-writing tips (learned the hard way)

- **Write flowing sentences**, not bullet points — TTS cadence follows punctuation.
- **Spell out numbers** ("nineteen fifty-nine", not "1959").
- Fix stubborn pronunciations by spelling words phonetically in the script, or keep a substitution table in your wrapper (e.g. `chromosome → chromohsom`). Exact-match substitution is safest — a stray space ("Cool Name" vs "CoolName") silently bypasses the rule.
- Keep lines under ~25 words; very long lines can wander or hang some models. One idea per line.
- Generate, listen, and re-run just the lines you hate — the booth is also great for re-recording a single line yourself.

## How lines are placed

- If you have **at least as many tag points as lines**, line *N* starts at tag *N* (sorted by time) — so tag your beats first and narration drops into sync.
- Otherwise lines are laid **back-to-back** from 0:00 on the VOICE / MUSIC track; slide them where you want them.
