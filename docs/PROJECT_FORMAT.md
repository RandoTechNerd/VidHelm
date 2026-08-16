# Project file & state format

`Save` writes a single JSON file (version 2). The agent bridge's `get_state` returns a close cousin of this shape. Both are stable, hand-editable, and diff-friendly, a valid target for scripts and agents.

```jsonc
{
  "version": 2,
  "orientation": "landscape",      // landscape | portrait | square
  "resolution": "1080p",           // 4K | 1440p | 1080p | 720p
  "fps": 30,                        // 24 | 30 | 60
  "masterVolume": 1,
  "exportQuality": "high",         // medium | high

  "mediaBin": [
    { "id": "abc123", "name": "clip.mp4", "path": "C:\\videos\\clip.mp4",
      "type": "video",             // video | audio | image
      "duration": 12.4, "hasVideo": true, "hasAudio": true }
  ],

  "clips": [
    { "id": "c1", "mediaId": "abc123", "type": "video",
      "trackId": "v1",             // v1 = video · a1 = voice/music · a2 = SFX
      "start": 0,                  // seconds on the timeline
      "duration": 8.0,
      "sourceStart": 2.0,          // seconds into the source file
      "volume": 1,                 // 0..2 flat gain (ignored if volumePoints set)
      "fadeIn": 0.5, "fadeOut": 0.5,
      "volumePoints": [            // optional volume automation (t relative to clip start)
        { "t": 0, "v": 1 }, { "t": 3, "v": 0.3 }
      ] }
  ],

  "texts": [
    { "id": "t1", "text": "Hello", "start": 1, "duration": 3,
      "x": 0.5, "y": 0.2,          // 0..1 of frame, anchor = center
      "fontSize": 64,              // px at 1080p height (scales with resolution)
      "color": "#ffffff", "fadeIn": 0.3, "fadeOut": 0.3,
      "box": true, "boxOpacity": 0.5 }
  ],

  "markers": [                     // tag points, the beat map
    { "id": "m1", "t": 3.5, "label": "hook", "color": "#f472b6" }
  ]
}
```

Notes for tooling:

- **Media paths are absolute**: projects reference files in place, nothing is copied.
- Overlapping `v1` clips composite in array order (later on top); give both fades for a crossfade.
- All clips with audio are mixed regardless of track; tracks are an organizational convention (`a2` keeps effects out of the voice lane).
- `markers` don't affect rendering: they're coordination points for humans, the karaoke booth, narration placement, and agents.
- The bridge's `get_state` flattens this for reading (media names inlined into clips, tags sorted); write operations go through `POST /command` actions rather than file writes, so the GUI updates live and undo history stays intact.
