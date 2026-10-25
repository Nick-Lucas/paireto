# Paireto launch video

The deliverables are `brag.mp4` (1920×1080, 30 fps, 45 s), the poster `brag.jpg`, the storyboard `brag-plan.md` and the post text `share-copy.txt`.

The `/brag-slim` skill made this video. The skill comes from `latent-spaces/brag` and is pinned in `skills-lock.json`. The first run was:

```
/brag-slim --tone "app-store" --format landscape --duration "about 40 seconds"
```

To change the video, open Claude Code at the repository root and ask for the change, for example "re-roll the guided review scene" or "try the `cinematic` tone". The skill writes new output to `brag-output/` at the root (or to a timestamped folder if that folder exists), not to `demos/`. To edit this video in place, tell it to work in `demos/brag-output/`. To make only a small change, edit the files in `work/` and build again by hand as shown below.

## How it is made

- `work/index.html` draws every frame in the browser. `window.render(t)` is a pure function of time.
- `work/timeline.cjs` holds the scene times and event times in beats (96 BPM). The page and the synth both read it, so the sounds stay on the picture.
- `work/synth.mjs` writes the soundtrack to `work/music.wav`.
- `work/capture.mjs` runs headless Google Chrome and saves each frame as a JPEG.
- `work/encode.swift` joins the frames and the WAV into an H.264/AAC MP4 with AVFoundation.
- `work/verify.swift` reads the MP4 back and prints the duration and track data.

## Build

You need macOS with the Swift toolchain, Node and Google Chrome. Run these commands from `work/`:

```sh
swiftc -O encode.swift -o encode && swiftc -O verify.swift -o verify
node synth.mjs
node capture.mjs frames 0 1350 1
cp frames/f1320.jpg ../brag.jpg && cp frames/f1320.jpg frames/f0000.jpg
./encode frames 1350 30 music.wav ../brag.mp4
./verify ../brag.mp4
```

- **Frame count:** the frame count is the duration in `timeline.cjs` × 30. If you change the length, change `1350` in all three places.
- **Poster:** pick a frame from the settled outro, then copy it over frame 0 so that the poster becomes the thumbnail. This replaces frame 0 and adds no frame, so the duration and the audio sync do not change.
- **Faster capture:** `capture.mjs` takes a frame range, so you can run it in parallel chunks, for example `0 450`, `450 900` and `900 1350`.
- **Check stills:** to capture stills before a full render, run `TIMES=12.5,20.0 node capture.mjs stills`. This writes `stills/t12.50.jpg` and `stills/t20.00.jpg`.

`frames/`, `stills/`, `music.wav`, the compiled `encode` and `verify`, and the Chrome profiles are build output. Git ignores them.
