# Cloned-voice narration

VidHelm's **🗣 Narrate** button runs any local TTS / voice-clone tool through a simple contract, then places the generated lines on your timeline (pinned to tag points when you have enough).

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

> **Easiest path:** open 🗣 Narrate → **🧬 No cloned voice yet? Create one** — the wizard records your reference sample and sets up either engine below for you, filling in the command automatically.

## Engine choice at a glance

| | XTTS-v2 (Python) | audio.cpp (no Python) |
|---|---|---|
| Install | Python 3.10+ plus a ~2 GB pip install (wizard automates it) | Unzip a prebuilt release + download a GGUF model |
| Speed | Slower, heavier | ggml-based, fast on CPU, optional CUDA/Vulkan builds |
| Quality | Excellent, battle-tested cloning | Varies by model family (PocketTTS, Fish, IndexTTS…), improving fast |
| **Model license** | **CPML — non-commercial use only** (check before using in monetized videos) | Framework is **Apache-2.0**; many model families (Qwen3-TTS, PocketTTS…) are Apache/permissive — check the model card |

## Free local voice cloning with audio.cpp (no Python)

[audio.cpp](https://github.com/0xShug0/audio.cpp) is a ggml-based local audio engine (think whisper.cpp, for TTS/voice-cloning/audio-gen). Setup:

1. Download a prebuilt Windows zip from its Releases page (`audiocpp-windows-cpu-balance.zip` is a good default) and unzip it.
2. Download a voice-cloning GGUF model package (Hugging Face: `audio-cpp/audio.cpp-gguf` — e.g. a PocketTTS or Fish variant) and unzip it.
3. In the wizard pick **audio.cpp**, record your sample, point it at `audiocpp_cli.exe`, the model folder, and the model's family name — VidHelm writes `vidhelm_voice.ps1` (which adapts the CLI to the `{script}`/`{outdir}` contract) plus your `vidhelm_reference.wav`, and fills in the command.

The generated command looks like:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\audiocpp\vidhelm_voice.ps1" {script} {outdir}
```

audio.cpp also powers the **✨ AI sound-effect generator** (SFX tab): with a `stable_audio` model downloaded, set the generator command once and describe any sound:

```
"C:\audiocpp\audiocpp_cli.exe" --task gen --family stable_audio --model "C:\models\stable-audio" --text "{prompt}" --out "{out}"
```

## Free local voice cloning with XTTS-v2

XTTS-v2 clones a voice from ~10 seconds of reference audio and runs fully offline. **Note:** the XTTS-v2 model weights are under Coqui's CPML license (non-commercial use) — fine for personal projects; for monetized content prefer an Apache-licensed audio.cpp model. Setup (Windows, Python 3.10/3.11):

```bash
python -m venv xtts-venv
xtts-venv\Scripts\pip install TTS
```

Save this as `clone_voice.py` next to the venv:

```python
# clone_voice.py — VidHelm narration adapter for XTTS-v2
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

Then in VidHelm's Narrate dialog, set the command to:

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
