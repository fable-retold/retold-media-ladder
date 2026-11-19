# Push protocol

A generic, resumable upload of one package: **register** it, **upload** whatever the server is missing in raw chunks,
**commit** (and, only to settle an ambiguous commit answer, read the asset's **status**). `media-ladder push` (see
[Pushing a package](push.md)) is the client; any server can implement the other side. The push tests run against a
small reference server, `test/support/Fake-Media-Ingest-Server.js` in this repository.

Every route sits under one prefix (`--prefix` / `Prefix`, default `/1.0/MediaIngest`), appended to the server URL's
own path: `--server https://host/base` puts the register route at `https://host/base/1.0/MediaIngest`. The upload
step is exactly the resumable route that [`orator-file-service`](https://github.com/fable-retold/orator-file-service)'s
`addUploadRoute` serves, so an Orator server can mount that for it. Every request carries
`Authorization: Bearer <token>` and `Accept: application/json`; every answer except `HEAD` is JSON, with
`{ "Error": "..." }` on failure. A `408` or any `5xx` means "try again": the client backs off and tries again (see
**What the client does** below).

## 1. Register

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

## 2. Upload (each missing file)

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

## 3. Commit

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

## 4. Status (optional, read-only)

```
GET <prefix>/<AssetGUID>

200 { "Asset": { "AssetGUID": "...", "State": "ready", "PackageVersion": "1a2b3c4d", "TotalBytes": 123456789, ... } }
```

A commit `409` without `Missing` / `Mismatched` means either "this version is already live" or "this version is no
longer being uploaded" (a re-encode's register took its place). The client reads the asset's status to tell them apart:
`PackageVersion` is the asset's **live** version and `State` its state (a bare asset object, without the `Asset`
wrapper, is accepted too). A server without this route still works, but such a `409` then always fails the push (it
is never taken as success).

## What the client does

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
