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

`media-ladder push` sends a finished package to a media-ingest server: any server that speaks the small, generic,
resumable register / upload / commit protocol described under **Push protocol** below. The upload half of that
protocol is the resumable `PUT` / `HEAD` route that `orator-file-service`'s `addUploadRoute` serves. Audio
(loudness-normalised) mode and waveform peaks are later work.

## Install

```bash
npm install retold-media-ladder
```

The only npm dependency is `fable-serviceproviderbase`. It needs **ffmpeg and ffprobe 7.x** on `PATH` (or point
`RETOLD_MEDIA_LADDER_FFMPEG` / `RETOLD_MEDIA_LADDER_FFPROBE`, or the `FFmpegPath` / `FFprobePath` options, at them),
built with `libx264`, `zscale` (zimg) and `tonemap`; on macOS the default decode and `--fast` (which is macOS-only)
use VideoToolbox. Homebrew's `ffmpeg` has all of it.

## Command line

```bash
media-ladder probe  <in> [--raw]
media-ladder plan   <in> [flags]
media-ladder encode <in> --out <dir> [flags] [--force]
media-ladder push   <out>/<PackageVersion> [--server URL] [--token T] [push flags]   # see Pushing a package
media-ladder --version
```

| Flag | Meaning |
|---|---|
| `--out <dir>` | Packages land at `<dir>/<PackageVersion>/` (built in `<dir>/<PackageVersion>.partial/`, renamed when complete; `<dir>/<PackageVersion>.lock` keeps a second encode of the same package out while one runs). |
| `--preset <name>` | x264 preset (default `medium`; `ultrafast` … `veryslow`). |
| `--fast` | Encode with `h264_videotoolbox` instead of x264 (average 80% of each rung's cap). macOS only: anywhere else it is a usage error (exit 2). Not always faster -- see **Speed** below. |
| `--profile hq` | Raise the 1080p cap from 6000k to 7800k. |
| `--slowmo` | Stretch high-frame-rate footage to 30 fps (every frame shown; audio is dropped). |
| `--lut <file.cube>` | Apply a 3D LUT (e.g. DJI's D-Log M → Rec.709 cube). D-Log has no tag, so it is never automatic. |
| `--no-download` | Skip `download.mp4`. |
| `--no-hwaccel` | Decode in software instead of VideoToolbox. |
| `--segment-seconds <n>` | HLS segment length (default 6). |
| `--force` | Rebuild an existing package that fails verification (a missing or changed file, an unreadable `package.json`). An **intact** package is never replaced -- see **Immutability** below. Without `--force`, an identical re-run verifies the finished package and reuses it, and a damaged one is an error. |
| `--json` | `encode`: print `package.json` instead of the package path. |
| `--verbose` | Log more. |
| `-V`, `--version` | Print the version and exit (`0`). |

`encode` prints progress on stderr and the finished package directory on stdout. Exit codes: `0` success, `1`
failure (including a failed sanitise gate, or another encode of the same package already running), `2` usage error,
`130` cancelled. The first Ctrl-C cancels whatever step is running -- hashing, the encode (ffmpeg gets SIGTERM, then
SIGKILL after 5 s), the poster, the remux or the sanitise probes -- and removes the partial package; a second
Ctrl-C SIGKILLs the step, removes the partial package and exits at once.

`plan` prints the plan JSON and the exact ffmpeg command line without encoding anything.

### Pushing a package

`push` needs a server that speaks the media-ingest protocol (see **Push protocol** below) and a bearer token, issued
by that server's operator, that may publish media there. The client sends the token as `Authorization: Bearer <token>`
on every request and nowhere else.

```bash
export MEDIA_LADDER_SERVER=https://media.example
export MEDIA_LADDER_TOKEN=...            # the bearer token the server's operator issued you
media-ladder push /packages/1a2b3c4d --source /footage/DJI_0001.MP4 --title "Lake day"
# -> 3f0c2a8e-5b1d-4c7e-9a42-0d6f1e2b7c90 1a2b3c4d
```

| Flag | Meaning |
|---|---|
| `--server <URL>` | The server (`http` or `https`; a path is kept as a base path). Default `$MEDIA_LADDER_SERVER`. |
| `--token <T>` | Bearer token. Default `$MEDIA_LADDER_TOKEN` -- prefer the variable, since a flag shows up in the process list. Flags win over the environment. |
| `--prefix <path>` | Route prefix, appended to the server URL's path (default `/1.0/MediaIngest`). |
| `--source <original>` | Hash and probe the **original** file and send `Source: { Name, Sha256, Transfer, CaptureDate }` with the register, so the server can recognise re-encodes of one source as one asset. `Transfer` is `sdr` / `hlg` / `pq` from `color_transfer` (D-Log is tagged SDR, so `log` is never detected); `CaptureDate` is the `creation_time` tag (container, else the video stream), as ISO-8601 UTC, omitted when absent. None of it is in the package, and the original is never uploaded. |
| `--title <T>` / `--description <D>` | The asset's title and description (`push` sends a title only when you give one; it never derives one from the source name). Applied only when the push **creates** the asset (see the note below). |
| `--sensitivity <s>` | `normal` (default) or `conversation`. Applied only when the push **creates** the asset (see the note below). |
| `--chunk-mib <n>` | Upload chunk size in MiB, 1-1024 (default 32, orator-file-service's limit). Halves after a chunk takes over 120 s, never below 8 (or `n` when smaller). |
| `--retries <n>` | Consecutive failed attempts on one file (or on register / commit) before giving up, 0-100 (default 5; 0 and 1 both mean "no retry"). |
| `--json` | Print the result `{ AssetGUID, PackageVersion, State, UploadedFiles, UploadedBytes, TotalBytes, Source }` instead of `<AssetGUID> <PackageVersion>`. |

**A re-push never changes `--title`, `--description` or `--sensitivity`.** When the push lands on an asset that
already exists, the server keeps the asset's own values (how it recognises the asset is its own choice: typically the
same `--source` sha256, else the same `PackageVersion`). If the push asked for different ones and the server says so
(`Ignored` / `Current` in its register answer), `push` prints a warning on stderr naming what was kept (`--json`
carries `Ignored` and `Current` too); it still exits 0, because the upload itself succeeded. To change them, edit the
asset on the server by whatever means it offers (the warning suggests `PATCH <prefix>/<AssetGUID>`; `push` itself never
edits an asset). This matters most for `--sensitivity conversation`: a recording first pushed without it stays
`normal` until it is edited.

`push` only accepts a committed `<out>/<PackageVersion>/` that verifies intact (every `Files[]` entry's `Bytes` and
`Sha256`); `<PV>.partial/` (an unfinished encode), `<PV>.lock` and a damaged package are refused before anything is
sent. Progress goes to stderr and `<AssetGUID> <PackageVersion>` to stdout. Exit codes: `0` success (including "already
live, nothing sent"), `1` failure, `2` usage error, `130` cancelled. The first Ctrl-C drops the in-flight chunk (the
server keeps every whole chunk) and exits; running the same command again **resumes**. A second Ctrl-C exits at once.
The token is never printed or logged; a plain-`http` server that is not loopback gets a warning.

## The package

```
<PV>/package.json
<PV>/master.m3u8              # variants reordered so the 540p rung (or the closest <= 540) is FIRST
<PV>/v0/index.m3u8  v0/media.mp4   # v0 = top rung ... v3 = bottom rung (fewer when the source is small)
<PV>/poster.jpg               # JFIF only: no EXIF, no comment (absent when the video ends before ~10% in)
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
- `Poster` / `Download` are `null` when absent: there is no poster when the video stream ends before the poster's
  seek point (~10% in, so ffmpeg finds no frame there), and no download with `--no-download`. `Files` lists every
  file in the package except `package.json`:
  exactly the files the encode produced. A stray `.DS_Store`, `Thumbs.db` or `desktop.ini` that appears in the
  partial directory is never packaged or pushed.
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

## Push protocol

A generic, resumable upload of one package: **register** it, **upload** whatever the server is missing in raw chunks,
**commit** (and, only to settle an ambiguous commit answer, read the asset's **status**). `media-ladder push` is the
client; any server can implement the other side. The push tests run against a small reference server,
[`test/support/Fake-Media-Ingest-Server.js`](https://github.com/fable-retold/retold-media-ladder/blob/main/test/support/Fake-Media-Ingest-Server.js)
in this repository.

Every route sits under one prefix (`--prefix` / `Prefix`, default `/1.0/MediaIngest`), appended to the server URL's
own path: `--server https://host/base` puts the register route at `https://host/base/1.0/MediaIngest`. The upload
step is exactly the resumable route that `orator-file-service`'s `addUploadRoute` serves, so an Orator server can
mount that for it. Every request carries `Authorization: Bearer <token>` and `Accept: application/json`; every answer
except `HEAD` is JSON, with `{ "Error": "..." }` on failure. A `408` or any `5xx` means "try again": the client backs
off and tries again (see **What the client does**).

### 1. Register

```
POST <prefix>
Content-Type: application/json

{ "Package": { ...package.json... },
  "Title": "Lake day", "Description": "...", "Sensitivity": "normal",
  "Source": { "Name": "DJI_0001.MP4", "Sha256": "<64 hex>", "Transfer": "hlg", "CaptureDate": "2024-05-01T10:00:00.000Z" } }

200 { "AssetGUID": "3f0c2a8e-...", "PackageVersion": "1a2b3c4d", "State": "uploading",
      "Missing": [ { "Path": "v0/media.mp4", "Bytes": 81234567, "ReceivedBytes": 33554432 } ] }
```

- `Package` is the package's own `package.json` document. Everything else is optional: `Title`, `Description` and
  `Sensitivity` are sent only when given, `Source` only with `--source`.
- The server validates the document, mints the `AssetGUID` and maps a re-push onto the same asset, which is what makes
  a re-run resume. How it recognises a re-push is its own choice; the reference server matches `Source.Sha256` when
  one is sent, else the `PackageVersion`.
- The answer must carry the pushed `PackageVersion` and an `AssetGUID` of 1-128 characters from `A-Z a-z 0-9 _ - . ~`
  that does not start with `.` or `~` (it becomes a URL path segment); the client refuses any other.
- `Missing` lists the files not yet complete on the server: each a path, or `{ Path, Bytes, ReceivedBytes }`. A
  `Bytes` that differs from the package's fails the push, a path outside the package's `Files[]` is refused, and
  `ReceivedBytes` is informational (the client asks `HEAD` where to resume). The list is empty when everything is
  staged, and empty with `State: "ready"` when this version is already live.
- On a re-push of an existing asset the server keeps its Title, Description and Sensitivity. When the request asked for
  different ones, the server may say so: `"Ignored": ["Sensitivity"]` names the fields it kept, and `"Current": { ... }`
  carries the asset's values (the client reports any of `Title`, `Sensitivity` and `ConsentState` it finds there).
  The client warns and passes both into its result.
- `400 { Error, Errors: [...] }` rejects an invalid package document; `401` / `403` a token or account that may not
  publish.

### 2. Upload (each missing file)

```
HEAD <prefix>/<AssetGUID>/<PackageVersion>/File/<path>
200   Upload-Offset: <bytes the server holds>   Upload-Length: <the file's Bytes>

PUT  <prefix>/<AssetGUID>/<PackageVersion>/File/<path>
Upload-Offset: <offset>   Content-Length: <n>   Content-Type: application/octet-stream
<n raw bytes>

200 { "Success": true, "Offset": <new offset>, "ExpectedBytes": <Bytes>, "Complete": <bool> }   Upload-Offset: <new offset>
409 Upload-Offset is not the server's size (answered with Upload-Offset: <size>), or another upload to the file is live
409 { "Error": "Already committed." | "This package version is not being uploaded." }   (HEAD too, without the body)
413 the chunk is over the server's limit, or runs past the file's Bytes
```

- `<path>` is the package-relative path with each segment percent-encoded (`v0/media.mp4`); the server matches it
  against the registered `Files[]`. A ladder package only ever holds `master.m3u8`, `v<i>/index.m3u8`,
  `v<i>/media.mp4`, `poster.jpg` and `download.mp4`, so a server may also restrict names, for example to
  `^(v[0-9]/)?[a-z0-9_-]+\.(m3u8|mp4|m4a|jpg|json)$` (the reference server's pattern).
- The client takes the new offset from the `PUT` answer's `Upload-Offset` header (or, without one, from the JSON
  `Offset`); `Upload-Length` and the rest of the answer are informational. A `HEAD` answer must carry `Upload-Offset`.
- Chunks are **atomic**: a chunk cut off mid-body is truncated away, so `HEAD` only ever reports whole chunks.
- A `HEAD` answered `409` means the version is no longer open for upload (committed, or replaced by a re-encode's
  register); the client stops uploading and commits.

### 3. Commit

```
POST <prefix>/<AssetGUID>/<PackageVersion>/Commit        (no body)

200 { "AssetGUID": "...", "PackageVersion": "1a2b3c4d", "State": "ready", "TotalBytes": 123456789 }
409 { "Error": "...", "Missing": [ { "Path", "Bytes", "ReceivedBytes" } ] }   files not complete
409 { "Error": "...", "Mismatched": [ "v0/media.mp4" ] }                         wrong Sha256 or size (truncated to 0)
```

The server checks every staged file's size and sha256 against the registered `Files[]`, empties (truncates to 0) any
that does not match and names it in `Mismatched`, and only then makes the version live; how it publishes the files
after that is up to it. `Missing` / `Mismatched` entries may be paths or `{ Path }` objects. Committing a version that
is already live should answer `200`; a `200` without a `State` is taken as `ready`, and `TotalBytes` is optional.

### 4. Status (optional, read-only)

```
GET <prefix>/<AssetGUID>

200 { "Asset": { "AssetGUID": "...", "State": "ready", "PackageVersion": "1a2b3c4d", "TotalBytes": 123456789, ... } }
```

A commit `409` without `Missing` / `Mismatched` means either "this version is already live" or "this version is no
longer being uploaded" (a re-encode's register took its place). The client reads the asset's status to tell them apart:
`PackageVersion` is the asset's **live** version and `State` its state (a bare asset object, without the `Asset`
wrapper, is accepted too). A server without this route still works, but such a `409` then always fails the push (it
is never taken as success).

### What the client does

| Situation | `media-ladder push` |
|---|---|
| A network error, a socket idle for 120 s, a `408` or a `5xx` | Backs off 1 s, 2 s, 4 s, ... (at most 30 s), re-`HEAD`s and retries. `--retries` consecutive failures on one file (or on register / commit) give up; run the push again to resume from the last whole chunk. |
| `409` on a `PUT` | Re-`HEAD`s and carries on from the server's offset. If the offset did not move, the file is **busy**: the server still holds its lock for another upload -- usually this push's own chunk, cut off by a dropped connection (a laptop asleep, a Wi-Fi switch) that `orator-file-service` keeps locked until Node's `requestTimeout` ends the dead request (300 s, checked every 30 s). A busy file is not a failure: the client keeps waiting for it (the same backoff, then a fresh `HEAD`) for up to 6 minutes (`BusyWaitMS`) without spending `--retries`, then gives up; running the push again resumes. |
| A chunk that took more than 120 s | Halves the chunk size for the rest of the push, never below 8 MiB (or `--chunk-mib` when smaller): 32 MiB at 2 Mbit/s takes ~134 s, and Node's default `requestTimeout` cuts a request off at 300 s. |
| Any other `4xx` | Fails at once with the server's `Error` (`413`: try a smaller `--chunk-mib`). |
| `HEAD` reports more bytes than the file has | Left by an interrupted push of a *different* encode with the same PackageVersion (a re-encode with the same inputs gets the same PackageVersion, not the same bytes). The upload route cannot shrink a file, so the client leaves it, sends the rest and commits; the commit's `409 Mismatched` empties it and it is sent again from 0. If it is still too long after that, the push fails. |
| `HEAD` answered `409` | The version is no longer open for upload: another push committed it, or a re-encode's register replaced it. The client stops uploading and commits: an already-live version ends in success, a replaced one fails with the server's `Error` (taken from the `PUT`'s `409` when the `HEAD`, which has no body, carries none). |
| Commit `409` with `Missing` / `Mismatched` | Re-sends those files (from the server's offset; a mismatched file is back at 0) and commits again. Each file is re-sent at most once per push: a commit naming one a second time fails. |
| Commit `409` naming no files | Reads the asset's status (`GET <prefix>/<AssetGUID>`, step 4): success only when the asset's live `PackageVersion` is this one and its `State` is `ready`. Another live version, no status route or no answer fails the push with the commit's `Error` -- never a guess. |
| Register says `ready` with nothing missing | Still commits (it may be a fully staged re-encode of a live asset, not the live version itself); the commit's answer decides, as above. |
| A server that names a file outside the package's `Files[]` | Refused: the client only ever reads files the package lists. |
| Cancel (Ctrl-C) | Drops the in-flight request; the server keeps every whole chunk. |

The client uses Node's `http` / `https` only (no `fetch`, no dependencies), one keep-alive connection at a time, a
120 s socket-idle timeout per request and 30 minutes for the commit (the server hashes every byte before it answers).
Behind a reverse proxy, allow a request body of at least the chunk size plus headers (nginx `client_max_body_size
33m`), body and upstream timeouts of at least 300 s, and a read timeout long enough for the commit to hash the package.

## Programmatic use

```javascript
const libRetoldMediaLadder = require('retold-media-ladder');

// With a Fable:
pFable.addAndInstantiateServiceType('RetoldMediaLadder', libRetoldMediaLadder);
let tmpLadder = pFable.RetoldMediaLadder;

// ...or standalone:
// let tmpLadder = new libRetoldMediaLadder({ FFmpegPath: '/opt/homebrew/bin/ffmpeg' });

let tmpHandle = tmpLadder.encode('/footage/DJI_0001.MP4',
	{
		OutputDirectory: '/packages',
		Preset: 'medium',            // or Fast: true (macOS only)
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
| `push(pPackageDirectory, pOptions, fCallback)` | `Publisher.publish` (below): returns `{ cancel(), abort() }`. |
| `encode(pInputPath, pOptions, fCallback)` | Returns `{ cancel(), abort() }`. Options: `OutputDirectory` (required), `Preset`, `Fast` (macOS only: refused elsewhere, before probing), `Profile` (`'standard'` / `'hq'`), `SlowMotion`, `Lut`, `Download` (default true), `Hwaccel` (default true on macOS), `SegmentSeconds`, `CRF`, `Force` (rebuild a damaged package; never an intact one), `onProgress({ Phase, Percent, Message })` (nothing is reported after `cancel()` or `abort()`). Phases: `probe`, `hash`, `plan`, `verify` (an existing package), `encode`, `poster`, `download`, `sanitise`, `package`, `done`. Errors may carry `.Cancelled`, `.InProgress` (another live encode holds `<PV>.lock`) or `.PackageExists` (`Force` on an intact package). |

The macOS-only parts (`Hwaccel` on by default, `Fast` allowed) follow a ladder's `platform` property, which is
`process.platform` unless you set it.

### Services

Each is a `fable-serviceproviderbase` service (construct with a Fable, or with just an options object), exported on
the main module and available on a ladder instance under the same name. Callbacks are `fCallback(pError, pResult)`,
and every asynchronous method returns a handle whose `cancel(pImmediate)` stops it (the callback then gets an Error
with `.Cancelled = true`; `pImmediate` means SIGKILL rather than SIGTERM).

| Service | Job | Pure helpers |
|---|---|---|
| `MediaProbe` | `probe(pPath, fCb)` / `probeRaw(pPath, fCb)`: full ffprobe JSON condensed to `{ DurationSeconds, HasVideo, HasAudio, AudioStreamCount, DataStreamCount, Video: { Width, Height, Rotation, DisplayWidth, DisplayHeight, FrameRate, FrameRateValue, PixelFormat, BitDepth, ColorTransfer, ColorPrimaries, ColorSpace, ColorRange, Transfer ('sdr'/'hlg'/'pq'), IsHDR }, Audio, Raw }`. | `summarize(pRaw)`, `normalizeRotation`, `streamRotation`, `streamBitDepth`, `classifyTransfer` |
| `LadderPlanner` | `plan(pSummary, pOptions)` → the plan; `buildEncodeArguments(pPlan, pInput)`. | `planLadder`, `fastUnavailableReason(pPlatform)` (null on macOS, else why `Fast` is refused), `buildFilterGraph`, `buildPictureChain`, `buildVarStreamMap`, `buildEncodeArguments`, `toneMapChain`, `lutChain`, `evenScaledLongSide`, `chooseFirstVariantIndex`, `formatCommandLine` |
| `EncodeRunner` | `run(pArgs, { Cwd, DurationSeconds, onProgress, KillTimeoutMS }, fCb)` → `{ cancel(pImmediate), Process }` (async spawn, `-progress pipe:1`); `packagePaths` (`{ PackageDirectory, PartialDirectory, LockFile }`), `claimLock`, `releaseLock`, `preparePartial` (claims the lock first), `commitPartial(pOut, pPV, pReplaceDamaged)`, `discardPartial` (releases the lock). | `parseProgressChunk`, `progressSeconds`, `progressPercent`, `readLockOwner`, `lockOwnerIsLive` |
| `PosterBuilder` | `build(pPlan, pInput, pOutput, fCb)` | `buildPosterArguments` |
| `DownloadBuilder` | `build(pTopMedia, pOutput, fCb)` | `buildDownloadArguments` |
| `Sanitiser` | `checkFiles(pDirectory, pRelativePaths, fCb)` → `{ Passed, Violations: [{ File, Where, Key, Value, Reason }], Checked }` | `inspectProbe`, `inspectJpeg`, `inspectPlaylist`, `describeViolations` |
| `Publisher` | `publish(pPackageDirectory, pOptions, fCb)` → `{ cancel(), abort() }`, the push client (see **Push protocol**). Options: `Server`, `Token` (required), `Prefix`, `Source` (an original's path to hash and probe, or a ready `{ Name, Sha256, Transfer, CaptureDate }`), `Title`, `Description`, `Sensitivity`, `ChunkBytes` (32 MiB), `MinChunkBytes` (8 MiB), `Retries` (5), `BackoffMS` (1000), `MaxBackoffMS` (30000), `SlowChunkMS` (120000), `SocketTimeoutMS` (120000), `CommitTimeoutMS` (1800000), `BusyWaitMS` (360000: how long a busy file -- a `PUT` `409` at the offset `HEAD` reports -- is waited for before the push gives up; `0` gives up at once), `onProgress({ Phase, Path?, Done, Total, Percent, Message })` with phases `verify`, `source`, `register`, `upload` (bytes), `commit`, `done`. Result `{ AssetGUID, PackageVersion, State, UploadedFiles, UploadedBytes, TotalBytes, Source }`. Errors may carry `.Cancelled`, `.Refused` (not a committed `<PV>/`), `.Damaged` + `.Problems`, `.StatusCode` + `.ServerError` (+ `.Errors`), `.Retryable` (gave up; a re-run resumes), `.Oversize` + `.ServerOffset` (the server still held more bytes of a file than it has after the commit should have emptied it), `.LivePackageVersion` (a commit `409` for a version that is not the asset's live one). Constructed with options, `Server` / `Token` / `Prefix` / the tuning keys become per-call defaults. Also `probeSource(pPath, fCb)` → `{ Name, Sha256, Transfer, CaptureDate? }`. | `parseServerURL`, `normalizePrefix`, `encodeUploadPath`, `backoffDelay`, `shrinkChunk`, `isRetryableStatus`, `checkPackageDirectoryName`, `captureDateFromProbe`, `sourceFromProbe`, `normalizeSourceBlock`, `commitRetryPaths`, `parseOffsetHeader`, `printableServerText` |
| `PackageWriter` | `computePackageVersion(pPlan, pFfmpegVersion, pSourceSha256)`, `reorderMasterFile(pDir, pPlan)` (rebuilds a master missing variants), `measureRungs(pDir, pPlan)`, `verifyPackage(pDir, pPackageVersion, fCb)` → `{ Intact, Problems, Document }`, `hashFiles(pDir, pPaths, fCb)`, `selectPackageFiles(pDir, pPlan)` → the planned files present (a missing one throws, except `poster.jpg`; anything else in the directory is left out, with a warning), `write(pDir, { Plan, PackageVersion, Variants?, FilePaths? }, fCb)` (`FilePaths`: what `selectPackageFiles` returned; selected when absent) | `parseMasterPlaylist`, `reorderMaster`, `parseMediaPlaylist`, `parseByteRange`, `measureBandwidth`, `codecsFromInit`, `buildMasterPlaylist`, `planFingerprint`, `computePackageVersion`, `buildPackageDocument`, `plannedPackageFiles(pPlan)` (the allowlist: `master.m3u8`, each rung's playlist and media, `poster.jpg`, `download.mp4` unless skipped), `listPackageFiles` (everything on disk, strays included) |

## Tests

```bash
npm test
```

Pure planner / package / sanitiser tests run from ffprobe fixtures. The integration suite synthesises tiny sources
with ffmpeg lavfi (landscape with audio, native and rotation-tagged portrait, no audio, 10-bit HLG, 100 fps, a 0.3 s
clip, a clip whose video ends long before its audio (so it gets no poster), and a clip carrying location /
creation_time / Apple tags), encodes each with `--preset ultrafast`, and checks the
on-disk contract: every file in `package.json` exists with matching `Bytes` / `Sha256`, the master starts on the
≤540 rung, every rung is a single_file fMP4 byte-range playlist with `EXT-X-MAP` → `media.mp4` (no `index.m4s`),
ffprobe of every output passes the sanitise gate, a portrait top rung is short-side wide, and tone-mapped output is
8-bit BT.709. Lifecycle tests cover reuse after verification, `--force` refusing an intact package and rebuilding a
damaged one, two concurrent encodes of one package, and cancel / abort in each phase (including the CLI's second
Ctrl-C). It skips loudly when ffmpeg is not installed.

The push tests run `Publisher` and `media-ladder push` against an in-test fake server
([`test/support/Fake-Media-Ingest-Server.js`](https://github.com/fable-retold/retold-media-ladder/blob/main/test/support/Fake-Media-Ingest-Server.js),
the server side of the push protocol) with injected
faults: a connection dropped mid-chunk, a chunk stored but its answer lost, a wrong offset and a busy file (`409`), a
`500`, a `413`, a slow chunk, an idle socket, a commit that finds a mismatched or a missing file, and a register that
names a file outside the package. They prove resume from the last whole chunk, the retry limit and backoff, chunk
halving to its floor, cancel / abort (and the CLI's interrupt, exit 130), idempotent re-pushes, a re-encode of the same
source replacing the live version, a staged file longer than the package's (left by another encode with the same
PackageVersion) emptied by the commit and re-sent, a version committed or replaced under a running push (success, or
the server's reason), a commit `409` that names no files settled by the status route (never a guessed success), a busy
file waited out past `--retries` until the server frees its lock (and given up after `BusyWaitMS`), the refusals
(`<PV>.partial`, `<PV>.lock`, a damaged package: exit 1; bad flags: exit 2), hostile server text made printable, and
that the token never appears in output. One suite pushes a real lavfi-encoded package with `--source`, checking the
sha256, transfer and `creation_time` capture date that reach the server.

## License

MIT
