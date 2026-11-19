# Pushing a package

`media-ladder push` sends a finished package -- the `<out>/<PackageVersion>/` directory that
`media-ladder encode <in> --out <out>` builds (see the [Overview](README.md)) -- to a media-ingest server, resumably.

`push` needs a server that speaks the media-ingest protocol (see [Push protocol](push-protocol.md)) and a bearer token, issued
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
