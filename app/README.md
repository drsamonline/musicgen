# MusicGen — the studio

This folder is the installable PWA. See the [project README](../README.md) for
the full story, the architecture and the test suite.

```bash
cd app
python3 -m http.server 8080   # → http://localhost:8080
```

Modules and service workers need an origin, so `file://` will not work.

- `index.html` — the studio shell
- `src/core/` — composer, theory, voicing, motif, validator (pure, seeded)
- `src/audio/` — instruments, drums, FX, mastering, LUFS, scheduler
- `src/export/` — WAV, stems zip, MIDI, cover art, share links
- `qa/matrix.html` — the 27-song listening matrix, for judging composer changes
