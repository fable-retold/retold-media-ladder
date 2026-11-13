# retold-media-ladder

Turn a video file into a **private, adaptive-bitrate HLS package** on disk: four H.264 rungs (1080 / 720 / 540 /
360 on the *displayed* short side), each one byte-ranged fMP4 `media.mp4`, with a poster, a `+faststart`
`download.mp4`, every identifying tag stripped, and a hashed `package.json` that the server and the player share.

It is the encoder half of the Retold media-sharing story:

- [`orator-file-service`](https://github.com/fable-retold/orator-file-service) serves a package's bytes
  (`addPackageRoute`, Range / 206 / HEAD).
- [`pict-section-fileview`](https://github.com/fable-retold/pict-section-fileview)'s `descriptorFromMediaPackage()`
  turns a `package.json` into a descriptor that
  [`pict-section-video`](https://github.com/fable-retold/pict-section-video) plays natively on Safari and via
  hls.js elsewhere.

Pushing packages to a server, audio (loudness-normalised) mode and waveform peaks are later work.

## Install

```bash
npm install retold-media-ladder
```

The only npm dependency is `fable-serviceproviderbase`. It needs **ffmpeg and ffprobe 7.x** on `PATH` (or point
`RETOLD_MEDIA_LADDER_FFMPEG` / `RETOLD_MEDIA_LADDER_FFPROBE`, or the `FFmpegPath` / `FFprobePath` options, at them),
built with `libx264`, `zscale` (zimg) and `tonemap`; `--fast` and the default decode use VideoToolbox on macOS.
Homebrew's `ffmpeg` has all of it.

## Command line

```bash
media-ladder probe  <in> [--raw]
media-ladder plan   <in> [flags]
media-ladder encode <in> --out <dir> [flags] [--force]
```

| Flag | Meaning |
|---|---|
| `--out <dir>` | Packages land at `<dir>/<PackageVersion>/` (built in `<dir>/<PackageVersion>.partial/`, renamed when complete; `<dir>/<PackageVersion>.lock` keeps a second encode of the same package out while one runs). |
| `--preset <name>` | x264 preset (default `medium`; `ultrafast` … `veryslow`). |
| `--fast` | Encode with `h264_videotoolbox` instead of x264 (average 80% of each rung's cap). Not always faster -- see [Speed](#speed). |
| `--profile hq` | Raise the 1080p cap from 6000k to 7800k. |
| `--slowmo` | Stretch high-frame-rate footage to 30 fps (every frame shown; audio is dropped). |
| `--lut <file.cube>` | Apply a 3D LUT (e.g. DJI's D-Log M → Rec.709 cube). D-Log has no tag, so it is never automatic. |
| `--no-download` | Skip `download.mp4`. |
| `--no-hwaccel` | Decode in software instead of VideoToolbox. |
| `--segment-seconds <n>` | HLS segment length (default 6). |
| `--force` | Rebuild an existing package that fails verification (a missing or changed file, an unreadable `package.json`). An **intact** package is never replaced -- see [Immutability](#immutability). Without `--force`, an identical re-run verifies the finished package and reuses it, and a damaged one is an error. |
| `--json` | `encode`: print `package.json` instead of the package path. |
| `--verbose` | Log more. |

`encode` prints progress on stderr and the finished package directory on stdout. Exit codes: `0` success, `1`
failure (including a failed sanitise gate, or another encode of the same package already running), `2` usage error,
`130` cancelled. The first Ctrl-C cancels whatever step is running -- hashing, the encode (ffmpeg gets SIGTERM, then
SIGKILL after 5 s), the poster, the remux or the sanitise probes -- and removes the partial package; a second
Ctrl-C SIGKILLs the step, removes the partial package and exits at once.

`plan` prints the plan JSON and the exact ffmpeg command line without encoding anything.

## The package

```
<PV>/package.json
<PV>/master.m3u8              # variants reordered so the 540p rung (or the closest <= 540) is FIRST
<PV>/v0/index.m3u8  v0/media.mp4   # v0 = top rung ... v3 = bottom rung (fewer when the source is small)
<PV>/poster.jpg               # JFIF only: no EXIF, no comment
<PV>/download.mp4             # +faststart stream-copy remux of the top rung (absent with --no-download)
```

```json
{
	"Version": 1,
	"Kind": "video",
	"PackageVersion": "1a2b3c4d",
	"DurationMS": 312000,
	"Width": 1920, "Height": 1080,
	"SegmentSeconds": 6,
	"HasAudio": true,
	"Manifest": "master.m3u8",
	"Poster": "poster.jpg",
	"Download": "download.mp4",
	"Renditions": [
		{ "Name": "1080p", "ShortSide": 1080, "Width": 1920, "Height": 1080, "FrameRate": 30,
		  "Bandwidth": 6234000, "Codecs": "avc1.640028,mp4a.40.2",
		  "Playlist": "v0/index.m3u8", "File": "v0/media.mp4", "Bytes": 81234567, "Sha256": "<hex>" }
	],
	"Audio": null,
	"Files": [ { "Path": "master.m3u8", "Bytes": 1234, "Sha256": "<hex>" } ]
}
```

- `Width` / `Height` (top level and per rung) are **displayed** pixels: a portrait 1080 rung is 1080x1920.
  `ShortSide` = min(Width, Height) and names the rung.
- `Renditions` are top rung first; index *i* is directory `v<i>`. `Bandwidth` / `Codecs` are copied from ffmpeg's
  master playlist (`BANDWIDTH` is ffmpeg's measured peak, audio included).
- `Poster` / `Download` are `null` when absent. `Files` lists every file in the package except `package.json`.
- No source file name, capture date, GPS, title or device information appears anywhere in the package.
- **`PackageVersion`** = the first 8 hex digits of `sha256(stable-JSON(plan) + ffmpeg version line + source
  sha256)`, always `^[0-9a-f]{8}$`. It identifies the **inputs**, not the bytes: the plan is fingerprinted without
  its `Warnings` and with a LUT identified by its sha256 rather than its path, so an encode with the same inputs
  lands in the same directory, and any change to the plan, the ffmpeg build or the source gets a new one. Two
  encodes with the same inputs do **not** produce the same bytes (below).

### Immutability

A finished package never changes: its media is served `private, max-age=86400, immutable`, a push is keyed by its
`PackageVersion`, and a player may hold cached byte ranges of `media.mp4` while it re-fetches the (`no-cache`)
playlists. But a re-encode is not byte-reproducible -- x264's VBV rate control (`-maxrate` / `-bufsize`) with
threads, and VideoToolbox, give different bytes on every run -- so re-encoding into an existing `<PV>/` would pair
new playlists with old cached media. The ladder therefore never replaces an intact package: an identical re-run
verifies every file against `Files[]` (`Bytes` and `Sha256`) and reuses it, `--force` only rebuilds a package that
fails that check, and to re-encode an intact one you delete it yourself (copies already served or pushed will then
no longer match their `PackageVersion`; the push protocol's `Files[]` hashes are what catch that).

A package is built in `<PV>.partial/` while `<PV>.lock` (pid, host, start time) is held. A second encode of the same
package into the same directory fails fast (`InProgress`) instead of deleting the first one's work; a lock whose
process is gone (a crash, a `kill -9`) is stale and is taken over, along with its partial directory.

Each rung playlist is `EXT-X-VERSION:7`, `EXT-X-PLAYLIST-TYPE:VOD`, `EXT-X-INDEPENDENT-SEGMENTS`, with
`EXT-X-MAP:URI="media.mp4",BYTERANGE=…` and one `EXT-X-BYTERANGE` per segment -- one file per rung, no `.m4s`.

## The encode

One ffmpeg pass:

```
ffmpeg -hwaccel videotoolbox -i in.mp4 -filter_complex \
 "[0:v]fps=<<=60>,scale=<TOP W>:<TOP H>,setsar=1,<tone-map | lut3d | nothing>,format=yuv420p,split=4[s0][s1][s2][s3];
  [s0]null[v0];[s1]scale=-2:720[v1];[s2]scale=-2:540[v2];[s3]scale=-2:360[v3]" \
 -map "[v0]" -map "[v1]" -map "[v2]" -map "[v3]" [-map 0:a:0 x4] \
 -map_metadata -1 -map_chapters -1 -fflags +bitexact -flags:v +bitexact \
 -c:v libx264 -preset medium -profile:v high -crf 21 -sc_threshold 0 -g <2s> -keyint_min <2s> \
 -force_key_frames "expr:gte(t,n_forced*2)" \
 -maxrate:v:0 6000k -bufsize:v:0 12000k  -maxrate:v:1 3000k -bufsize:v:1 6000k \
 -maxrate:v:2 2000k -bufsize:v:2 4000k   -maxrate:v:3 730k  -bufsize:v:3 1460k \
 [-c:a aac -b:a 128k -ac 2] -f hls -hls_time 6 -hls_playlist_type vod \
 -hls_flags single_file+independent_segments -hls_segment_type fmp4 \
 -hls_segment_filename "v%v/media.mp4" -master_pl_name master.m3u8 \
 -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2 v:3,a:3" "v%v/index.m3u8"
```

- **Rungs** sit on the displayed short side and never upscale (a 720p source gets 720 / 540 / 360; a source under
  360p gets one rung at its own size). Portrait uses `scale=S:-2`, by display rotation; ffmpeg autorotates the
  pixels, so a rotation-tagged 1920x1080 phone clip comes out 1080 wide.
- **Frame rate** above 60 fps is conformed by the smallest whole divisor (120 → 60, 100 → 50, 119.88 → 59.94);
  `--slowmo` stretches instead (`setpts`, then 30 fps). The keyframe interval is 2 s (1 s for an odd segment length).
- **Colour.** HLG (`arib-std-b67`) and PQ (`smpte2084`) sources are tone-mapped to 8-bit BT.709 with
  `setparams=…,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`
  -- after fps and the scale to the top rung, so the float maths runs once at 1080p instead of at 4K/100.
  `--lut` applies `lut3d` instead. A 10-bit source tagged SDR warns "possibly D-Log".
- **No audio stream** (DJI Mini / Air) → video-only variants.
- Without `-hls_segment_filename`, ffmpeg 7.1 would name each single file `index.m4s`.
- **Very short clips.** ffmpeg 7.1 leaves segments of 0.5 s or less out of its bandwidth measurement, so for a clip
  that short it writes a master playlist with **no variants** ("Bandwidth info not available"). The ladder then
  rebuilds the master from the rung playlists with ffmpeg's own numbers -- `BANDWIDTH` = segment bytes × 8 /
  duration, `CODECS` from each init section's `avcC` (+ `mp4a.40.2`), `RESOLUTION` from the plan -- and raises a
  rung playlist's `EXT-X-TARGETDURATION:0` to `1`.

### Speed

Measured on an M4 Pro with Homebrew ffmpeg 7.1 (whole `media-ladder encode` pipeline, synthetic `testsrc2`
sources): a 1080p30 10 s clip took 2.6 s with x264 `medium` (about 3.8× realtime) and 3.9 s with `--fast` (about
2.6×); the bare ffmpeg ladder alone was 1.8 s against 3.0 s, and dropping `-maxrate` or `-force_key_frames` does
not speed VideoToolbox up. So on this machine `--fast` trades quality per bit for **no** speed on easy 1080p SDR.
Synthetic test patterns are unusually cheap for x264, though; re-time on real footage (SDR 30, HLG 60/100, D-Log)
before choosing `--fast` for throughput. The tone-map dominates HLG/PQ sources whichever encoder runs.

After the encode: master reorder (540p first), poster (the `thumbnail` filter from ~10% in, through the same scale
and colour chain, written as a full-range JFIF JPEG), `download.mp4` (stream copy, `+faststart`, metadata stripped),
the **sanitise gate**, `package.json`, then the rename into place.

### The sanitise gate

Every output is ffprobed (and the poster's JPEG markers and the playlists' text are read). The encode **fails** --
and the partial directory is removed -- on any `location` / ISO 6709 / GPS tag, `creation_time`,
`com.apple.quicktime.*` or device tag; any data, subtitle or attachment stream (DJI telemetry and the home point hide
in data tracks); an attached picture or chapters; any other metadata tag at all; a JPEG APP1–APP15 segment (EXIF,
XMP, ICC) or comment; or a playlist date tag. Only the structural MP4 brand tags, generic handler names, the null
vendor id, a language code and ffmpeg's own `encoder=Lavf…` / `Lavc…` may survive.

## Programmatic use

```javascript
const libRetoldMediaLadder = require('retold-media-ladder');

// With a Fable:
pFable.addAndInstantiateServiceType('RetoldMediaLadder', libRetoldMediaLadder);
let tmpLadder = pFable.RetoldMediaLadder;

// ...or standalone:
let tmpLadder = new libRetoldMediaLadder({ FFmpegPath: '/opt/homebrew/bin/ffmpeg' });

let tmpHandle = tmpLadder.encode('/footage/DJI_0001.MP4',
	{
		OutputDirectory: '/packages',
		Preset: 'medium',            // or Fast: true
		onProgress: (pEvent) => console.log(pEvent.Phase, pEvent.Percent)
	},
	(pError, pResult) =>
	{
		// pResult: { PackageVersion, PackageDirectory, Package, Plan, Warnings, Sanitise, Reused }
	});
// tmpHandle.cancel();  -> stops the running step (hash, ffmpeg SIGTERM then SIGKILL, poster, remux, probes);
//                         the callback gets an Error with .Cancelled = true
// tmpHandle.abort();   -> SIGKILL now, remove the partial package, call back at once (also .Cancelled)
```

| Method | Result |
|---|---|
| `probe(pInputPath, fCallback)` | `fCallback(pError, pSummary)` -- see `MediaProbe` below. |
| `plan(pInputPath, pOptions, fCallback)` | `fCallback(pError, { Probe, Plan, Arguments, CommandLine })`, no encode. |
| `encode(pInputPath, pOptions, fCallback)` | Returns `{ cancel(), abort() }`. Options: `OutputDirectory` (required), `Preset`, `Fast`, `Profile` (`'standard'` / `'hq'`), `SlowMotion`, `Lut`, `Download` (default true), `Hwaccel` (default true on macOS), `SegmentSeconds`, `CRF`, `Force` (rebuild a damaged package; never an intact one), `onProgress({ Phase, Percent, Message })`. Phases: `probe`, `hash`, `plan`, `verify` (an existing package), `encode`, `poster`, `download`, `sanitise`, `package`, `done`. Errors may carry `.Cancelled`, `.InProgress` (another live encode holds `<PV>.lock`) or `.PackageExists` (`Force` on an intact package). |

### Services

Each is a `fable-serviceproviderbase` service (construct with a Fable, or with just an options object), exported on
the main module and available on a ladder instance under the same name. Callbacks are `fCallback(pError, pResult)`,
and every asynchronous method returns a handle whose `cancel(pImmediate)` stops it (the callback then gets an Error
with `.Cancelled = true`; `pImmediate` means SIGKILL rather than SIGTERM).

| Service | Job | Pure helpers |
|---|---|---|
| `MediaProbe` | `probe(pPath, fCb)` / `probeRaw(pPath, fCb)`: full ffprobe JSON condensed to `{ DurationSeconds, HasVideo, HasAudio, AudioStreamCount, DataStreamCount, Video: { Width, Height, Rotation, DisplayWidth, DisplayHeight, FrameRate, FrameRateValue, PixelFormat, BitDepth, ColorTransfer, ColorPrimaries, ColorSpace, ColorRange, Transfer ('sdr'/'hlg'/'pq'), IsHDR }, Audio, Raw }`. | `summarize(pRaw)`, `normalizeRotation`, `streamRotation`, `streamBitDepth`, `classifyTransfer` |
| `LadderPlanner` | `plan(pSummary, pOptions)` → the plan; `buildEncodeArguments(pPlan, pInput)`. | `planLadder`, `buildFilterGraph`, `buildPictureChain`, `buildVarStreamMap`, `buildEncodeArguments`, `toneMapChain`, `lutChain`, `evenScaledLongSide`, `chooseFirstVariantIndex`, `formatCommandLine` |
| `EncodeRunner` | `run(pArgs, { Cwd, DurationSeconds, onProgress, KillTimeoutMS }, fCb)` → `{ cancel(pImmediate), Process }` (async spawn, `-progress pipe:1`); `packagePaths` (`{ PackageDirectory, PartialDirectory, LockFile }`), `claimLock`, `releaseLock`, `preparePartial` (claims the lock first), `commitPartial(pOut, pPV, pReplaceDamaged)`, `discardPartial` (releases the lock). | `parseProgressChunk`, `progressSeconds`, `progressPercent`, `readLockOwner`, `lockOwnerIsLive` |
| `PosterBuilder` | `build(pPlan, pInput, pOutput, fCb)` | `buildPosterArguments` |
| `DownloadBuilder` | `build(pTopMedia, pOutput, fCb)` | `buildDownloadArguments` |
| `Sanitiser` | `checkFiles(pDirectory, pRelativePaths, fCb)` → `{ Passed, Violations: [{ File, Where, Key, Value, Reason }], Checked }` | `inspectProbe`, `inspectJpeg`, `inspectPlaylist`, `describeViolations` |
| `PackageWriter` | `computePackageVersion(pPlan, pFfmpegVersion, pSourceSha256)`, `reorderMasterFile(pDir, pPlan)` (rebuilds a master missing variants), `measureRungs(pDir, pPlan)`, `verifyPackage(pDir, pPackageVersion, fCb)` → `{ Intact, Problems, Document }`, `hashFiles(pDir, pPaths, fCb)`, `write(pDir, { Plan, PackageVersion, Variants? }, fCb)` | `parseMasterPlaylist`, `reorderMaster`, `parseMediaPlaylist`, `parseByteRange`, `measureBandwidth`, `codecsFromInit`, `buildMasterPlaylist`, `planFingerprint`, `computePackageVersion`, `buildPackageDocument`, `listPackageFiles` |

## Tests

```bash
npm test
```

Pure planner / package / sanitiser tests run from ffprobe fixtures. The integration suite synthesises tiny sources
with ffmpeg lavfi (landscape with audio, native and rotation-tagged portrait, no audio, 10-bit HLG, 100 fps, a 0.3 s
clip, and a clip carrying location / creation_time / Apple tags), encodes each with `--preset ultrafast`, and checks the
on-disk contract: every file in `package.json` exists with matching `Bytes` / `Sha256`, the master starts on the
≤540 rung, every rung is a single_file fMP4 byte-range playlist with `EXT-X-MAP` → `media.mp4` (no `index.m4s`),
ffprobe of every output passes the sanitise gate, a portrait top rung is short-side wide, and tone-mapped output is
8-bit BT.709. Lifecycle tests cover reuse after verification, `--force` refusing an intact package and rebuilding a
damaged one, two concurrent encodes of one package, and cancel / abort in each phase (including the CLI's second
Ctrl-C). It skips loudly when ffmpeg is not installed.

## License

MIT
