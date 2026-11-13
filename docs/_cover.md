# Retold Media Ladder

> Adaptive-bitrate HLS packages from video files — probe, plan, one ffmpeg pass, sanitise, package.

- **Four H.264 rungs on the displayed short side** — 1080 / 720 / 540 / 360, never upscaled, portrait-aware
- **fMP4 single_file HLS** — one byte-ranged `media.mp4` per rung, 540p first in the master
- **Colour handled** — HLG / PQ tone-mapped to BT.709 after the scale; `--lut` for D-Log M
- **Private by construction** — GPS, capture dates, device tags and data tracks stripped, and a gate that fails the encode if any survive
- **A hashed contract** — `package.json` with every file's bytes and sha256, versioned by plan + ffmpeg + source

[Overview](README.md)
[GitHub](https://github.com/fable-retold/retold-media-ladder)
