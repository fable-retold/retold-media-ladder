/**
* Retold Media Ladder -- Publisher
*
* Pushes a finished package (`<out>/<PackageVersion>/`) to a server over the
* generic register / upload / commit protocol (README, "Push protocol"):
*
*   verify   -- the package must be a committed `<PV>/` that verifyPackage
*               reports Intact (a `<PV>.partial/` or `<PV>.lock` is refused)
*   source   -- optional: sha256 + ffprobe of the ORIGINAL file, for the
*               server's dedup and the owner's records (never in the package)
*   register -- POST <prefix> { Package, Title?, Description?, Sensitivity?, Source? }
*               -> { AssetGUID, PackageVersion, State, Missing: [{ Path, Bytes, ReceivedBytes }] }
*   upload   -- per missing file: HEAD for Upload-Offset, then PUT raw chunks
*               (Upload-Offset + Content-Length) from there; resumable
*   commit   -- POST <prefix>/<AssetGUID>/<PV>/Commit -> { State: 'ready' }
*   status   -- only to settle a commit 409 that names no files:
*               GET <prefix>/<AssetGUID> -> { Asset: { PackageVersion, State } }
*
* Failure handling: a network error, a socket idle for 120 s, a 408 or a 5xx
* backs off (1 s, doubling, at most 30 s), re-HEADs and retries; `Retries`
* consecutive failures on one file (or on register / commit) give up.  A 409
* on a PUT re-HEADs and carries on from the server's offset.  When the HEAD
* reports the very offset the PUT was refused at, the file is busy: the
* server still holds its lock for another upload -- usually this push's own
* chunk, cut off by a dropped connection that the server only notices at its
* request timeout (Node: 300 s, checked every 30 s).  A busy file is not a
* failure: it is waited for (the same backoff, then a fresh HEAD) for up to
* `BusyWaitMS` (6 minutes) without spending `Retries`.  A chunk that
* takes more than 120 s halves the chunk size (never below 8 MiB, or the
* starting size when that is smaller).  Any other 4xx fails at once with the
* server's `{Error}`.
*
* The server's copy can be ahead of the client's view:
*   - a HEAD reporting MORE bytes than the file has (an earlier, interrupted
*     push of a different encode with the same PackageVersion) leaves that
*     file alone; only the commit can empty it (409 `Mismatched`), and the
*     file is then sent again from 0
*   - a HEAD answered 409 (the version is no longer open for upload: another
*     push committed it, or a re-encode's register replaced it) stops the
*     uploads and goes to the commit, which is idempotent for a live version
*     and otherwise fails with the server's reason
* A commit answered 409 with `Mismatched` / `Missing` re-sends those files
* (each file at most once per push) and commits again.  A commit 409 that
* names no files is a success only when the status route reports this very
* PackageVersion live; otherwise (or without a status route) it fails.
*
* The client only ever reads files listed in the package's own `Files[]`: a
* server that names anything else is refused.  The bearer token is sent in the
* Authorization header and never logged, echoed or put in an error message.
* Text the server sends (`Error`, `Errors[]`, a state, a path it names) only
* reaches a log line or an error message through printableServerText: control
* and bidirectional characters escaped, capped at 300 characters, and the
* token redacted should a server echo it.  A JSON object where text or a
* number belongs is shown as its JSON or ignored, never converted through its
* own toString / valueOf (an answer can make those throw).
*
* Node built-ins only (http / https / fs); no fetch, no dependencies.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libFS = require('node:fs');
const libHTTP = require('node:http');
const libHTTPS = require('node:https');
const libPath = require('node:path');

const libTools = require('./Media-Ladder-Tools.js');
const libMediaProbe = require('./Media-Probe.js');
const libPackageWriter = require('./Package-Writer.js');

const MIB = 1048576;

const DEFAULT_PREFIX = '/1.0/MediaIngest';
const DEFAULT_CHUNK_BYTES = 32 * MIB;
const DEFAULT_MIN_CHUNK_BYTES = 8 * MIB;
const DEFAULT_RETRIES = 5;
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30000;
const DEFAULT_SLOW_CHUNK_MS = 120000;
const DEFAULT_SOCKET_TIMEOUT_MS = 120000;
const DEFAULT_COMMIT_TIMEOUT_MS = 30 * 60 * 1000;
// How long a busy file (another upload holds the server's lock on it) is
// waited for: Node's default requestTimeout (300 s), which ends a dead
// chunk's request and so frees its lock, the 30 s interval it is checked
// at, and a margin.
const DEFAULT_BUSY_WAIT_MS = 6 * 60 * 1000;

// Consecutive 409s for a wrong offset (or offset-less 2xx answers) on one
// file without the offset moving forward, before the push stops trusting the
// server.  A busy file's 409s are not counted: BusyWaitMS bounds those.
const MAX_CONFLICTS = 10;
// The largest JSON answer the client will hold in memory.
const MAX_RESPONSE_BYTES = 4 * MIB;
// File read size while streaming a chunk.
const READ_HIGH_WATER_MARK = 256 * 1024;

const PACKAGE_VERSION_PATTERN = /^[0-9a-f]{8}$/;
// The server mints the asset id; it goes into a URL path segment.
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.~-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// Visible ASCII only: anything else would be a header injection (and Node throws on it).
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const SENSITIVITIES = ['normal', 'conversation'];
const TRANSFERS = ['sdr', 'hlg', 'pq', 'log', ''];
// Characters a terminal acts on instead of showing: the C0 controls (ESC, BEL,
// CR, LF ...), DEL and the C1 controls, the bidirectional marks, embeddings,
// overrides and isolates (they reorder what is shown) and the Unicode line and
// paragraph separators.
const UNPRINTABLE_PATTERN = /[\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
// The most of one server-supplied string the client prints.
const MAX_SERVER_TEXT_CHARS = 300;

// Option keys a Publisher constructed with options supplies as per-call defaults.
const DEFAULTABLE_OPTIONS = ['Server', 'Token', 'Prefix', 'ChunkBytes', 'MinChunkBytes', 'Retries', 'BackoffMS', 'MaxBackoffMS',
	'SlowChunkMS', 'SocketTimeoutMS', 'CommitTimeoutMS', 'BusyWaitMS'];

/**
 * Parse and check a server URL. Pure.
 *
 * @param {string} pServer - e.g. https://media.example or http://127.0.0.1:8086/base
 * @returns {Object} { Protocol, Hostname, Port, BasePath, Origin }
 * @throws {Error} for a missing, non-http(s) or credential-carrying URL
 */
function parseServerURL(pServer)
{
	if (typeof pServer !== 'string' || pServer.trim().length < 1)
	{
		throw new Error('A server URL is required (e.g. https://media.example).');
	}
	let tmpURL;
	try
	{
		tmpURL = new URL(pServer.trim());
	}
	catch (pError)
	{
		throw new Error('The server URL is not a valid URL.');
	}
	if (tmpURL.protocol !== 'http:' && tmpURL.protocol !== 'https:')
	{
		throw new Error('The server URL must start with http:// or https://.');
	}
	if (tmpURL.username || tmpURL.password)
	{
		throw new Error('The server URL must not carry credentials; pass a token instead.');
	}
	if (tmpURL.search || tmpURL.hash)
	{
		throw new Error('The server URL must not carry a query string or fragment.');
	}
	let tmpSecure = (tmpURL.protocol === 'https:');
	return (
		{
			Protocol: tmpURL.protocol,
			Hostname: tmpURL.hostname.replace(/^\[|\]$/g, ''),
			Port: tmpURL.port ? Number(tmpURL.port) : (tmpSecure ? 443 : 80),
			BasePath: tmpURL.pathname.replace(/\/+$/, ''),
			Origin: tmpURL.origin
		});
}

/**
 * Normalise the route prefix ('/1.0/MediaIngest'): one leading slash, no
 * trailing slash, no query, no dot segments. Pure.
 *
 * @param {string} [pPrefix]
 * @returns {string}
 * @throws {Error}
 */
function normalizePrefix(pPrefix)
{
	let tmpPrefix = (typeof pPrefix === 'undefined' || pPrefix === null || pPrefix === '') ? DEFAULT_PREFIX : String(pPrefix);
	tmpPrefix = tmpPrefix.replace(/\/+$/, '');
	if (tmpPrefix.length < 2 || tmpPrefix[0] !== '/' || /[?#\s%\\]/.test(tmpPrefix))
	{
		throw new Error('The prefix must be a path such as /1.0/MediaIngest.');
	}
	let tmpSegments = tmpPrefix.slice(1).split('/');
	if (tmpSegments.some((pSegment) => pSegment.length < 1 || pSegment === '.' || pSegment === '..'))
	{
		throw new Error('The prefix must be a path such as /1.0/MediaIngest.');
	}
	return tmpPrefix;
}

/**
 * A package-relative path as URL path segments, each one percent-encoded. Pure.
 *
 * @param {string} pPath - e.g. 'v0/media.mp4'
 * @returns {string}
 */
function encodeUploadPath(pPath)
{
	return String(pPath).split('/').map((pSegment) => encodeURIComponent(pSegment)).join('/');
}

/**
 * The wait before retry number pFailures (1-based): pBaseMS doubled each time,
 * capped at pMaxMS. Pure.
 *
 * @param {number} pFailures
 * @param {number} [pBaseMS=1000]
 * @param {number} [pMaxMS=30000]
 * @returns {number}
 */
function backoffDelay(pFailures, pBaseMS, pMaxMS)
{
	let tmpBase = (typeof pBaseMS === 'number' && pBaseMS >= 0) ? pBaseMS : DEFAULT_BACKOFF_MS;
	let tmpMax = (typeof pMaxMS === 'number' && pMaxMS >= 0) ? pMaxMS : DEFAULT_MAX_BACKOFF_MS;
	let tmpExponent = Math.max(0, Math.min(30, (Number(pFailures) || 1) - 1));
	return Math.min(tmpMax, tmpBase * Math.pow(2, tmpExponent));
}

/**
 * Halve a chunk size, never below pFloorBytes. Pure.
 *
 * @param {number} pChunkBytes
 * @param {number} pFloorBytes
 * @returns {number}
 */
function shrinkChunk(pChunkBytes, pFloorBytes)
{
	return Math.max(pFloorBytes, Math.floor(pChunkBytes / 2));
}

/**
 * True for the statuses a push retries: 408 and every 5xx. Pure.
 *
 * @param {number} pStatus
 * @returns {boolean}
 */
function isRetryableStatus(pStatus)
{
	return (pStatus === 408) || (pStatus >= 500 && pStatus <= 599);
}

/**
 * Check that a path names a committed package directory: its last segment is
 * a bare 8-hex-digit PackageVersion. `<PV>.partial` (an unfinished encode) and
 * `<PV>.lock` are refused by name. Pure (no disk access).
 *
 * @param {string} pDirectory
 * @returns {Object} { Directory (absolute), PackageVersion }
 * @throws {Error} with `.Refused = true`
 */
function checkPackageDirectoryName(pDirectory)
{
	let fRefuse = (pMessage) =>
	{
		let tmpError = new Error(pMessage);
		tmpError.Refused = true;
		return tmpError;
	};
	if (typeof pDirectory !== 'string' || pDirectory.length < 1)
	{
		throw fRefuse('A package directory is required.');
	}
	let tmpDirectory = libPath.resolve(pDirectory);
	let tmpName = libPath.basename(tmpDirectory);
	let tmpPartial = /^([0-9a-f]{8})\.partial$/.exec(tmpName);
	if (tmpPartial)
	{
		throw fRefuse(`${tmpDirectory} is an unfinished encode; push the finished ${tmpPartial[1]}/ directory once the encode completes.`);
	}
	let tmpLock = /^([0-9a-f]{8})\.lock$/.exec(tmpName);
	if (tmpLock)
	{
		throw fRefuse(`${tmpDirectory} is an encode's lock file, not a package; push the finished ${tmpLock[1]}/ directory.`);
	}
	if (!PACKAGE_VERSION_PATTERN.test(tmpName))
	{
		throw fRefuse(`${tmpDirectory} is not a package directory: push <out>/<PackageVersion>/, whose name is 8 hex digits.`);
	}
	return { Directory: tmpDirectory, PackageVersion: tmpName };
}

/**
 * An ISO-8601 capture date from ffprobe JSON: the format-level `creation_time`
 * tag, else the first video stream's. Values before 1971 (an unset MP4/Unix
 * epoch) and unparseable values give null. Pure.
 *
 * @param {Object} pRaw - ffprobe `-show_format -show_streams` JSON
 * @returns {string|null}
 */
function captureDateFromProbe(pRaw)
{
	let tmpRaw = pRaw || {};
	let tmpCandidates = [];
	if (tmpRaw.format && tmpRaw.format.tags)
	{
		tmpCandidates.push(tmpRaw.format.tags.creation_time);
	}
	(Array.isArray(tmpRaw.streams) ? tmpRaw.streams : []).forEach((pStream) =>
		{
			if (pStream && pStream.codec_type === 'video' && pStream.tags)
			{
				tmpCandidates.push(pStream.tags.creation_time);
			}
		});
	for (let i = 0; i < tmpCandidates.length; i++)
	{
		if (typeof tmpCandidates[i] !== 'string' || tmpCandidates[i].trim().length < 1)
		{
			continue;
		}
		let tmpTime = Date.parse(tmpCandidates[i].trim());
		if (isFinite(tmpTime) && new Date(tmpTime).getUTCFullYear() >= 1971)
		{
			return new Date(tmpTime).toISOString();
		}
	}
	return null;
}

/**
 * The register Source block for an original file. Pure.
 *
 * @param {string} pName - the original's base name
 * @param {string} pSha256 - its sha256 (hex)
 * @param {Object} pSummary - MediaProbe summary (Raw included)
 * @returns {Object} { Name, Sha256, Transfer, CaptureDate? }
 */
function sourceFromProbe(pName, pSha256, pSummary)
{
	let tmpSummary = pSummary || {};
	let tmpSource =
	{
		Name: String(pName || ''),
		Sha256: pSha256,
		Transfer: (tmpSummary.Video && tmpSummary.Video.Transfer) ? tmpSummary.Video.Transfer : ''
	};
	let tmpCaptureDate = captureDateFromProbe(tmpSummary.Raw);
	if (tmpCaptureDate)
	{
		tmpSource.CaptureDate = tmpCaptureDate;
	}
	return tmpSource;
}

/**
 * Check a caller-supplied Source block, keeping only the protocol's fields. Pure.
 *
 * @param {Object} pSource - { Name?, Sha256?, Transfer?, CaptureDate? }
 * @returns {Object}
 * @throws {Error}
 */
function normalizeSourceBlock(pSource)
{
	let tmpSource = {};
	if (typeof pSource.Name !== 'undefined' && pSource.Name !== null)
	{
		tmpSource.Name = String(pSource.Name);
	}
	if (typeof pSource.Sha256 !== 'undefined' && pSource.Sha256 !== null && pSource.Sha256 !== '')
	{
		if (!SHA256_PATTERN.test(String(pSource.Sha256)))
		{
			throw new Error('Source.Sha256 must be 64 lowercase hex digits.');
		}
		tmpSource.Sha256 = String(pSource.Sha256);
	}
	if (typeof pSource.Transfer !== 'undefined' && pSource.Transfer !== null)
	{
		if (TRANSFERS.indexOf(String(pSource.Transfer)) < 0)
		{
			throw new Error(`Source.Transfer must be one of ${TRANSFERS.filter((pValue) => pValue).join(', ')} (or empty).`);
		}
		tmpSource.Transfer = String(pSource.Transfer);
	}
	if (typeof pSource.CaptureDate !== 'undefined' && pSource.CaptureDate !== null && pSource.CaptureDate !== '')
	{
		let tmpTime = Date.parse(String(pSource.CaptureDate));
		if (!isFinite(tmpTime))
		{
			throw new Error('Source.CaptureDate must be an ISO-8601 date.');
		}
		tmpSource.CaptureDate = new Date(tmpTime).toISOString();
	}
	return tmpSource;
}

/**
 * The paths a commit 409 names in `Mismatched` and `Missing` (each entry a
 * path string or `{ Path }`), de-duplicated in order. Pure.
 *
 * @param {Object} pBody
 * @returns {Array<string>}
 */
function commitRetryPaths(pBody)
{
	let tmpPaths = [];
	let fCollect = (pList) =>
	{
		(Array.isArray(pList) ? pList : []).forEach((pEntry) =>
			{
				let tmpPath = (typeof pEntry === 'string') ? pEntry : ((pEntry && typeof pEntry.Path === 'string') ? pEntry.Path : null);
				if (tmpPath && tmpPaths.indexOf(tmpPath) < 0)
				{
					tmpPaths.push(tmpPath);
				}
			});
	};
	if (pBody && typeof pBody === 'object')
	{
		fCollect(pBody.Mismatched);
		fCollect(pBody.Missing);
	}
	return tmpPaths;
}

/**
 * Parse an Upload-Offset header value: a non-negative safe integer, else null. Pure.
 *
 * @param {string|Array<string>} pValue
 * @returns {number|null}
 */
function parseOffsetHeader(pValue)
{
	let tmpValue = Array.isArray(pValue) ? pValue[0] : pValue;
	if (typeof tmpValue !== 'string' || !/^\d{1,16}$/.test(tmpValue.trim()))
	{
		return null;
	}
	let tmpNumber = Number(tmpValue.trim());
	return Number.isSafeInteger(tmpNumber) ? tmpNumber : null;
}

/**
 * Make text a server sent safe to print or to put in an error message: a
 * secret (the token, should a server echo it) is redacted first, then every
 * C0 control, DEL, C1 control, bidirectional control and line / paragraph
 * separator becomes a visible `\uXXXX` escape, and the result is cut at
 * pMaxChars characters ('...' marks the cut; a surrogate pair is never
 * split). Never throws, whatever JSON the server sent. Pure.
 *
 * @param {*} pValue - usually a string; anything else becomes text through serverValueText
 * @param {number} [pMaxChars=300]
 * @param {string} [pSecret] - replaced by '<token>' wherever it appears
 * @returns {string}
 */
function printableServerText(pValue, pMaxChars, pSecret)
{
	let tmpMaxChars = positiveInteger(pMaxChars, MAX_SERVER_TEXT_CHARS);
	let tmpText = serverValueText(pValue);
	if (typeof pSecret === 'string' && pSecret.length > 0)
	{
		tmpText = tmpText.split(pSecret).join('<token>');
		// An object shows as its JSON, which escapes a '"' or '\' in an echoed token: redact that spelling too.
		let tmpEscapedSecret = JSON.stringify(pSecret).slice(1, -1);
		if (tmpEscapedSecret !== pSecret)
		{
			tmpText = tmpText.split(tmpEscapedSecret).join('<token>');
		}
	}
	// Each code unit shows as at least one character, so nothing past the first pMaxChars + 1 can.
	tmpText = tmpText.slice(0, tmpMaxChars + 1);
	let tmpOutput = '';
	let i = 0;
	while (i < tmpText.length)
	{
		let tmpCode = tmpText.codePointAt(i);
		let tmpCharacter = String.fromCodePoint(tmpCode);
		i += tmpCharacter.length;
		let tmpPiece = UNPRINTABLE_PATTERN.test(tmpCharacter) ? `\\u${tmpCode.toString(16).padStart(4, '0')}` : tmpCharacter;
		if (tmpOutput.length + tmpPiece.length > tmpMaxChars)
		{
			return `${tmpOutput}...`;
		}
		tmpOutput += tmpPiece;
	}
	return tmpOutput;
}

/**
 * Any value a server sent, as text, without running anything it carries: a
 * string as it is, an object or array as its JSON, any other value through
 * String().  String() (or Number(), or a template literal) of a parsed JSON
 * object calls its own toString / valueOf, and an answer such as
 * {"toString":1,"valueOf":1} makes that throw; JSON.stringify never calls
 * them.  An object JSON.parse cannot make (circular, say) shows as its
 * type.  Never throws. Pure.
 *
 * @param {*} pValue
 * @returns {string}
 */
function serverValueText(pValue)
{
	if (typeof pValue === 'string')
	{
		return pValue;
	}
	if (pValue === null || (typeof pValue !== 'object' && typeof pValue !== 'function'))
	{
		return String(pValue);
	}
	try
	{
		let tmpJSON = JSON.stringify(pValue);
		if (typeof tmpJSON === 'string')
		{
			return tmpJSON;
		}
	}
	catch (pError)
	{
		// Not JSON (circular, or a BigInt inside): fall through to its type.
	}
	try
	{
		return Object.prototype.toString.call(pValue);
	}
	catch (pError)
	{
		return '[unprintable value]';
	}
}

/**
 * A number a server sent: a finite number, or a string holding one; null for
 * anything else.  Number() of a parsed JSON object would call its own
 * valueOf / toString (which can throw), so an object is never converted.
 * Pure.
 *
 * @param {*} pValue
 * @returns {number|null}
 */
function serverNumber(pValue)
{
	let tmpNumber = NaN;
	if (typeof pValue === 'number')
	{
		tmpNumber = pValue;
	}
	else if (typeof pValue === 'string' && pValue.trim() !== '')
	{
		tmpNumber = Number(pValue);
	}
	return Number.isFinite(tmpNumber) ? tmpNumber : null;
}

function formatMiB(pBytes)
{
	return `${(pBytes / MIB).toFixed(1)} MiB`;
}

function positiveInteger(pValue, pDefault)
{
	return (Number.isSafeInteger(pValue) && pValue > 0) ? pValue : pDefault;
}

function nonNegativeNumber(pValue, pDefault)
{
	return (typeof pValue === 'number' && isFinite(pValue) && pValue >= 0) ? pValue : pDefault;
}

class Publisher extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'MediaLadderPublisher';

		if (!this.log)
		{
			this.log = this.options.Log || libTools.createFallbackLog(this.options.Verbose);
		}
		this.binaries = libTools.resolveBinaries(this.options);

		let tmpChildOptions = { FFmpegPath: this.binaries.FFmpeg, FFprobePath: this.binaries.FFprobe, Log: this.log, Verbose: this.options.Verbose };
		this.MediaProbe = this.fable ? new libMediaProbe(this.fable, Object.assign({}, tmpChildOptions)) : new libMediaProbe(Object.assign({}, tmpChildOptions));
		this.PackageWriter = this.fable ? new libPackageWriter(this.fable, Object.assign({}, tmpChildOptions)) : new libPackageWriter(Object.assign({}, tmpChildOptions));
	}

	/**
	 * Hash and probe an original file into a register Source block.
	 *
	 * @param {string} pSourcePath
	 * @param {function} fCallback - (pError, { Name, Sha256, Transfer, CaptureDate? })
	 * @returns {Object} handle { cancel() }
	 */
	probeSource(pSourcePath, fCallback)
	{
		let tmpPath = libPath.resolve(String(pSourcePath || ''));
		let tmpState = { Current: null, Cancelled: false, Finished: false };
		let fFinish = (pError, pSource) =>
		{
			if (tmpState.Finished)
			{
				return;
			}
			tmpState.Finished = true;
			return fCallback(pError, pSource);
		};
		let tmpStat = null;
		try
		{
			tmpStat = libFS.statSync(tmpPath);
		}
		catch (pError)
		{
			tmpStat = null;
		}
		if (!pSourcePath || !tmpStat || !tmpStat.isFile())
		{
			setImmediate(() => fFinish(new Error(`Source file not found: ${pSourcePath}`)));
			return libTools.inertHandle();
		}
		tmpState.Current = libTools.sha256File(tmpPath, (pHashError, pDigest) =>
			{
				tmpState.Current = null;
				if (pHashError || tmpState.Cancelled)
				{
					return fFinish(tmpState.Cancelled ? libTools.cancelledError('Probing the source cancelled.') : pHashError);
				}
				tmpState.Current = this.MediaProbe.probe(tmpPath, (pProbeError, pSummary) =>
					{
						tmpState.Current = null;
						if (pProbeError || tmpState.Cancelled)
						{
							return fFinish(tmpState.Cancelled ? libTools.cancelledError('Probing the source cancelled.') : pProbeError);
						}
						return fFinish(null, sourceFromProbe(libPath.basename(tmpPath), pDigest, pSummary));
					});
			});
		return (
			{
				cancel: (pImmediate) =>
				{
					if (tmpState.Finished || tmpState.Cancelled)
					{
						return false;
					}
					tmpState.Cancelled = true;
					if (tmpState.Current && typeof tmpState.Current.cancel === 'function')
					{
						tmpState.Current.cancel(pImmediate);
					}
					return true;
				}
			});
	}

	/**
	 * Push a finished package to a server.
	 *
	 * @param {string} pPackageDirectory - a committed <out>/<PackageVersion>/
	 * @param {Object} pOptions
	 *   - Server {string}          REQUIRED: base URL (http or https; a path is kept as a base path)
	 *   - Token {string}           REQUIRED: bearer token
	 *   - Prefix {string}          route prefix (default '/1.0/MediaIngest')
	 *   - Source {string|Object}   the original's path (hashed and probed), or a ready { Name, Sha256, Transfer, CaptureDate } block
	 *   - Title, Description {string}, Sensitivity ('normal'|'conversation')
	 *   - ChunkBytes (32 MiB), MinChunkBytes (8 MiB floor for slow-chunk halving), Retries (5)
	 *   - BackoffMS (1000), MaxBackoffMS (30000), SlowChunkMS (120000), SocketTimeoutMS (120000), CommitTimeoutMS (1800000)
	 *   - BusyWaitMS (360000)       how long a busy file (a PUT 409 at the offset HEAD reports: another upload holds the
	 *                               server's lock on it) is waited for, on its own clock, before the push gives up (0: at once)
	 *   - onProgress {function}    ({ Phase, Path?, Done, Total, Percent, Message })
	 * @param {function} fCallback - (pError, { AssetGUID, PackageVersion, State, UploadedFiles, UploadedBytes, TotalBytes, Source,
	 *   Ignored?, Current? }); Ignored/Current only when the asset already existed and the server kept fields this push asked
	 *   to change (e.g. Ignored ['Sensitivity'], Current { Title, Sensitivity, ConsentState }); a warning is logged too;
	 *   a cancel yields an Error with `.Cancelled = true`; a damaged package `.Damaged` (+ `.Problems`); a refused path `.Refused`;
	 *   an HTTP failure `.StatusCode` and `.ServerError` (the server's `{Error}` text, made printable)
	 * @returns {Object} handle { cancel(), abort() } -- cancel() drops the in-flight request (the server keeps every whole chunk,
	 *   so the next push resumes) and calls back once it has stopped; abort() does the same and calls back at once
	 */
	publish(pPackageDirectory, pOptions, fCallback)
	{
		let tmpOptions = {};
		DEFAULTABLE_OPTIONS.forEach((pKey) =>
			{
				if (typeof this.options[pKey] !== 'undefined')
				{
					tmpOptions[pKey] = this.options[pKey];
				}
			});
		Object.assign(tmpOptions, pOptions || {});

		let tmpState = { Cancelled: false, Current: null, Finished: false };
		let tmpRun =
		{
			Options: tmpOptions,
			State: tmpState,
			Agent: null,
			Directory: null,
			PackageVersion: null,
			Document: null,
			FilesByPath: {},
			Source: null,
			AssetGUID: null,
			RegisteredState: null,
			FinalState: null,
			TotalBytes: null,
			UploadedFiles: [],
			UploadedBytes: 0,
			Progress: { Total: 0, DoneBase: 0, Offsets: {} },
			// Paths re-sent after a commit 409 (each at most once per push).
			Resent: {},
			// Paths left alone because the server held more bytes than the file has.
			DeferredFiles: [],
			// The error that stopped the uploads when the version closed (HEAD 409).
			UploadStopped: null
		};

		let fFinish = (pError, pResult) =>
		{
			if (tmpState.Finished)
			{
				return;
			}
			tmpState.Finished = true;
			if (tmpRun.Agent)
			{
				tmpRun.Agent.destroy();
			}
			return fCallback(pError, pResult);
		};

		let tmpHandle =
		{
			cancel: () =>
			{
				if (tmpState.Finished || tmpState.Cancelled)
				{
					return false;
				}
				tmpState.Cancelled = true;
				if (tmpState.Current && typeof tmpState.Current.cancel === 'function')
				{
					tmpState.Current.cancel();
				}
				return true;
			},
			abort: () =>
			{
				if (tmpState.Finished)
				{
					return false;
				}
				tmpState.Cancelled = true;
				if (tmpState.Current && typeof tmpState.Current.cancel === 'function')
				{
					tmpState.Current.cancel(true);
				}
				fFinish(libTools.cancelledError('Push cancelled.'));
				return true;
			}
		};

		// Option checks: synchronous, but always called back asynchronously.
		try
		{
			this._prepareRun(tmpRun, pPackageDirectory);
		}
		catch (pError)
		{
			setImmediate(() => fFinish(pError));
			return tmpHandle;
		}

		let tmpSteps =
		[
			(fNext) => this._stepVerify(tmpRun, fNext),
			(fNext) => this._stepSource(tmpRun, fNext),
			(fNext) => this._stepRegister(tmpRun, fNext),
			(fNext) => this._stepUpload(tmpRun, fNext),
			(fNext) => this._stepCommit(tmpRun, fNext)
		];

		let fRun = (pIndex) =>
		{
			if (tmpState.Cancelled)
			{
				return fFinish(libTools.cancelledError('Push cancelled.'));
			}
			if (pIndex >= tmpSteps.length)
			{
				this._progress(tmpRun, 'done', 1, 1, `Asset ${tmpRun.AssetGUID} is ${tmpRun.FinalState}`);
				return fFinish(null, Object.assign(
					{
						AssetGUID: tmpRun.AssetGUID,
						PackageVersion: tmpRun.PackageVersion,
						State: tmpRun.FinalState,
						UploadedFiles: tmpRun.UploadedFiles.length,
						UploadedBytes: tmpRun.UploadedBytes,
						TotalBytes: tmpRun.TotalBytes,
						Source: tmpRun.Source
					}, tmpRun.Ignored ? { Ignored: tmpRun.Ignored, Current: tmpRun.Current } : {}));
			}
			tmpSteps[pIndex]((pError) =>
				{
					tmpState.Current = null;
					if (tmpState.Cancelled)
					{
						return fFinish(libTools.cancelledError('Push cancelled.'));
					}
					if (pError === 'done')
					{
						return fRun(tmpSteps.length);
					}
					if (pError)
					{
						return fFinish(pError);
					}
					return fRun(pIndex + 1);
				});
		};
		setImmediate(() => fRun(0));

		return tmpHandle;
	}

	/**
	 * Check the options and the package directory's name; fill in pRun. Throws.
	 */
	_prepareRun(pRun, pPackageDirectory)
	{
		let tmpOptions = pRun.Options;
		let tmpChecked = checkPackageDirectoryName(pPackageDirectory);
		pRun.Directory = tmpChecked.Directory;
		pRun.PackageVersion = tmpChecked.PackageVersion;

		pRun.Server = parseServerURL(tmpOptions.Server);
		pRun.Prefix = normalizePrefix(tmpOptions.Prefix);
		if (typeof tmpOptions.Token !== 'string' || tmpOptions.Token.length < 1)
		{
			throw new Error('A bearer token is required.');
		}
		if (!TOKEN_PATTERN.test(tmpOptions.Token))
		{
			throw new Error('The token contains characters that cannot be sent in a header.');
		}
		if (typeof tmpOptions.Sensitivity !== 'undefined' && tmpOptions.Sensitivity !== null && SENSITIVITIES.indexOf(tmpOptions.Sensitivity) < 0)
		{
			throw new Error(`Sensitivity must be one of ${SENSITIVITIES.join(', ')}.`);
		}
		if (tmpOptions.Source && typeof tmpOptions.Source === 'object')
		{
			pRun.Source = normalizeSourceBlock(tmpOptions.Source);
		}
		else if (tmpOptions.Source && typeof tmpOptions.Source !== 'string')
		{
			throw new Error('Source must be a file path or a { Name, Sha256, Transfer, CaptureDate } object.');
		}

		pRun.ChunkBytes = positiveInteger(tmpOptions.ChunkBytes, DEFAULT_CHUNK_BYTES);
		pRun.FloorBytes = Math.min(pRun.ChunkBytes, positiveInteger(tmpOptions.MinChunkBytes, DEFAULT_MIN_CHUNK_BYTES));
		pRun.Retries = (Number.isSafeInteger(tmpOptions.Retries) && tmpOptions.Retries >= 0) ? Math.max(1, tmpOptions.Retries) : DEFAULT_RETRIES;
		pRun.BackoffMS = nonNegativeNumber(tmpOptions.BackoffMS, DEFAULT_BACKOFF_MS);
		pRun.MaxBackoffMS = nonNegativeNumber(tmpOptions.MaxBackoffMS, DEFAULT_MAX_BACKOFF_MS);
		pRun.SlowChunkMS = nonNegativeNumber(tmpOptions.SlowChunkMS, DEFAULT_SLOW_CHUNK_MS);
		pRun.SocketTimeoutMS = positiveInteger(tmpOptions.SocketTimeoutMS, DEFAULT_SOCKET_TIMEOUT_MS);
		pRun.CommitTimeoutMS = positiveInteger(tmpOptions.CommitTimeoutMS, DEFAULT_COMMIT_TIMEOUT_MS);
		pRun.BusyWaitMS = nonNegativeNumber(tmpOptions.BusyWaitMS, DEFAULT_BUSY_WAIT_MS);

		// One connection at a time.  Keep-alive lets a server that answers early
		// (a 409 before reading a chunk) drain the body instead of resetting the
		// socket under it; Node's agent retires an idle socket before the
		// server's advertised Keep-Alive timeout, and a reset on a reused socket
		// is only a retryable failure (the next HEAD re-synchronises).
		let tmpAgentLibrary = (pRun.Server.Protocol === 'https:') ? libHTTPS : libHTTP;
		pRun.Agent = new tmpAgentLibrary.Agent({ keepAlive: true, maxSockets: 1 });
	}

	_progress(pRun, pPhase, pDone, pTotal, pMessage, pPath)
	{
		if (typeof pRun.Options.onProgress !== 'function')
		{
			return;
		}
		let tmpEvent =
		{
			Phase: pPhase,
			Done: pDone,
			Total: pTotal,
			Percent: (pTotal > 0) ? libTools.roundTo(Math.min(100, (pDone / pTotal) * 100), 1) : 100,
			Message: pMessage || ''
		};
		if (pPath)
		{
			tmpEvent.Path = pPath;
		}
		try
		{
			pRun.Options.onProgress(tmpEvent);
		}
		catch (pHandlerError)
		{
			this.log.warn(`MediaLadderPublisher progress handler threw: ${pHandlerError.message}`);
		}
	}

	_uploadProgress(pRun, pPath, pInflight, pMessage)
	{
		let tmpProgress = pRun.Progress;
		let tmpDone = tmpProgress.DoneBase + (pInflight || 0);
		Object.keys(tmpProgress.Offsets).forEach((pKey) => { tmpDone += tmpProgress.Offsets[pKey]; });
		this._progress(pRun, 'upload', Math.min(tmpDone, tmpProgress.Total), tmpProgress.Total, pMessage || pPath, pPath);
	}

	// ---- Steps ----------------------------------------------------------

	_stepVerify(pRun, fNext)
	{
		let tmpStat = null;
		try
		{
			tmpStat = libFS.statSync(pRun.Directory);
		}
		catch (pError)
		{
			tmpStat = null;
		}
		if (!tmpStat || !tmpStat.isDirectory())
		{
			let tmpMissing = new Error(`Package directory not found: ${pRun.Directory}`);
			tmpMissing.Refused = true;
			return fNext(tmpMissing);
		}
		this._progress(pRun, 'verify', 0, 1, `Verifying package ${pRun.PackageVersion}`);
		pRun.State.Current = this.PackageWriter.verifyPackage(pRun.Directory, pRun.PackageVersion, (pError, pReport) =>
			{
				pRun.State.Current = null;
				if (pError)
				{
					return fNext(pError);
				}
				if (!pReport.Intact)
				{
					let tmpDamaged = new Error(`Package ${pRun.Directory} is damaged (${pReport.Problems.join('; ')}); it will not be pushed. Re-encode it (media-ladder encode --force) first.`);
					tmpDamaged.Damaged = true;
					tmpDamaged.Problems = pReport.Problems;
					return fNext(tmpDamaged);
				}
				pRun.Document = pReport.Document;
				pRun.FilesByPath = {};
				pReport.Document.Files.forEach((pFile) => { pRun.FilesByPath[pFile.Path] = pFile; });
				this._progress(pRun, 'verify', 1, 1, `Package ${pRun.PackageVersion} is intact (${pReport.Document.Files.length} files)`);
				return fNext();
			});
	}

	_stepSource(pRun, fNext)
	{
		if (typeof pRun.Options.Source !== 'string' || pRun.Options.Source.length < 1)
		{
			return fNext();
		}
		this._progress(pRun, 'source', 0, 1, `Hashing and probing ${libPath.basename(pRun.Options.Source)}`);
		pRun.State.Current = this.probeSource(pRun.Options.Source, (pError, pSource) =>
			{
				pRun.State.Current = null;
				if (pError)
				{
					return fNext(pError);
				}
				pRun.Source = pSource;
				this._progress(pRun, 'source', 1, 1, `Source ${pSource.Name}: ${pSource.Transfer || 'unknown transfer'}${pSource.CaptureDate ? `, captured ${pSource.CaptureDate}` : ''}`);
				return fNext();
			});
	}

	_stepRegister(pRun, fNext)
	{
		let tmpBody = { Package: pRun.Document };
		['Title', 'Description', 'Sensitivity'].forEach((pKey) =>
			{
				if (typeof pRun.Options[pKey] === 'string')
				{
					tmpBody[pKey] = pRun.Options[pKey];
				}
			});
		if (pRun.Source)
		{
			tmpBody.Source = pRun.Source;
		}
		this._progress(pRun, 'register', 0, 1, `Registering package ${pRun.PackageVersion} with ${pRun.Server.Origin}`);
		this._callWithRetry(pRun, { Method: 'POST', Path: this._routePath(pRun, ''), JSON: tmpBody }, 'register', (pError, pResponse) =>
			{
				if (pError)
				{
					return fNext(pError);
				}
				if (pResponse.Status < 200 || pResponse.Status > 299)
				{
					return fNext(this._httpError(pRun, 'register', pResponse));
				}
				let tmpAnswer = pResponse.JSON;
				if (!tmpAnswer || typeof tmpAnswer !== 'object')
				{
					return fNext(new Error('register: the server did not answer with JSON.'));
				}
				if (typeof tmpAnswer.AssetGUID !== 'string' || !ASSET_ID_PATTERN.test(tmpAnswer.AssetGUID) || tmpAnswer.AssetGUID === '..')
				{
					return fNext(new Error('register: the server answered without a usable AssetGUID.'));
				}
				if (tmpAnswer.PackageVersion !== pRun.PackageVersion)
				{
					return fNext(new Error(`register: the server registered PackageVersion ${this._serverQuoted(pRun, tmpAnswer.PackageVersion)}, not ${pRun.PackageVersion}.`));
				}
				if (!Array.isArray(tmpAnswer.Missing))
				{
					return fNext(new Error('register: the server answered without a Missing list.'));
				}
				let tmpFiles;
				try
				{
					tmpFiles = this._packageFiles(pRun, tmpAnswer.Missing, 'register');
				}
				catch (pMissingError)
				{
					return fNext(pMissingError);
				}
				pRun.AssetGUID = tmpAnswer.AssetGUID;
				pRun.RegisteredState = (typeof tmpAnswer.State === 'string') ? tmpAnswer.State : null;
				pRun.PendingFiles = tmpFiles;
				this._noteIgnored(pRun, tmpAnswer);
				let tmpBytes = tmpFiles.reduce((pSum, pFile) => pSum + pFile.Bytes, 0);
				this._progress(pRun, 'register', 1, 1, (tmpFiles.length > 0)
					? `Asset ${pRun.AssetGUID}: ${tmpFiles.length} file(s), ${formatMiB(tmpBytes)} to send`
					: `Asset ${pRun.AssetGUID}: nothing to send`);
				return fNext();
			});
	}

	/**
	 * A re-push of an existing asset never changes its Title, Description or Sensitivity (the server
	 * leaves those to an edit), and a server may say which ones it ignored:
	 * {Ignored:['Sensitivity'], Current:{Title, Sensitivity, ConsentState}}. Warn, loudly: an operator
	 * who re-pushes a recorded conversation with --sensitivity conversation must not believe it is
	 * now protected. The result carries Ignored and Current too (--json).
	 */
	_noteIgnored(pRun, pAnswer)
	{
		let tmpIgnored = Array.isArray(pAnswer.Ignored)
			? pAnswer.Ignored.filter((pField) => (typeof pField === 'string') && /^[A-Za-z]{1,40}$/.test(pField))
			: [];
		if (tmpIgnored.length < 1)
		{
			return;
		}
		let tmpCurrent = {};
		if (pAnswer.Current && typeof pAnswer.Current === 'object')
		{
			['Title', 'Sensitivity', 'ConsentState'].forEach((pKey) =>
				{
					if (typeof pAnswer.Current[pKey] === 'string')
					{
						tmpCurrent[pKey] = this._serverText(pRun, pAnswer.Current[pKey], 200);
					}
				});
		}
		pRun.Ignored = tmpIgnored;
		pRun.Current = tmpCurrent;
		let tmpNow = Object.keys(tmpCurrent).map((pKey) => `${pKey} ${JSON.stringify(tmpCurrent[pKey])}`).join(', ');
		this.log.warn(`media-ladder push: asset ${pRun.AssetGUID} already exists, so the server kept its ${tmpIgnored.join(', ')}${tmpNow ? ` (${tmpNow})` : ''}. `
			+ `A push never changes ${tmpIgnored.length === 1 ? 'it' : 'them'} on an existing asset: edit the asset instead (PATCH ${pRun.Prefix}/${pRun.AssetGUID}).`);
	}

	_stepUpload(pRun, fNext)
	{
		if (!pRun.PendingFiles || pRun.PendingFiles.length < 1)
		{
			return fNext();
		}
		return this._uploadFiles(pRun, pRun.PendingFiles, 'upload', fNext);
	}

	_stepCommit(pRun, fNext)
	{
		let fCommit = () =>
		{
			this._progress(pRun, 'commit', 0, 1, `Committing package ${pRun.PackageVersion} (the server verifies every file)`);
			this._callWithRetry(pRun, { Method: 'POST', Path: this._routePath(pRun, `/${encodeURIComponent(pRun.AssetGUID)}/${pRun.PackageVersion}/Commit`), Empty: true, TimeoutMS: pRun.CommitTimeoutMS }, 'commit', (pError, pResponse) =>
				{
					if (pError)
					{
						return fNext(pError);
					}
					let tmpAnswer = (pResponse.JSON && typeof pResponse.JSON === 'object') ? pResponse.JSON : {};
					if (pResponse.Status >= 200 && pResponse.Status <= 299)
					{
						pRun.FinalState = (typeof tmpAnswer.State === 'string' && tmpAnswer.State) ? this._serverText(pRun, tmpAnswer.State) : 'ready';
						this._takeTotalBytes(pRun, tmpAnswer.TotalBytes);
						this._progress(pRun, 'commit', 1, 1, `Package ${pRun.PackageVersion} is ${pRun.FinalState}`);
						return fNext();
					}
					let tmpCommitError = this._httpError(pRun, 'commit', pResponse);
					if (pResponse.Status !== 409)
					{
						return fNext(tmpCommitError);
					}
					let tmpRetryPaths = commitRetryPaths(tmpAnswer);
					if (tmpRetryPaths.length < 1)
					{
						// No files named: the version is already live (a server may answer a repeated
						// commit 409 rather than 200), or it is no longer being uploaded at all.  Only
						// the server's own status can tell which.
						return this._confirmLive(pRun, tmpCommitError, fNext);
					}
					let tmpAgain = tmpRetryPaths.filter((pPath) => pRun.Resent[pPath]);
					if (tmpAgain.length > 0)
					{
						tmpCommitError.message += ` (${tmpAgain.join(', ')} ${(tmpAgain.length === 1) ? 'was' : 'were'} already sent again once.)`;
						return fNext(tmpCommitError);
					}
					let tmpFiles;
					try
					{
						tmpFiles = this._packageFiles(pRun, tmpRetryPaths, 'commit');
					}
					catch (pMissingError)
					{
						return fNext(pMissingError);
					}
					tmpRetryPaths.forEach((pPath) => { pRun.Resent[pPath] = true; });
					this.log.warn(`media-ladder push: the server could not verify ${tmpRetryPaths.join(', ')} at commit; sending ${(tmpRetryPaths.length === 1) ? 'it' : 'them'} again.`);
					return this._uploadFiles(pRun, tmpFiles, 'resend', (pUploadError) =>
						{
							if (pUploadError)
							{
								return fNext(pUploadError);
							}
							return fCommit();
						});
				});
		};
		fCommit();
	}

	/**
	 * Settle a commit 409 that names no files: ask the server which version of
	 * the asset is live (`GET <prefix>/<AssetGUID>`, read-only).  Success only
	 * when it is this PackageVersion and ready; anything else -- another
	 * version, no status route, no answer -- fails with the commit's error.
	 */
	_confirmLive(pRun, pCommitError, fNext)
	{
		this._progress(pRun, 'commit', 0, 1, `The server refused the commit; checking whether package ${pRun.PackageVersion} is already live`);
		this._callWithRetry(pRun, { Method: 'GET', Path: this._routePath(pRun, `/${encodeURIComponent(pRun.AssetGUID)}`) }, 'status', (pError, pResponse) =>
			{
				if (pError && pError.Cancelled)
				{
					return fNext(pError);
				}
				let tmpAsset = null;
				if (!pError && pResponse.Status >= 200 && pResponse.Status <= 299 && pResponse.JSON && typeof pResponse.JSON === 'object')
				{
					tmpAsset = (pResponse.JSON.Asset && typeof pResponse.JSON.Asset === 'object') ? pResponse.JSON.Asset : pResponse.JSON;
				}
				if (tmpAsset && tmpAsset.PackageVersion === pRun.PackageVersion && tmpAsset.State === 'ready')
				{
					pRun.FinalState = 'ready';
					this._takeTotalBytes(pRun, tmpAsset.TotalBytes);
					this._progress(pRun, 'commit', 1, 1, `Package ${pRun.PackageVersion} was already committed`);
					return fNext();
				}
				if (tmpAsset && typeof tmpAsset.PackageVersion === 'string' && PACKAGE_VERSION_PATTERN.test(tmpAsset.PackageVersion))
				{
					pCommitError.LivePackageVersion = tmpAsset.PackageVersion;
					pCommitError.message += ` The asset's live version is ${tmpAsset.PackageVersion}, not ${pRun.PackageVersion}.`;
				}
				else if (tmpAsset)
				{
					// _serverQuoted, never String() or JSON.stringify: a State that is a JSON object must neither run its own toString nor overflow the stack.
					pCommitError.message += ` The asset has no live version yet (state ${this._serverQuoted(pRun, tmpAsset.State || '')}).`;
				}
				else
				{
					pCommitError.message += ' Could not confirm that this version is live (the server offers no asset status), so the push did not succeed.';
				}
				return fNext(pCommitError);
			});
	}

	/**
	 * Take the server's TotalBytes when it is a number (or a string holding
	 * one); anything else -- absent, or an object -- leaves it unknown.
	 */
	_takeTotalBytes(pRun, pValue)
	{
		let tmpTotalBytes = serverNumber(pValue);
		if (tmpTotalBytes !== null)
		{
			pRun.TotalBytes = tmpTotalBytes;
		}
	}

	// ---- Upload ---------------------------------------------------------

	/**
	 * Map server-named paths (strings or { Path, Bytes }) onto the package's
	 * own Files[]. Anything not in the package is refused: the client never
	 * reads a file the package does not list. Throws.
	 */
	_packageFiles(pRun, pEntries, pLabel)
	{
		let tmpSeen = {};
		let tmpFiles = [];
		pEntries.forEach((pEntry) =>
			{
				let tmpPath = (typeof pEntry === 'string') ? pEntry : ((pEntry && typeof pEntry.Path === 'string') ? pEntry.Path : null);
				let tmpFile = (tmpPath !== null && Object.prototype.hasOwnProperty.call(pRun.FilesByPath, tmpPath)) ? pRun.FilesByPath[tmpPath] : null;
				if (!tmpFile)
				{
					throw new Error(`${pLabel}: the server asked for ${this._serverQuoted(pRun, tmpPath)}, which is not a file in this package; refusing to send it.`);
				}
				// serverNumber, never Number(): a Bytes that is a JSON object must not run its own valueOf.
				if (pEntry && typeof pEntry === 'object' && typeof pEntry.Bytes !== 'undefined' && serverNumber(pEntry.Bytes) !== tmpFile.Bytes)
				{
					throw new Error(`${pLabel}: the server expects ${tmpPath} to be ${this._serverText(pRun, pEntry.Bytes)} bytes, but the package has ${tmpFile.Bytes}.`);
				}
				if (tmpSeen[tmpPath])
				{
					return;
				}
				tmpSeen[tmpPath] = true;
				tmpFiles.push({ Path: tmpPath, Bytes: tmpFile.Bytes, Absolute: libPath.join(pRun.Directory, tmpPath) });
			});
		return tmpFiles;
	}

	/**
	 * Send files one at a time.  pPass is 'upload' (the register's Missing
	 * list) or 'resend' (files a commit 409 named).
	 *   - a file the server holds MORE of than it has (`.Oversize`): on the
	 *     upload pass it is left for the commit to empty (409 Mismatched) and
	 *     sent again then; on the resend pass the commit should already have
	 *     emptied it, so the push stops
	 *   - the version closing (`.VersionClosed`, a HEAD 409): the uploads stop
	 *     and the commit decides
	 */
	_uploadFiles(pRun, pFiles, pPass, fCallback)
	{
		let tmpQueue = pFiles.slice();
		pRun.Progress.Total += pFiles.reduce((pSum, pFile) => pSum + pFile.Bytes, 0);
		let fNext = () =>
		{
			if (pRun.State.Cancelled)
			{
				return fCallback(libTools.cancelledError('Push cancelled.'));
			}
			if (tmpQueue.length < 1)
			{
				return fCallback();
			}
			let tmpFile = tmpQueue.shift();
			pRun.Progress.Offsets[tmpFile.Path] = 0;
			this._uploadFile(pRun, tmpFile, (pError) =>
				{
					delete pRun.Progress.Offsets[tmpFile.Path];
					if (pError && pError.Oversize)
					{
						if (pPass !== 'upload')
						{
							pError.message += ' The commit named it to be sent again, but even after the commit the server has not emptied it; stopping.';
							return fCallback(pError);
						}
						pRun.Progress.Total -= tmpFile.Bytes;
						pRun.DeferredFiles.push(tmpFile.Path);
						this.log.warn(`media-ladder push: ${pError.message} It is left from an earlier push of a different encode with the same PackageVersion; the commit will have the server discard it, and it is sent again then.`);
						return fNext();
					}
					if (pError && pError.VersionClosed)
					{
						pRun.UploadStopped = pError;
						this.log.warn(`media-ladder push: ${pError.message} The server no longer takes uploads for package ${pRun.PackageVersion}; committing to find out whether it is already live.`);
						return fCallback();
					}
					if (pError)
					{
						return fCallback(pError);
					}
					pRun.Progress.DoneBase += tmpFile.Bytes;
					this._uploadProgress(pRun, tmpFile.Path, 0, `${tmpFile.Path} sent`);
					return fNext();
				});
		};
		fNext();
	}

	/**
	 * HEAD for the server's offset, then PUT chunks until the file is whole.
	 *
	 * A PUT answered 409 sends the client back to HEAD.  A different offset
	 * there means the client's was wrong: carry on from the server's (a
	 * conflict).  The SAME offset means the file is busy: another upload holds
	 * the server's lock on it -- usually this push's own earlier chunk, cut off
	 * by a half-open connection (a laptop asleep, a Wi-Fi switch) that the
	 * server has not noticed yet; orator-file-service keeps the lock until
	 * Node's requestTimeout (300 s) ends the dead request.  A busy file is
	 * waited for on a clock of its own (BusyWaitMS), never on Retries or
	 * MAX_CONFLICTS.
	 */
	_uploadFile(pRun, pFile, fCallback)
	{
		let tmpPath = this._routePath(pRun, `/${encodeURIComponent(pRun.AssetGUID)}/${pRun.PackageVersion}/File/${encodeUploadPath(pFile.Path)}`);
		// ConflictReason: the server's Error on the PUT 409 that sent the client back to HEAD
		// (a HEAD answer has no body to carry one), made printable.
		// BusySince / BusyTries: when the current wait for a busy file began, and how many
		// waits it has had; both cleared once a PUT gets any answer but a 409 (or none), or a
		// 409 turns out to be a wrong offset.
		let tmpFile = { Offset: 0, Failures: 0, Conflicts: 0, Sent: false, ConflictAt: null, ConflictReason: null, BusySince: null, BusyTries: 0 };
		let fHead;
		let fChunk;

		let fCancelled = () => fCallback(libTools.cancelledError('Push cancelled.'));

		// A retryable failure: back off, re-HEAD, try again -- or give up.
		let fFailure = (pReason) =>
		{
			tmpFile.Failures++;
			if (tmpFile.Failures >= pRun.Retries)
			{
				let tmpGiveUp = new Error(`Gave up sending ${pFile.Path} after ${tmpFile.Failures} consecutive failed attempts (the last: ${pReason}). Run the push again to resume from the last whole chunk.`);
				tmpGiveUp.Retryable = true;
				return fCallback(tmpGiveUp);
			}
			let tmpDelay = backoffDelay(tmpFile.Failures, pRun.BackoffMS, pRun.MaxBackoffMS);
			this.log.warn(`media-ladder push: ${pFile.Path}: ${pReason}; retrying in ${(tmpDelay / 1000).toFixed(1)} s (attempt ${tmpFile.Failures + 1} of ${pRun.Retries}).`);
			return this._wait(pRun, tmpDelay, (pWaitError) => (pWaitError ? fCallback(pWaitError) : fHead()));
		};

		// One more answer that did not move the offset forward: give up after too many, else fThen.
		let fConflict = (pReason, fThen) =>
		{
			tmpFile.Conflicts++;
			if (tmpFile.Conflicts > MAX_CONFLICTS)
			{
				return fCallback(new Error(`Gave up sending ${pFile.Path}: the server's offset did not move after ${MAX_CONFLICTS} tries (${pReason}).`));
			}
			return fThen();
		};

		// The current wait for a busy file is over: the next busy answer starts a new one.
		let fNotBusy = () =>
		{
			tmpFile.BusySince = null;
			tmpFile.BusyTries = 0;
		};

		// A busy file: not a failure, so Retries is untouched.  Back off, re-HEAD and try again
		// until BusyWaitMS has passed since the first busy answer -- long enough for the server
		// to end a dead chunk's request and free its lock -- then give up (a re-run resumes).
		let fBusy = (pReason) =>
		{
			let tmpNow = Date.now();
			if (tmpFile.BusySince === null)
			{
				tmpFile.BusySince = tmpNow;
			}
			let tmpWaited = tmpNow - tmpFile.BusySince;
			if (tmpWaited >= pRun.BusyWaitMS)
			{
				let tmpGiveUp = new Error(`Gave up sending ${pFile.Path}: for ${(tmpWaited / 1000).toFixed(1)} s the server has answered that another upload to this file is in progress${pReason ? ` (${pReason})` : ''}. `
					+ 'An interrupted chunk\'s lock on the server clears within about 5 minutes; run the push again to resume from the last whole chunk.');
				tmpGiveUp.Retryable = true;
				return fCallback(tmpGiveUp);
			}
			tmpFile.BusyTries++;
			let tmpDelay = Math.min(backoffDelay(tmpFile.BusyTries, pRun.BackoffMS, pRun.MaxBackoffMS), pRun.BusyWaitMS - tmpWaited);
			this.log.warn(`media-ladder push: ${pFile.Path}: the server reports another upload to this file in progress (often this push's own chunk, cut off by a dropped connection); `
				+ `waiting for the server to release the file, asking again in ${(tmpDelay / 1000).toFixed(1)} s (waited ${(tmpWaited / 1000).toFixed(1)} s of up to ${(pRun.BusyWaitMS / 1000).toFixed(0)} s).`);
			this._uploadProgress(pRun, pFile.Path, 0, `Waiting for the server to release ${pFile.Path}`);
			return this._wait(pRun, tmpDelay, (pWaitError) => (pWaitError ? fCallback(pWaitError) : fHead()));
		};

		fHead = () =>
		{
			pRun.State.Current = this._request(pRun, { Method: 'HEAD', Path: tmpPath }, (pError, pResponse) =>
				{
					pRun.State.Current = null;
					if (pRun.State.Cancelled)
					{
						return fCancelled();
					}
					if (pError)
					{
						return pError.Network ? fFailure(pError.message) : fCallback(pError);
					}
					if (isRetryableStatus(pResponse.Status))
					{
						return fFailure(`HEAD answered ${pResponse.Status}`);
					}
					let tmpConflictReason = tmpFile.ConflictReason;
					tmpFile.ConflictReason = null;
					if (pResponse.Status === 409)
					{
						// The version is not open for upload any more: committed by another push,
						// or replaced by a re-encode's register.  The commit decides which.
						let tmpClosed = this._httpError(pRun, `HEAD ${pFile.Path}`, pResponse);
						if (!tmpClosed.ServerError)
						{
							tmpClosed.ServerError = tmpConflictReason;
							tmpClosed.message = `HEAD ${pFile.Path}: the server answered 409: ${tmpConflictReason || 'this package version is not open for upload.'}`;
						}
						tmpClosed.VersionClosed = true;
						return fCallback(tmpClosed);
					}
					if (pResponse.Status < 200 || pResponse.Status > 299)
					{
						return fCallback(this._httpError(pRun, `HEAD ${pFile.Path}`, pResponse));
					}
					let tmpOffset = parseOffsetHeader(pResponse.Headers['upload-offset']);
					if (tmpOffset === null)
					{
						return fCallback(new Error(`HEAD ${pFile.Path}: the server did not report an Upload-Offset.`));
					}
					if (tmpOffset > pFile.Bytes)
					{
						let tmpOversize = new Error(`HEAD ${pFile.Path}: the server holds ${tmpOffset} bytes of a ${pFile.Bytes}-byte file.`);
						tmpOversize.Oversize = true;
						tmpOversize.ServerOffset = tmpOffset;
						return fCallback(tmpOversize);
					}
					let tmpConflictAt = tmpFile.ConflictAt;
					tmpFile.ConflictAt = null;
					tmpFile.Offset = tmpOffset;
					pRun.Progress.Offsets[pFile.Path] = tmpOffset;
					if (tmpConflictAt === null)
					{
						return fChunk();
					}
					if (tmpOffset === tmpConflictAt)
					{
						// A 409 although the offset was right: another upload to this
						// file holds the server's lock.  Wait for it to let go.
						return fBusy(tmpConflictReason);
					}
					// A 409 for a wrong offset: carry on from the server's.
					fNotBusy();
					return fConflict(`409 at offset ${tmpConflictAt}${tmpConflictReason ? ` (${tmpConflictReason})` : ''}`, fChunk);
				});
		};

		fChunk = () =>
		{
			if (pRun.State.Cancelled)
			{
				return fCancelled();
			}
			if (tmpFile.Offset >= pFile.Bytes && (pFile.Bytes > 0 || tmpFile.Sent))
			{
				if (tmpFile.Sent && pRun.UploadedFiles.indexOf(pFile.Path) < 0)
				{
					pRun.UploadedFiles.push(pFile.Path);
				}
				return fCallback();
			}
			let tmpStart = tmpFile.Offset;
			let tmpLength = Math.min(pRun.ChunkBytes, pFile.Bytes - tmpStart);
			let tmpStarted = Date.now();
			pRun.State.Current = this._request(pRun,
				{
					Method: 'PUT',
					Path: tmpPath,
					File: { Absolute: pFile.Absolute, Start: tmpStart, Length: tmpLength },
					onSent: (pBytes) => { this._uploadProgress(pRun, pFile.Path, pBytes); }
				},
				(pError, pResponse) =>
				{
					pRun.State.Current = null;
					let tmpElapsed = Date.now() - tmpStarted;
					if (tmpElapsed > pRun.SlowChunkMS && pRun.ChunkBytes > pRun.FloorBytes && !pRun.State.Cancelled)
					{
						let tmpWas = pRun.ChunkBytes;
						pRun.ChunkBytes = shrinkChunk(pRun.ChunkBytes, pRun.FloorBytes);
						this.log.warn(`media-ladder push: a ${formatMiB(tmpLength)} chunk took ${(tmpElapsed / 1000).toFixed(1)} s; chunks drop from ${formatMiB(tmpWas)} to ${formatMiB(pRun.ChunkBytes)}.`);
					}
					if (pRun.State.Cancelled)
					{
						return fCancelled();
					}
					if (pError || pResponse.Status !== 409)
					{
						// Any answer but a 409 (or none at all) ends a wait for a busy file.
						fNotBusy();
					}
					if (pError)
					{
						return pError.Network ? fFailure(pError.message) : fCallback(pError);
					}
					if (pResponse.Status === 409)
					{
						tmpFile.ConflictAt = tmpStart;
						tmpFile.ConflictReason = (pResponse.JSON && typeof pResponse.JSON.Error === 'string') ? this._serverText(pRun, pResponse.JSON.Error) : null;
						// Only a fresh HEAD tells a wrong offset (a conflict) from a busy file.
						return fHead();
					}
					if (isRetryableStatus(pResponse.Status))
					{
						return fFailure(`PUT answered ${pResponse.Status}`);
					}
					if (pResponse.Status < 200 || pResponse.Status > 299)
					{
						let tmpHTTPError = this._httpError(pRun, `PUT ${pFile.Path}`, pResponse);
						if (pResponse.Status === 413)
						{
							tmpHTTPError.message += ` The server (or a proxy in front of it) refused a ${formatMiB(tmpLength)} chunk; try a smaller --chunk-mib.`;
						}
						return fCallback(tmpHTTPError);
					}
					let tmpNewOffset = parseOffsetHeader(pResponse.Headers['upload-offset']);
					if (tmpNewOffset === null && pResponse.JSON && Number.isSafeInteger(pResponse.JSON.Offset) && pResponse.JSON.Offset >= 0)
					{
						tmpNewOffset = pResponse.JSON.Offset;
					}
					tmpFile.Sent = true;
					tmpFile.Failures = 0;
					if (tmpNewOffset === null || tmpNewOffset < tmpStart || tmpNewOffset > pFile.Bytes)
					{
						// No usable offset in a success: ask again.
						return fConflict('a success without a usable Upload-Offset', fHead);
					}
					pRun.UploadedBytes += (tmpNewOffset - tmpStart);
					tmpFile.Offset = tmpNewOffset;
					pRun.Progress.Offsets[pFile.Path] = tmpNewOffset;
					this._uploadProgress(pRun, pFile.Path, 0);
					if (tmpNewOffset === tmpStart && tmpLength > 0)
					{
						return fConflict(`the offset stayed at ${tmpStart}`, fHead);
					}
					tmpFile.Conflicts = 0;
					return fChunk();
				});
		};

		this._uploadProgress(pRun, pFile.Path, 0, `Sending ${pFile.Path}`);
		fHead();
	}

	// ---- HTTP -----------------------------------------------------------

	_routePath(pRun, pSuffix)
	{
		return pRun.Server.BasePath + pRun.Prefix + pSuffix;
	}

	/**
	 * Server-supplied text as it may be logged or put in an error: made
	 * printable and capped (printableServerText), the token redacted.
	 */
	_serverText(pRun, pValue, pMaxChars)
	{
		return printableServerText(pValue, pMaxChars, pRun.Options.Token);
	}

	/**
	 * A server value for a message, a string in quotes.  The raw value is made
	 * printable (and the token redacted) first and the quotes added after, never
	 * JSON.stringify of the raw value: that throws on JSON nested deeper than
	 * the stack (JSON.parse accepts it) and would escape a token before the
	 * redaction could find it.
	 */
	_serverQuoted(pRun, pValue)
	{
		let tmpText = this._serverText(pRun, pValue);
		return (typeof pValue === 'string') ? `"${tmpText}"` : tmpText;
	}

	/**
	 * Build an Error for a non-2xx answer: the server's `{Error}` text (made
	 * printable), never the token or the request URL's host credentials.
	 */
	_httpError(pRun, pLabel, pResponse)
	{
		let tmpAnswer = (pResponse.JSON && typeof pResponse.JSON === 'object') ? pResponse.JSON : null;
		let tmpServerError = (tmpAnswer && typeof tmpAnswer.Error === 'string') ? this._serverText(pRun, tmpAnswer.Error) : null;
		let tmpErrors = (tmpAnswer && Array.isArray(tmpAnswer.Errors)) ? tmpAnswer.Errors.map((pItem) => this._serverText(pRun, pItem)) : null;
		let tmpMessage = `${pLabel}: the server answered ${pResponse.Status}${tmpServerError ? `: ${tmpServerError}` : '.'}`;
		if (tmpErrors && tmpErrors.length > 0)
		{
			tmpMessage += ` (${tmpErrors.slice(0, 10).join('; ')})`;
		}
		let tmpError = new Error(tmpMessage);
		tmpError.StatusCode = pResponse.Status;
		tmpError.ServerError = tmpServerError;
		if (tmpErrors)
		{
			tmpError.Errors = tmpErrors;
		}
		return tmpError;
	}

	/**
	 * A JSON call (register / commit) retried on network errors, 408 and 5xx.
	 */
	_callWithRetry(pRun, pSpec, pLabel, fCallback)
	{
		let tmpFailures = 0;
		let fAttempt = () =>
		{
			pRun.State.Current = this._request(pRun, pSpec, (pError, pResponse) =>
				{
					pRun.State.Current = null;
					if (pRun.State.Cancelled)
					{
						return fCallback(libTools.cancelledError('Push cancelled.'));
					}
					if (pError && !pError.Network)
					{
						return fCallback(pError);
					}
					if (pError || isRetryableStatus(pResponse.Status))
					{
						let tmpReason = pError ? pError.message : `the server answered ${pResponse.Status}`;
						tmpFailures++;
						if (tmpFailures >= pRun.Retries)
						{
							let tmpGiveUp = new Error(`${pLabel}: gave up after ${tmpFailures} consecutive failed attempts (the last: ${tmpReason}).`);
							tmpGiveUp.Retryable = true;
							if (pResponse)
							{
								tmpGiveUp.StatusCode = pResponse.Status;
							}
							return fCallback(tmpGiveUp);
						}
						let tmpDelay = backoffDelay(tmpFailures, pRun.BackoffMS, pRun.MaxBackoffMS);
						this.log.warn(`media-ladder push: ${pLabel}: ${tmpReason}; retrying in ${(tmpDelay / 1000).toFixed(1)} s (attempt ${tmpFailures + 1} of ${pRun.Retries}).`);
						return this._wait(pRun, tmpDelay, (pWaitError) => (pWaitError ? fCallback(pWaitError) : fAttempt()));
					}
					return fCallback(null, pResponse);
				});
		};
		fAttempt();
	}

	/**
	 * A cancellable timer.
	 */
	_wait(pRun, pDelayMS, fCallback)
	{
		let tmpSettled = false;
		let tmpTimer = setTimeout(() =>
			{
				if (tmpSettled)
				{
					return;
				}
				tmpSettled = true;
				pRun.State.Current = null;
				return fCallback(pRun.State.Cancelled ? libTools.cancelledError('Push cancelled.') : null);
			}, pDelayMS);
		pRun.State.Current =
		{
			cancel: () =>
			{
				if (tmpSettled)
				{
					return false;
				}
				tmpSettled = true;
				clearTimeout(tmpTimer);
				setImmediate(() => fCallback(libTools.cancelledError('Push cancelled.')));
				return true;
			}
		};
		return pRun.State.Current;
	}

	/**
	 * One HTTP exchange.  Every non-2xx answer RESOLVES (callers decide);
	 * the error argument is for transport problems (`.Network = true`: a reset,
	 * a refused connection, an idle socket) and local ones (an unreadable
	 * file, a file that changed while it was sent).
	 *
	 * @param {Object} pRun
	 * @param {Object} pSpec - { Method, Path, JSON?, Empty?, File?: { Absolute, Start, Length }, TimeoutMS?, onSent?(pBytes) }
	 * @param {function} fCallback - (pError, { Status, Headers, Body, JSON })
	 * @returns {Object} handle { cancel() }
	 */
	_request(pRun, pSpec, fCallback)
	{
		let tmpSettled = false;
		let tmpCancelRequested = false;
		let tmpRequest = null;
		let tmpFileStream = null;
		let tmpResponse = null;
		let tmpBodyComplete = false;
		let tmpChunks = [];
		let tmpBytes = 0;

		let fSettle = (pError, pResult) =>
		{
			if (tmpSettled)
			{
				return;
			}
			tmpSettled = true;
			if (tmpFileStream)
			{
				tmpFileStream.destroy();
				tmpFileStream = null;
			}
			return fCallback(pError, pResult);
		};
		let fNetworkError = (pMessage, pCause) =>
		{
			let tmpError = new Error(pMessage);
			tmpError.Network = true;
			if (pCause && pCause.code)
			{
				tmpError.Code = pCause.code;
			}
			return tmpError;
		};
		let fLocalError = (pMessage) =>
		{
			let tmpError = new Error(pMessage);
			tmpError.Local = true;
			return tmpError;
		};
		let fFinishResponse = () =>
		{
			if (tmpSettled || !tmpResponse)
			{
				return;
			}
			let tmpBody = Buffer.concat(tmpChunks);
			let tmpJSON = null;
			if (tmpBody.length > 0)
			{
				try
				{
					tmpJSON = JSON.parse(tmpBody.toString('utf8'));
				}
				catch (pParseError)
				{
					tmpJSON = null;
				}
			}
			let tmpResult = { Status: tmpResponse.statusCode, Headers: tmpResponse.headers, Body: tmpBody, JSON: tmpJSON };
			if (!tmpBodyComplete && tmpRequest)
			{
				// The server answered before the whole body went: this socket is done.
				tmpRequest.destroy();
			}
			if (!tmpResponse.complete && tmpResult.Status >= 200 && tmpResult.Status <= 299)
			{
				// A success whose answer was cut off cannot be trusted: retry it (a re-HEAD,
				// a re-register and a re-commit are all safe).
				return fSettle(fNetworkError(`${pSpec.Method} answer was cut off`));
			}
			return fSettle(null, tmpResult);
		};

		let tmpHeaders =
		{
			'Accept': 'application/json',
			'Authorization': `Bearer ${pRun.Options.Token}`
		};
		let tmpBodyBuffer = null;
		if (pSpec.JSON)
		{
			tmpBodyBuffer = Buffer.from(JSON.stringify(pSpec.JSON), 'utf8');
			tmpHeaders['Content-Type'] = 'application/json';
			tmpHeaders['Content-Length'] = String(tmpBodyBuffer.length);
		}
		else if (pSpec.File)
		{
			tmpHeaders['Content-Type'] = 'application/octet-stream';
			tmpHeaders['Content-Length'] = String(pSpec.File.Length);
			tmpHeaders['Upload-Offset'] = String(pSpec.File.Start);
		}
		else if (pSpec.Empty)
		{
			tmpHeaders['Content-Length'] = '0';
		}

		let tmpLibrary = (pRun.Server.Protocol === 'https:') ? libHTTPS : libHTTP;
		try
		{
			tmpRequest = tmpLibrary.request(
				{
					protocol: pRun.Server.Protocol,
					hostname: pRun.Server.Hostname,
					port: pRun.Server.Port,
					method: pSpec.Method,
					path: pSpec.Path,
					headers: tmpHeaders,
					agent: pRun.Agent
				},
				(pResponse) =>
				{
					tmpResponse = pResponse;
					if (tmpFileStream && !tmpBodyComplete)
					{
						// An early answer (409 / 413 / 401 before the body was read): stop sending.
						tmpFileStream.destroy();
						tmpFileStream = null;
					}
					pResponse.on('data', (pChunk) =>
						{
							tmpBytes += pChunk.length;
							if (tmpBytes > MAX_RESPONSE_BYTES)
							{
								pResponse.destroy();
								return fSettle(fLocalError(`${pSpec.Method} answer was larger than ${formatMiB(MAX_RESPONSE_BYTES)}.`));
							}
							tmpChunks.push(pChunk);
						});
					pResponse.on('end', fFinishResponse);
					// A cut-off answer still has a status, which is what callers act on.
					pResponse.on('error', fFinishResponse);
					pResponse.on('close', fFinishResponse);
				});
		}
		catch (pRequestError)
		{
			setImmediate(() => fSettle(fLocalError(`Could not start the ${pSpec.Method} request: ${pRequestError.message}`)));
			return libTools.inertHandle();
		}

		tmpRequest.on('error', (pError) =>
			{
				if (tmpCancelRequested)
				{
					return fSettle(libTools.cancelledError('Push cancelled.'));
				}
				if (tmpResponse)
				{
					return fFinishResponse();
				}
				if (pError && (pError.Local || pError.Network))
				{
					return fSettle(pError);
				}
				// The text may carry what the server sent (a TLS certificate's names, say).
				return fSettle(fNetworkError(`${pSpec.Method} failed: ${this._serverText(pRun, (pError && pError.message) || 'connection error')}`, pError));
			});
		let tmpTimeout = positiveInteger(pSpec.TimeoutMS, pRun.SocketTimeoutMS);
		tmpRequest.setTimeout(tmpTimeout, () =>
			{
				tmpRequest.destroy(fNetworkError(`${pSpec.Method} timed out (no data for ${(tmpTimeout / 1000).toFixed(0)} s)`));
			});

		if (tmpBodyBuffer)
		{
			tmpBodyComplete = true;
			tmpRequest.end(tmpBodyBuffer);
		}
		else if (pSpec.File && pSpec.File.Length > 0)
		{
			let tmpSent = 0;
			let tmpExpected = pSpec.File.Length;
			tmpFileStream = libFS.createReadStream(pSpec.File.Absolute,
				{ start: pSpec.File.Start, end: pSpec.File.Start + tmpExpected - 1, highWaterMark: READ_HIGH_WATER_MARK });
			tmpFileStream.on('data', (pChunk) =>
				{
					if (tmpSettled)
					{
						return;
					}
					tmpSent += pChunk.length;
					let tmpFlushed = tmpRequest.write(pChunk);
					if (typeof pSpec.onSent === 'function')
					{
						pSpec.onSent(tmpSent);
					}
					if (!tmpFlushed && tmpFileStream)
					{
						let tmpStream = tmpFileStream;
						tmpStream.pause();
						tmpRequest.once('drain', () => { tmpStream.resume(); });
					}
				});
			tmpFileStream.on('end', () =>
				{
					tmpFileStream = null;
					if (tmpSettled)
					{
						return;
					}
					if (tmpSent !== tmpExpected)
					{
						// Never let a short body hang until the server's request timeout.
						let tmpChanged = fLocalError(`${libPath.basename(pSpec.File.Absolute)} changed while it was being sent (read ${tmpSent} of ${tmpExpected} bytes); re-verify the package.`);
						fSettle(tmpChanged);
						tmpRequest.destroy();
						return;
					}
					tmpBodyComplete = true;
					tmpRequest.end();
				});
			tmpFileStream.on('error', (pError) =>
				{
					let tmpReadError = fLocalError(`Could not read ${pSpec.File.Absolute}: ${pError.message}`);
					fSettle(tmpReadError);
					tmpRequest.destroy();
				});
		}
		else
		{
			tmpBodyComplete = true;
			tmpRequest.end();
		}

		return (
			{
				cancel: () =>
				{
					if (tmpSettled)
					{
						return false;
					}
					tmpCancelRequested = true;
					tmpRequest.destroy();
					setImmediate(() => fSettle(libTools.cancelledError('Push cancelled.')));
					return true;
				}
			});
	}
}

module.exports = Publisher;
module.exports.parseServerURL = parseServerURL;
module.exports.normalizePrefix = normalizePrefix;
module.exports.encodeUploadPath = encodeUploadPath;
module.exports.backoffDelay = backoffDelay;
module.exports.shrinkChunk = shrinkChunk;
module.exports.isRetryableStatus = isRetryableStatus;
module.exports.checkPackageDirectoryName = checkPackageDirectoryName;
module.exports.captureDateFromProbe = captureDateFromProbe;
module.exports.sourceFromProbe = sourceFromProbe;
module.exports.normalizeSourceBlock = normalizeSourceBlock;
module.exports.commitRetryPaths = commitRetryPaths;
module.exports.parseOffsetHeader = parseOffsetHeader;
module.exports.printableServerText = printableServerText;
module.exports.DEFAULT_PREFIX = DEFAULT_PREFIX;
module.exports.DEFAULT_CHUNK_BYTES = DEFAULT_CHUNK_BYTES;
module.exports.DEFAULT_MIN_CHUNK_BYTES = DEFAULT_MIN_CHUNK_BYTES;
module.exports.DEFAULT_RETRIES = DEFAULT_RETRIES;
module.exports.DEFAULT_BUSY_WAIT_MS = DEFAULT_BUSY_WAIT_MS;
module.exports.SENSITIVITIES = SENSITIVITIES;
