/**
* Publisher tests: `media-ladder push` and Publisher.publish against an
* in-test fake server (test/support/Fake-Media-Ingest-Server.js) that
* implements the register / HEAD / PUT / commit protocol with injectable
* faults -- a connection dropped mid-chunk, a chunk stored but its answer
* lost, a wrong offset (409), a busy file (409) -- including one whose lock
* outlives a chunk cut off mid-body, as on a server that has not noticed a
* half-open connection -- 5xx, a chunk too slow, a socket that goes idle, a
* commit that finds a mismatched or missing file, and server text built to
* attack a terminal.  They prove resume from the last whole chunk, the retry
* limits and backoff, the busy-file wait (its own clock, not Retries), chunk
* halving, cancel / abort, the refusals (unfinished or damaged packages, a
* server naming files outside the package), that server text is printed
* safely and that the token never leaks.  Packages are hand-built (they pass verifyPackage); one suite
* also pushes a real lavfi-encoded package with `--source` probing, and
* skips loudly when ffmpeg is not installed.  The CLI's general behaviour
* (--version, --help, no command, the macOS-only --fast, flag values that are
* usage errors, and `plan`'s command line quoted for the platform's shell) is
* tested here too, against a stand-in ffprobe and ffmpeg.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libChildProcess = require('node:child_process');
const libCrypto = require('node:crypto');
const libFS = require('node:fs');
const libOS = require('node:os');
const libPath = require('node:path');

const libRetoldMediaLadder = require('../source/Retold-Media-Ladder.js');
const libPublisher = require('../source/Publisher.js');
const libPackageWriter = require('../source/Package-Writer.js');
const libFakeServer = require('./support/Fake-Media-Ingest-Server.js');
const libStandInFFmpeg = require('./support/Stand-In-FFmpeg.js');
const libLadderPlanner = require('../source/Ladder-Planner.js');

const BIN = libPath.join(__dirname, '..', 'bin', 'media-ladder.js');
const TOKEN = 'exo_test-token-0123456789abcdef';
const KIB = 1024;
const MIB = 1048576;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Code points a terminal acts on instead of showing: C0, DEL, C1, the bidirectional controls and the
// line / paragraph separators.
const UNPRINTABLE_PATTERN = /[\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
// Server text built to attack a terminal: an OSC title change ended by BEL, an erase-line and a CR
// that would overwrite the line with a fake success, a newline, NUL, a C1 CSI, DEL, a right-to-left
// override and an isolate (to disguise a file name), the token echoed back, and far too much of it.
const HOSTILE = 'denied\x1b]0;TITLE-HIJACK\x07\x1b[2K\rmedia-ladder: pushed OK\n\x00\x9b31m\x7f\u{202e}gpj.exe\u{2066}'
	+ ` Bearer ${TOKEN} ` + 'A'.repeat(5000);
// A JSON object where text or a number is expected: its own toString / valueOf are numbers, not functions, so
// String(), Number() and a template literal of it throw 'Cannot convert object to primitive value'.
const NOT_TEXT = { toString: 1, valueOf: 1 };
const NOT_TEXT_JSON = '{"toString":1,"valueOf":1}';
// JSON nested deeper than the stack: JSON.parse takes it (40 KB, well under the client's 4 MiB answer limit),
// but JSON.stringify of the result throws RangeError.
const DEEP_JSON = '['.repeat(20000) + ']'.repeat(20000);

const TOOLS_AVAILABLE = (() =>
{
	try
	{
		return libChildProcess.spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0
			&& libChildProcess.spawnSync('ffprobe', ['-hide_banner', '-version']).status === 0;
	}
	catch (pError)
	{
		return false;
	}
})();

/** A log that records warnings (and stays quiet). */
function recordingLog()
{
	let tmpLog = { Lines: [] };
	let fRecord = (pMessage) => { tmpLog.Lines.push(String(pMessage)); };
	tmpLog.trace = () => {};
	tmpLog.debug = () => {};
	tmpLog.info = () => {};
	tmpLog.warn = fRecord;
	tmpLog.error = fRecord;
	return tmpLog;
}

function sha256Of(pBuffer)
{
	return libCrypto.createHash('sha256').update(pBuffer).digest('hex');
}

/** The visible escape printableServerText writes for a code point. */
function escaped(pCodePoint)
{
	return `\\u${pCodePoint.toString(16).padStart(4, '0')}`;
}

/** Text that is safe on a terminal: nothing UNPRINTABLE_PATTERN matches, and never the token. */
function assertPrintable(pText, pWhat)
{
	Expect(typeof pText, pWhat).to.equal('string');
	Expect(UNPRINTABLE_PATTERN.test(pText), `${pWhat}: ${libPublisher.printableServerText(pText, 400)}`).to.equal(false);
	Expect(pText, pWhat).to.not.contain(TOKEN);
}

const DEFAULT_SIZES =
{
	'master.m3u8': 120,
	'poster.jpg': 5000,
	'v0/index.m3u8': 300,
	'v0/media.mp4': 300000,
	'v1/index.m3u8': 300,
	'v1/media.mp4': 100000
};

/**
 * Write a package directory that passes PackageWriter.verifyPackage: random
 * bytes per file and a version-1 package.json listing them.
 */
function buildPackage(pParent, pPackageVersion, pSizes)
{
	let tmpSizes = pSizes || DEFAULT_SIZES;
	let tmpDirectory = libPath.join(pParent, pPackageVersion);
	let tmpFiles = [];
	Object.keys(tmpSizes).sort().forEach((pPath) =>
		{
			let tmpBytes = libCrypto.randomBytes(tmpSizes[pPath]);
			libFS.mkdirSync(libPath.dirname(libPath.join(tmpDirectory, pPath)), { recursive: true });
			libFS.writeFileSync(libPath.join(tmpDirectory, pPath), tmpBytes);
			tmpFiles.push({ Path: pPath, Bytes: tmpBytes.length, Sha256: sha256Of(tmpBytes) });
		});
	let tmpDocument =
	{
		Version: 1,
		Kind: 'video',
		PackageVersion: pPackageVersion,
		DurationMS: 2000,
		Width: 640,
		Height: 360,
		SegmentSeconds: 6,
		HasAudio: false,
		Manifest: 'master.m3u8',
		Poster: 'poster.jpg',
		Download: null,
		Renditions:
		[
			{ Name: '360p', ShortSide: 360, Width: 640, Height: 360, FrameRate: 30, Bandwidth: 800000, Codecs: 'avc1.64001e', Playlist: 'v0/index.m3u8', File: 'v0/media.mp4', Bytes: tmpSizes['v0/media.mp4'], Sha256: tmpFiles.filter((pFile) => pFile.Path === 'v0/media.mp4')[0].Sha256 }
		],
		Audio: null,
		Files: tmpFiles
	};
	libFS.writeFileSync(libPath.join(tmpDirectory, 'package.json'), JSON.stringify(tmpDocument, null, '\t') + '\n');
	return { Directory: tmpDirectory, PackageVersion: pPackageVersion, Document: tmpDocument };
}

function copyDirectory(pFrom, pTo)
{
	libFS.cpSync(pFrom, pTo, { recursive: true });
	return pTo;
}

/** Every package file (and package.json + .ready) is live on the fake server, byte for byte. */
function assertLive(pServer, pAssetGUID, pPackage)
{
	let tmpLive = pServer.liveDirectory(pAssetGUID, pPackage.PackageVersion);
	Expect(libFS.existsSync(libPath.join(tmpLive, '.ready')), 'live .ready').to.equal(true);
	Expect(JSON.parse(libFS.readFileSync(libPath.join(tmpLive, 'package.json'), 'utf8')).PackageVersion).to.equal(pPackage.PackageVersion);
	pPackage.Document.Files.forEach((pFile) =>
		{
			let tmpServed = libFS.readFileSync(libPath.join(tmpLive, pFile.Path));
			Expect(tmpServed.equals(libFS.readFileSync(libPath.join(pPackage.Directory, pFile.Path))), pFile.Path).to.equal(true);
		});
}

function totalBytes(pPackage)
{
	return pPackage.Document.Files.reduce((pSum, pFile) => pSum + pFile.Bytes, 0);
}

/** Wrap a callback-style test body so assertion failures reach fDone. */
function guard(fDone, fBody)
{
	return function ()
	{
		try
		{
			fBody.apply(null, arguments);
		}
		catch (pAssertError)
		{
			return fDone(pAssertError);
		}
	};
}

function cleanEnvironment(pExtra)
{
	let tmpEnvironment = Object.assign({}, process.env);
	delete tmpEnvironment.MEDIA_LADDER_SERVER;
	delete tmpEnvironment.MEDIA_LADDER_TOKEN;
	return Object.assign(tmpEnvironment, pExtra || {});
}

function runCLI(pArguments, pEnvironment, fCallback)
{
	return libChildProcess.execFile(process.execPath, [BIN].concat(pArguments), { env: cleanEnvironment(pEnvironment) }, (pError, pStdout, pStderr) =>
		{
			return fCallback((pError && typeof pError.code === 'number') ? pError.code : (pError ? -1 : 0), String(pStdout), String(pStderr));
		});
}

suite
(
	'Retold Media Ladder -- Publisher (push)',
	function ()
	{
		let tmpScratch = false;
		let tmpPackage = null;

		suiteSetup
		(
			() =>
			{
				tmpScratch = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'retold-media-ladder-push-'));
				tmpPackage = buildPackage(libPath.join(tmpScratch, 'out'), '1a2b3c4d');
			}
		);

		suiteTeardown
		(
			() =>
			{
				if (tmpScratch)
				{
					libFS.rmSync(tmpScratch, { recursive: true, force: true });
				}
			}
		);

		suite
		(
			'pure helpers',
			() =>
			{
				test
				(
					'server URL, prefix and upload-path encoding',
					() =>
					{
						Expect(libPublisher.parseServerURL('https://media.example')).to.deep.equal({ Protocol: 'https:', Hostname: 'media.example', Port: 443, BasePath: '', Origin: 'https://media.example' });
						Expect(libPublisher.parseServerURL('http://127.0.0.1:8086/base/')).to.include({ Port: 8086, BasePath: '/base', Hostname: '127.0.0.1' });
						Expect(libPublisher.parseServerURL('http://[::1]:9000').Hostname).to.equal('::1');
						['', 'ftp://x', 'not a url', 'https://user:pass@x', 'https://x/?a=1'].forEach((pBad) =>
							{
								Expect(() => libPublisher.parseServerURL(pBad), pBad).to.throw();
							});
						Expect(libPublisher.normalizePrefix()).to.equal('/1.0/MediaIngest');
						Expect(libPublisher.normalizePrefix('/api/Upload/')).to.equal('/api/Upload');
						['x', '/', '/a/../b', '/a?b', '//a', '/a b'].forEach((pBad) =>
							{
								Expect(() => libPublisher.normalizePrefix(pBad), pBad).to.throw();
							});
						Expect(libPublisher.encodeUploadPath('v0/media.mp4')).to.equal('v0/media.mp4');
						Expect(libPublisher.encodeUploadPath('a b/c?d#e%')).to.equal('a%20b/c%3Fd%23e%25');
					}
				);

				test
				(
					'backoff doubles from 1 s to a 30 s cap; slow chunks halve to the 8 MiB floor; retryable statuses',
					() =>
					{
						Expect([1, 2, 3, 4, 5, 6, 7].map((pFailures) => libPublisher.backoffDelay(pFailures))).to.deep.equal([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
						Expect(libPublisher.backoffDelay(3, 10, 25)).to.equal(25);
						Expect(libPublisher.shrinkChunk(32 * MIB, 8 * MIB)).to.equal(16 * MIB);
						Expect(libPublisher.shrinkChunk(16 * MIB, 8 * MIB)).to.equal(8 * MIB);
						Expect(libPublisher.shrinkChunk(8 * MIB, 8 * MIB)).to.equal(8 * MIB);
						Expect([200, 400, 404, 408, 409, 413, 500, 502, 503].map(libPublisher.isRetryableStatus)).to.deep.equal([false, false, false, true, false, false, true, true, true]);
						Expect(libPublisher.parseOffsetHeader('65536')).to.equal(65536);
						Expect(libPublisher.parseOffsetHeader(['0'])).to.equal(0);
						['', '-1', '1.5', 'x', undefined, '99999999999999999'].forEach((pBad) => { Expect(libPublisher.parseOffsetHeader(pBad), String(pBad)).to.equal(null); });
					}
				);

				test
				(
					'only a committed <PV>/ is a package directory: <PV>.partial, <PV>.lock and other names are refused',
					() =>
					{
						Expect(libPublisher.checkPackageDirectoryName('/out/1a2b3c4d/')).to.deep.equal({ Directory: '/out/1a2b3c4d', PackageVersion: '1a2b3c4d' });
						let fRefusal = (pPath) =>
						{
							try
							{
								libPublisher.checkPackageDirectoryName(pPath);
							}
							catch (pError)
							{
								Expect(pError.Refused).to.equal(true);
								return pError.message;
							}
							throw new Error(`${pPath} was not refused`);
						};
						Expect(fRefusal('/out/1a2b3c4d.partial')).to.contain('unfinished encode');
						Expect(fRefusal('/out/1a2b3c4d.lock')).to.contain('lock file');
						Expect(fRefusal('/out')).to.contain('not a package directory');
						Expect(fRefusal('/out/1A2B3C4D')).to.contain('not a package directory');
						Expect(fRefusal('')).to.contain('required');
					}
				);

				test
				(
					'Source from a probe: transfer, and the capture date from creation_time (format tag, else the video stream)',
					() =>
					{
						let tmpRaw = { format: { tags: { creation_time: '2024-05-01T10:00:00.000000Z' } }, streams: [{ codec_type: 'video', tags: { creation_time: '2020-01-01T00:00:00Z' } }] };
						Expect(libPublisher.captureDateFromProbe(tmpRaw)).to.equal('2024-05-01T10:00:00.000Z');
						Expect(libPublisher.captureDateFromProbe({ format: {}, streams: [{ codec_type: 'audio', tags: { creation_time: '2019-01-01T00:00:00Z' } }, { codec_type: 'video', tags: { creation_time: '2020-01-01T00:00:00Z' } }] })).to.equal('2020-01-01T00:00:00.000Z');
						Expect(libPublisher.captureDateFromProbe({ format: { tags: { creation_time: '1970-01-01T00:00:00.000000Z' } } })).to.equal(null);
						Expect(libPublisher.captureDateFromProbe({ format: { tags: { creation_time: 'yesterday' } } })).to.equal(null);
						Expect(libPublisher.captureDateFromProbe({})).to.equal(null);
						Expect(libPublisher.captureDateFromProbe(null)).to.equal(null);

						let tmpSha = 'c'.repeat(64);
						Expect(libPublisher.sourceFromProbe('DJI_0001.MP4', tmpSha, { Video: { Transfer: 'hlg' }, Raw: tmpRaw }))
							.to.deep.equal({ Name: 'DJI_0001.MP4', Sha256: tmpSha, Transfer: 'hlg', CaptureDate: '2024-05-01T10:00:00.000Z' });
						Expect(libPublisher.sourceFromProbe('audio.wav', tmpSha, { Video: null, Raw: {} })).to.deep.equal({ Name: 'audio.wav', Sha256: tmpSha, Transfer: '' });
					}
				);

				test
				(
					'a caller-supplied Source block keeps only the protocol fields; commit retry paths accept strings or { Path }',
					() =>
					{
						Expect(libPublisher.normalizeSourceBlock({ Name: 'a.mov', Sha256: 'a'.repeat(64), Transfer: 'log', CaptureDate: '2024-05-01T10:00:00-07:00', Extra: 1 }))
							.to.deep.equal({ Name: 'a.mov', Sha256: 'a'.repeat(64), Transfer: 'log', CaptureDate: '2024-05-01T17:00:00.000Z' });
						Expect(() => libPublisher.normalizeSourceBlock({ Sha256: 'XYZ' })).to.throw('Sha256');
						Expect(() => libPublisher.normalizeSourceBlock({ Transfer: 'dolby' })).to.throw('Transfer');
						Expect(() => libPublisher.normalizeSourceBlock({ CaptureDate: 'soon' })).to.throw('CaptureDate');
						Expect(libPublisher.commitRetryPaths({ Mismatched: ['v0/media.mp4'], Missing: [{ Path: 'poster.jpg', Bytes: 5 }, 'v0/media.mp4', 7, null] }))
							.to.deep.equal(['v0/media.mp4', 'poster.jpg']);
						Expect(libPublisher.commitRetryPaths({ Error: 'x' })).to.deep.equal([]);
					}
				);

				test
				(
					'printableServerText: control, DEL, C1 and bidi characters become visible escapes; text is capped (default 300); a secret is redacted before the cut; a JSON object shows as JSON, never through its own toString',
					() =>
					{
						let fText = libPublisher.printableServerText;
						Expect(fText('Already committed.')).to.equal('Already committed.');
						Expect(fText('a\x1b[31mb\x07c\rd\ne\tf\x00'))
							.to.equal(`a${escaped(0x1b)}[31mb${escaped(0x07)}c${escaped(0x0d)}d${escaped(0x0a)}e${escaped(0x09)}f${escaped(0x00)}`);
						let tmpControls = [0x7f, 0x80, 0x85, 0x9b, 0x9f, 0x61c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202d, 0x202e, 0x2066, 0x2068, 0x2069];
						Expect(fText(String.fromCodePoint.apply(null, tmpControls))).to.equal(tmpControls.map(escaped).join(''));
						// Printable text outside ASCII is kept, and an astral character is never split.
						let tmpKept = 'caf\u{e9} \u{4e2d}\u{6587} \u{1f600}';
						Expect(fText(tmpKept)).to.equal(tmpKept);
						Expect(fText('ab\u{1f600}', 3)).to.equal('ab...');
						Expect(fText('x'.repeat(300))).to.equal('x'.repeat(300));
						Expect(fText('x'.repeat(5000))).to.equal('x'.repeat(300) + '...');
						Expect(fText('\x1b'.repeat(100), 20)).to.equal(escaped(0x1b).repeat(3) + '...');
						Expect(fText(404)).to.equal('404');
						Expect(fText(null)).to.equal('null');
						Expect(fText(undefined)).to.equal('undefined');
						// A JSON object or array shows as its JSON, its own toString / valueOf never called (String() of
						// NOT_TEXT throws); the strings inside are made printable, redacted and capped all the same.
						Expect(() => String(NOT_TEXT)).to.throw(TypeError);
						Expect(fText(NOT_TEXT)).to.equal(NOT_TEXT_JSON);
						Expect(fText([NOT_TEXT, 'a\x9bb\u{202e}c'])).to.equal(`[${NOT_TEXT_JSON},"a${escaped(0x9b)}b${escaped(0x202e)}c"]`);
						Expect(fText({ Error: `x ${TOKEN}` }, 300, TOKEN)).to.equal('{"Error":"x <token>"}');
						Expect(fText({ Long: 'z'.repeat(400) })).to.equal(`{"Long":"${'z'.repeat(291)}...`);
						// Not something JSON.parse can make, but still never a throw: a circular object shows as its type.
						let tmpCircular = { Name: 'loop' };
						tmpCircular.Self = tmpCircular;
						Expect(fText(tmpCircular)).to.equal('[object Object]');
						Expect(fText(`no ${TOKEN} here, nor ${TOKEN}`, 300, TOKEN)).to.equal('no <token> here, nor <token>');
						Expect(fText('y'.repeat(295) + TOKEN, 300, TOKEN)).to.equal('y'.repeat(295) + '<toke...');
						// A token holding '"' or '\\' (both allowed) is escaped in an object's JSON: that spelling is redacted too.
						let tmpQuoteToken = 'ab"cd\\ef';
						Expect(fText({ Error: `x ${tmpQuoteToken}` }, 300, tmpQuoteToken)).to.equal('{"Error":"x <token>"}');
						Expect(fText(`x ${tmpQuoteToken}`, 300, tmpQuoteToken)).to.equal('x <token>');
						// JSON too deep for JSON.stringify shows as its type, never a RangeError.
						let tmpDeep = JSON.parse(DEEP_JSON);
						Expect(() => JSON.stringify(tmpDeep)).to.throw(RangeError);
						Expect(fText(tmpDeep)).to.equal('[object Array]');
						Expect(fText({ Deep: tmpDeep })).to.equal('[object Object]');
						Expect(libPublisher.DEFAULT_BUSY_WAIT_MS).to.equal(360000);
					}
				);
			}
		);

		suite
		(
			'the push protocol against a fake server',
			function ()
			{
				let tmpServer = null;

				setup
				(
					(fDone) =>
					{
						tmpServer = new libFakeServer({ Root: libFS.mkdtempSync(libPath.join(tmpScratch, 'server-')), Token: TOKEN });
						tmpServer.start(fDone);
					}
				);

				teardown
				(
					(fDone) =>
					{
						tmpServer.stop(fDone);
					}
				);

				/** Publish with small chunks and fast backoff; returns the handle. */
				function publish(pDirectory, pOptions, fCallback)
				{
					let tmpOptions = Object.assign(
						{
							Server: tmpServer.BaseURL,
							Token: TOKEN,
							ChunkBytes: 64 * KIB,
							MinChunkBytes: 16 * KIB,
							BackoffMS: 5,
							MaxBackoffMS: 40
						}, pOptions || {});
					let tmpLog = tmpOptions.Log || recordingLog();
					delete tmpOptions.Log;
					return new libPublisher({ Log: tmpLog }).publish(pDirectory, tmpOptions, fCallback);
				}

				test
				(
					'register -> HEAD + chunked PUTs -> commit: the live copy matches byte for byte; progress runs verify..done',
					(fDone) =>
					{
						let tmpEvents = [];
						publish(tmpPackage.Directory, { Title: 'Lake day', Description: 'Kayaks', Sensitivity: 'normal', onProgress: (pEvent) => tmpEvents.push(pEvent) }, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.AssetGUID).to.match(UUID_PATTERN);
								Expect(pResult.PackageVersion).to.equal('1a2b3c4d');
								Expect(pResult.State).to.equal('ready');
								Expect(pResult.UploadedFiles).to.equal(6);
								Expect(pResult.UploadedBytes).to.equal(totalBytes(tmpPackage));
								Expect(pResult.TotalBytes).to.equal(totalBytes(tmpPackage));
								Expect(pResult.Source).to.equal(null);
								assertLive(tmpServer, pResult.AssetGUID, tmpPackage);

								let tmpRegistration = tmpServer.Registrations[0];
								Expect(tmpRegistration.Package).to.deep.equal(tmpPackage.Document);
								Expect(tmpRegistration).to.include({ Title: 'Lake day', Description: 'Kayaks', Sensitivity: 'normal' });
								Expect(tmpRegistration).to.not.have.property('Source');

								// Every request carried the bearer token; chunks are at most 64 KiB, offsets contiguous.
								Expect(tmpServer.AuthorizationHeaders.every((pHeader) => pHeader === `Bearer ${TOKEN}`)).to.equal(true);
								let tmpMediaPuts = tmpServer.entries('put', 'v0/media.mp4');
								Expect(tmpMediaPuts.map((pEntry) => pEntry.Offset)).to.deep.equal([0, 65536, 131072, 196608, 262144]);
								Expect(tmpMediaPuts.map((pEntry) => pEntry.ContentLength)).to.deep.equal([65536, 65536, 65536, 65536, 300000 - 262144]);
								Expect(tmpServer.entries('commit').length).to.equal(1);

								let tmpPhases = tmpEvents.map((pEvent) => pEvent.Phase).filter((pPhase, pIndex, pAll) => pIndex === 0 || pAll[pIndex - 1] !== pPhase);
								Expect(tmpPhases).to.deep.equal(['verify', 'register', 'upload', 'commit', 'done']);
								let tmpUploads = tmpEvents.filter((pEvent) => pEvent.Phase === 'upload');
								tmpUploads.forEach((pEvent, pIndex) =>
									{
										Expect(pEvent.Total).to.equal(totalBytes(tmpPackage));
										Expect(pEvent.Done).to.be.at.least(pIndex > 0 ? tmpUploads[pIndex - 1].Done : 0);
									});
								Expect(tmpUploads[tmpUploads.length - 1].Percent).to.equal(100);
								Expect(tmpEvents[tmpEvents.length - 1]).to.include({ Phase: 'done', Percent: 100 });
								fDone();
							}));
					}
				);

				test
				(
					'a re-push of a live package sends nothing (commit is idempotent, or a 409 that the status route shows is this live version)',
					(fDone) =>
					{
						publish(tmpPackage.Directory, {}, guard(fDone, (pError, pFirst) =>
							{
								Expect(pError).to.equal(null);
								let tmpLogLength = tmpServer.Log.length;
								publish(tmpPackage.Directory, {}, guard(fDone, (pSecondError, pSecond) =>
									{
										Expect(pSecondError).to.equal(null);
										Expect(pSecond).to.include({ AssetGUID: pFirst.AssetGUID, State: 'ready', UploadedFiles: 0, UploadedBytes: 0 });
										Expect(tmpServer.Log.slice(tmpLogLength).map((pEntry) => pEntry.Kind)).to.deep.equal(['register', 'commit']);
										// A server that answers that commit with 409 instead of 200: the status route confirms it is this version, live.
										tmpServer.options.CommitAlreadyLive = 'conflict';
										let tmpThirdBefore = tmpServer.Log.length;
										publish(tmpPackage.Directory, {}, guard(fDone, (pThirdError, pThird) =>
											{
												Expect(pThirdError).to.equal(null);
												Expect(pThird).to.include({ AssetGUID: pFirst.AssetGUID, State: 'ready', UploadedFiles: 0, TotalBytes: totalBytes(tmpPackage) });
												Expect(tmpServer.Log.slice(tmpThirdBefore).map((pEntry) => `${pEntry.Kind}:${pEntry.Status}`)).to.deep.equal(['register:200', 'commit:409', 'status:200']);
												fDone();
											}));
									}));
							}));
					}
				);

				test
				(
					'a re-push asking for another title or sensitivity warns that the server kept the asset\'s own, and reports it',
					(fDone) =>
					{
						publish(tmpPackage.Directory, { Title: 'Talk' }, guard(fDone, (pError, pFirst) =>
							{
								Expect(pError).to.equal(null);
								Expect(pFirst).to.not.have.property('Ignored');
								let tmpLog = recordingLog();
								publish(tmpPackage.Directory, { Title: 'Talk', Sensitivity: 'conversation', Log: tmpLog }, guard(fDone, (pSecondError, pSecond) =>
									{
										Expect(pSecondError).to.equal(null);
										Expect(pSecond).to.include({ AssetGUID: pFirst.AssetGUID, State: 'ready' });
										Expect(pSecond.Ignored).to.deep.equal(['Sensitivity']);
										Expect(pSecond.Current).to.deep.equal({ Title: 'Talk', Sensitivity: 'normal', ConsentState: 'unknown' });
										let tmpWarning = tmpLog.Lines.filter((pLine) => /already exists/.test(pLine));
										Expect(tmpWarning.length).to.equal(1);
										Expect(tmpWarning[0]).to.contain('kept its Sensitivity');
										Expect(tmpWarning[0]).to.contain('Sensitivity "normal"');
										Expect(tmpWarning[0]).to.contain(`PATCH /1.0/MediaIngest/${pFirst.AssetGUID}`);
										Expect(tmpWarning[0]).to.not.contain(TOKEN);
										// The same push with the asset's own values: nothing to warn about.
										let tmpQuiet = recordingLog();
										publish(tmpPackage.Directory, { Title: 'Talk', Log: tmpQuiet }, guard(fDone, (pThirdError, pThird) =>
											{
												Expect(pThirdError).to.equal(null);
												Expect(pThird).to.not.have.property('Ignored');
												Expect(tmpQuiet.Lines.filter((pLine) => /already exists/.test(pLine))).to.deep.equal([]);
												fDone();
											}));
									}));
							}));
					}
				);

				test
				(
					'resume: a push that gives up mid-file leaves only whole chunks, and the next push starts from them',
					(fDone) =>
					{
						// The third chunk of v0/media.mp4 always loses its connection mid-body.
						tmpServer.addFault({ Kind: 'put', Path: 'v0/media.mp4', Skip: 2, Times: 100, Action: 'drop', AfterBytes: 10000 });
						publish(tmpPackage.Directory, { Retries: 2 }, guard(fDone, (pError) =>
							{
								Expect(pError).to.be.an('error');
								Expect(pError.Retryable).to.equal(true);
								Expect(pError.message).to.contain('Gave up sending v0/media.mp4 after 2 consecutive failed attempts');
								Expect(pError.message).to.contain('resume');
								Expect(pError.message).to.not.contain(TOKEN);
								let tmpGUID = Object.keys(tmpServer.Assets)[0];
								let tmpStaged = libPath.join(tmpServer.stagingDirectory(tmpGUID, '1a2b3c4d'), 'v0', 'media.mp4');
								Expect(libFS.statSync(tmpStaged).size).to.equal(131072);
								Expect(tmpServer.entries('put', 'v0/media.mp4').filter((pEntry) => pEntry.Status === 'dropped').length).to.equal(2);

								tmpServer.clearFaults();
								let tmpBefore = tmpServer.Log.length;
								publish(tmpPackage.Directory, {}, guard(fDone, (pResumeError, pResult) =>
									{
										Expect(pResumeError).to.equal(null);
										Expect(pResult.AssetGUID).to.equal(tmpGUID);
										Expect(pResult.State).to.equal('ready');
										let tmpRegister = tmpServer.Log.slice(tmpBefore).filter((pEntry) => pEntry.Kind === 'register');
										Expect(tmpRegister.length).to.equal(1);
										let tmpResumedPuts = tmpServer.Log.slice(tmpBefore).filter((pEntry) => pEntry.Kind === 'put');
										// Only what was missing went: media.mp4 from 131072, then v1/index.m3u8 and v1/media.mp4.
										Expect(tmpResumedPuts.filter((pEntry) => pEntry.Path === 'v0/media.mp4').map((pEntry) => pEntry.Offset)).to.deep.equal([131072, 196608, 262144]);
										Expect(tmpResumedPuts.some((pEntry) => ['master.m3u8', 'poster.jpg', 'v0/index.m3u8'].indexOf(pEntry.Path) >= 0)).to.equal(false);
										Expect(pResult.UploadedBytes).to.equal((300000 - 131072) + 300 + 100000);
										assertLive(tmpServer, tmpGUID, tmpPackage);
										fDone();
									}));
							}));
					}
				);

				test
				(
					'retry limit: consecutive 5xx on one file give up after Retries attempts, backing off 1x, 2x, ...',
					(fDone) =>
					{
						tmpServer.addFault({ Kind: 'put', Path: 'v0/media.mp4', Times: 100, Action: 'status', Status: 500 });
						let tmpStarted = Date.now();
						publish(tmpPackage.Directory, { Retries: 3, BackoffMS: 40, MaxBackoffMS: 1000 }, guard(fDone, (pError) =>
							{
								Expect(pError).to.be.an('error');
								Expect(pError.message).to.contain('after 3 consecutive failed attempts');
								Expect(pError.message).to.contain('500');
								Expect(tmpServer.entries('put', 'v0/media.mp4').length).to.equal(3);
								// Two waits: 40 ms, then 80 ms.
								Expect(Date.now() - tmpStarted).to.be.at.least(120);
								Expect(tmpServer.entries('commit').length).to.equal(0);
								fDone();
							}));
					}
				);

				test
				(
					'one 500 is retried after a fresh HEAD; a 4xx other than 408/409 (413) fails at once with advice',
					(fDone) =>
					{
						tmpServer.addFault({ Kind: 'put', Path: 'v0/media.mp4', Skip: 1, Action: 'status', Status: 500 });
						let tmpLog = recordingLog();
						publish(tmpPackage.Directory, { Log: tmpLog }, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.State).to.equal('ready');
								let tmpMedia = tmpServer.Log.filter((pEntry) => pEntry.Path === 'v0/media.mp4');
								Expect(tmpMedia.map((pEntry) => `${pEntry.Kind}@${pEntry.Offset}:${pEntry.Status}`).slice(0, 5))
									.to.deep.equal(['head@0:200', 'put@0:200', 'put@65536:500', 'head@65536:200', 'put@65536:200']);
								Expect(tmpLog.Lines.join('\n')).to.contain('retrying in');
								assertLive(tmpServer, pResult.AssetGUID, tmpPackage);

								let tmpOther = buildPackage(libPath.join(tmpScratch, 'four-thirteen'), '0badc0de');
								tmpServer.addFault({ Kind: 'put', Path: 'master.m3u8', Times: 100, Action: 'status', Status: 413 });
								publish(tmpOther.Directory, {}, guard(fDone, (pTooLarge) =>
									{
										Expect(pTooLarge).to.be.an('error');
										Expect(pTooLarge.StatusCode).to.equal(413);
										Expect(pTooLarge.message).to.contain('smaller --chunk-mib');
										Expect(tmpServer.Log.filter((pEntry) => pEntry.Kind === 'put' && pEntry.Status === 413).length).to.equal(1);
										fDone();
									}));
							}));
					}
				);

				test
				(
					'409 with a wrong offset re-HEADs and carries on from the server\'s offset',
					(fDone) =>
					{
						// The first HEAD of v0/media.mp4 claims 4096 bytes are there; the PUT gets 409 and the client re-HEADs.
						tmpServer.addFault({ Kind: 'head', Path: 'v0/media.mp4', Action: 'offset', Offset: 4096 });
						let tmpLog = recordingLog();
						publish(tmpPackage.Directory, { Log: tmpLog }, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								let tmpMedia = tmpServer.Log.filter((pEntry) => pEntry.Path === 'v0/media.mp4');
								Expect(tmpMedia.slice(0, 4).map((pEntry) => `${pEntry.Kind}@${pEntry.Offset}:${pEntry.Status}`))
									.to.deep.equal(['head@4096:200', 'put@4096:409', 'head@0:200', 'put@0:200']);
								// A wrong offset is not a busy file: no waiting.
								Expect(tmpLog.Lines.filter((pLine) => /waiting for the server/.test(pLine))).to.deep.equal([]);
								Expect(pResult.UploadedBytes).to.equal(totalBytes(tmpPackage));
								assertLive(tmpServer, pResult.AssetGUID, tmpPackage);
								fDone();
							}));
					}
				);

				test
				(
					'a busy file (a chunk cut off while the server keeps its lock) is waited for past the Retries budget and the conflict limit; the push then completes byte for byte',
					(fDone) =>
					{
						// v0/media.mp4's second chunk loses its connection mid-body, and the server keeps the file
						// locked for 1.5 s after (a half-open socket it has not noticed: in production, until Node's
						// 300 s requestTimeout).  At these backoffs the Retries budget (2) was spent after a single
						// 10 ms wait, and the busy answers outnumber MAX_CONFLICTS (10): they must spend neither.
						tmpServer.options.StaleLockMS = 1500;
						tmpServer.addFault({ Kind: 'put', Path: 'v0/media.mp4', Skip: 1, Action: 'drop', AfterBytes: 10000 });
						let tmpLog = recordingLog();
						let tmpEvents = [];
						let tmpStarted = Date.now();
						publish(tmpPackage.Directory, { Retries: 2, BackoffMS: 10, MaxBackoffMS: 50, BusyWaitMS: 20000, Log: tmpLog, onProgress: (pEvent) => tmpEvents.push(pEvent) }, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.State).to.equal('ready');
								Expect(Date.now() - tmpStarted).to.be.at.least(1500);
								let tmpPuts = tmpServer.entries('put', 'v0/media.mp4');
								let tmpDropped = tmpPuts.filter((pEntry) => pEntry.Status === 'dropped');
								Expect(tmpDropped.length).to.equal(1);
								Expect(tmpDropped[0]).to.include({ Offset: 65536, StaleLockMS: 1500 });
								let tmpBusy = tmpPuts.filter((pEntry) => pEntry.Busy);
								Expect(tmpBusy.length).to.be.above(10);
								Expect(tmpBusy.every((pEntry) => pEntry.Offset === 65536 && pEntry.Status === 409)).to.equal(true);
								// The chunk went again, from the same offset, once the lock was gone -- and only then.
								let tmpResent = tmpPuts.filter((pEntry) => pEntry.Offset === 65536 && pEntry.Status === 200);
								Expect(tmpResent.length).to.equal(1);
								Expect(tmpResent[0].At).to.be.at.least(tmpDropped[0].LockReleasedAt);
								Expect(tmpPuts.map((pEntry) => pEntry.Offset).filter((pOffset) => pOffset !== 65536)).to.deep.equal([0, 131072, 196608, 262144]);
								// One warning per busy answer, each saying it waits for the server to release the file.
								let tmpWaiting = tmpLog.Lines.filter((pLine) => /^media-ladder push: v0\/media\.mp4: the server reports another upload to this file in progress .*; waiting for the server to release the file, asking again in \d+\.\d s/.test(pLine));
								Expect(tmpWaiting.length).to.equal(tmpBusy.length);
								Expect(tmpLog.Lines.filter((pLine) => /retrying in/.test(pLine)).length).to.equal(1);
								Expect(tmpLog.Lines.join('\n')).to.not.contain(TOKEN);
								Expect(tmpEvents.filter((pEvent) => pEvent.Phase === 'upload' && pEvent.Message === 'Waiting for the server to release v0/media.mp4').length).to.equal(tmpBusy.length);
								Expect(pResult.UploadedBytes).to.equal(totalBytes(tmpPackage));
								assertLive(tmpServer, pResult.AssetGUID, tmpPackage);
								fDone();
							}));
					}
				);

				test
				(
					'a file that stays busy gives up once BusyWaitMS has passed -- not after Retries -- as a Retryable error saying the lock clears and a re-run resumes',
					(fDone) =>
					{
						// Every PUT of poster.jpg is refused as busy.  BusyWaitMS comes from the constructor: it is one
						// of the per-call defaults.
						tmpServer.addFault({ Kind: 'put', Path: 'poster.jpg', Times: 1000, Action: 'status', Status: 409, Body: { Error: 'An upload to this file is already in progress.' } });
						let tmpLog = recordingLog();
						let tmpStarted = Date.now();
						new libPublisher({ Log: tmpLog, BusyWaitMS: 400 }).publish(tmpPackage.Directory,
							{ Server: tmpServer.BaseURL, Token: TOKEN, ChunkBytes: 64 * KIB, Retries: 2, BackoffMS: 10, MaxBackoffMS: 50 },
							guard(fDone, (pError, pResult) =>
							{
								let tmpElapsed = Date.now() - tmpStarted;
								Expect(pResult).to.equal(undefined);
								Expect(pError).to.be.an('error');
								Expect(pError.Retryable).to.equal(true);
								Expect(pError.message).to.match(/^Gave up sending poster\.jpg: for \d+\.\d s the server has answered that another upload to this file is in progress \(An upload to this file is already in progress\.\)\. /);
								Expect(pError.message).to.contain('An interrupted chunk\'s lock on the server clears within about 5 minutes; run the push again to resume from the last whole chunk.');
								Expect(pError.message).to.not.contain(TOKEN);
								Expect(tmpServer.entries('put', 'poster.jpg').filter((pEntry) => pEntry.Status === 409).length).to.be.above(2);
								Expect(tmpLog.Lines.filter((pLine) => /retrying in/.test(pLine))).to.deep.equal([]);
								Expect(tmpLog.Lines.filter((pLine) => /waiting for the server to release the file/.test(pLine)).length).to.be.above(2);
								Expect(tmpElapsed).to.be.at.least(400);
								Expect(tmpElapsed).to.be.below(3000);
								Expect(tmpServer.entries('commit').length).to.equal(0);
								fDone();
							}));
					}
				);

				test
				(
					'network failures still spend Retries: a chunk cut off every time gives up after Retries cut-offs, and the busy wait after each one gets a clock of its own',
					(fDone) =>
					{
						// Every send of v0/media.mp4's second chunk loses its connection, and each loss leaves the file
						// locked for 300 ms.  The busy answers between the losses spend no Retries; the losses do.
						// BusyWaitMS (500 ms) covers one 300 ms lock but not two: each wait starts its own clock.
						tmpServer.options.StaleLockMS = 300;
						tmpServer.addFault({ Kind: 'put', Path: 'v0/media.mp4', Skip: 1, Times: 1000, Action: 'drop', AfterBytes: 10000 });
						let tmpLog = recordingLog();
						publish(tmpPackage.Directory, { Retries: 3, BackoffMS: 10, MaxBackoffMS: 40, BusyWaitMS: 500, Log: tmpLog }, guard(fDone, (pError) =>
							{
								Expect(pError).to.be.an('error');
								Expect(pError.Retryable).to.equal(true);
								Expect(pError.message).to.contain('Gave up sending v0/media.mp4 after 3 consecutive failed attempts');
								Expect(pError.message).to.not.contain('another upload to this file is in progress');
								// 200 at 0, then: cut off (D), busy (b) until the lock is gone, cut off, busy, cut off.
								let tmpSequence = tmpServer.entries('put', 'v0/media.mp4').map((pEntry) => (pEntry.Status === 'dropped') ? 'D' : (pEntry.Busy ? 'b' : String(pEntry.Status))).join('');
								Expect(tmpSequence).to.match(/^200Db+Db+D$/);
								Expect(tmpLog.Lines.filter((pLine) => /retrying in/.test(pLine)).length).to.equal(2);
								Expect(tmpServer.entries('commit').length).to.equal(0);
								fDone();
							}));
					}
				);

				test
				(
					'cancel() while waiting for a busy file calls back Cancelled at once, without sitting out the backoff',
					(fDone) =>
					{
						tmpServer.addFault({ Kind: 'put', Path: 'master.m3u8', Times: 1000, Action: 'status', Status: 409, Body: { Error: 'An upload to this file is already in progress.' } });
						let tmpHandle = null;
						let tmpCancel = { At: null, Result: null };
						tmpHandle = publish(tmpPackage.Directory,
							{
								BackoffMS: 10000, MaxBackoffMS: 10000, BusyWaitMS: 60000,
								onProgress: (pEvent) =>
								{
									if (tmpCancel.At === null && /^Waiting for the server to release/.test(pEvent.Message))
									{
										tmpCancel.At = 0;
										setTimeout(() =>
											{
												tmpCancel.At = Date.now();
												tmpCancel.Result = tmpHandle.cancel();
											}, 50);
									}
								}
							}, guard(fDone, (pError, pResult) =>
							{
								Expect(pResult).to.equal(undefined);
								Expect(pError).to.be.an('error');
								Expect(pError.Cancelled).to.equal(true);
								Expect(tmpCancel.Result).to.equal(true);
								Expect(Date.now() - tmpCancel.At).to.be.below(500);
								// The one busy answer, then the (10 s) wait the cancel cut short: nothing more was sent.
								Expect(tmpServer.entries('put', 'master.m3u8').map((pEntry) => pEntry.Status)).to.deep.equal([409]);
								Expect(tmpServer.entries('commit').length).to.equal(0);
								Expect(tmpHandle.cancel()).to.equal(false);
								fDone();
							}));
					}
				);

				test
				(
					'a connection dropped mid-chunk keeps nothing of that chunk; a chunk stored but its answer lost is not re-sent',
					(fDone) =>
					{
						tmpServer.addFault({ Kind: 'put', Path: 'v0/media.mp4', Skip: 1, Action: 'drop', AfterBytes: 5000 });
						tmpServer.addFault({ Kind: 'put', Path: 'v1/media.mp4', Action: 'stored-lost' });
						publish(tmpPackage.Directory, {}, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(tmpServer.entries('put', 'v0/media.mp4').map((pEntry) => `${pEntry.Offset}:${pEntry.Status}`))
									.to.deep.equal(['0:200', '65536:dropped', '65536:200', '131072:200', '196608:200', '262144:200']);
								// The lost answer's chunk was kept by the server; the client re-HEADs and moves on.
								Expect(tmpServer.entries('put', 'v1/media.mp4').map((pEntry) => `${pEntry.Offset}:${pEntry.Status}`))
									.to.deep.equal(['0:stored-lost', '65536:200']);
								Expect(pResult.UploadedBytes).to.equal(totalBytes(tmpPackage) - 65536);
								assertLive(tmpServer, pResult.AssetGUID, tmpPackage);
								fDone();
							}));
					}
				);

				test
				(
					'a chunk slower than SlowChunkMS halves the chunk size, never below the floor, for the rest of the push',
					(fDone) =>
					{
						tmpServer.addFault({ Kind: 'put', Path: 'v0/media.mp4', Times: 3, Action: 'delay', DelayMS: 150 });
						let tmpLog = recordingLog();
						publish(tmpPackage.Directory, { SlowChunkMS: 100, Log: tmpLog }, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								let tmpSizes = tmpServer.entries('put', 'v0/media.mp4').map((pEntry) => pEntry.ContentLength);
								Expect(tmpSizes.slice(0, 5)).to.deep.equal([65536, 32768, 16384, 16384, 16384]);
								Expect(tmpSizes.reduce((pSum, pSize) => pSum + pSize, 0)).to.equal(300000);
								Expect(tmpServer.entries('put', 'v1/media.mp4').every((pEntry) => pEntry.ContentLength <= 16384)).to.equal(true);
								Expect(tmpLog.Lines.filter((pLine) => /chunks drop from/.test(pLine)).length).to.equal(2);
								assertLive(tmpServer, pResult.AssetGUID, tmpPackage);
								fDone();
							}));
					}
				);

				test
				(
					'a socket idle past SocketTimeoutMS is a retryable failure',
					(fDone) =>
					{
						tmpServer.addFault({ Kind: 'put', Path: 'v1/media.mp4', Action: 'hang' });
						publish(tmpPackage.Directory, { SocketTimeoutMS: 250 }, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(tmpServer.entries('put', 'v1/media.mp4').map((pEntry) => `${pEntry.Offset}:${pEntry.Status}`))
									.to.deep.equal(['0:hung', '0:200', '65536:200']);
								assertLive(tmpServer, pResult.AssetGUID, tmpPackage);
								fDone();
							}));
					}
				);

				test
				(
					'commit 409 Mismatched: the file is re-sent once from 0 and the commit repeated; a second mismatch fails',
					(fDone) =>
					{
						tmpServer.addFault({ Kind: 'put', Path: 'v1/media.mp4', Action: 'corrupt' });
						let tmpLog = recordingLog();
						publish(tmpPackage.Directory, { Log: tmpLog }, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.State).to.equal('ready');
								Expect(tmpServer.entries('commit').map((pEntry) => pEntry.Status)).to.deep.equal([409, 200]);
								Expect(tmpServer.entries('put', 'v1/media.mp4').map((pEntry) => pEntry.Offset)).to.deep.equal([0, 65536, 0, 65536]);
								Expect(tmpLog.Lines.join('\n')).to.contain('could not verify v1/media.mp4');
								assertLive(tmpServer, pResult.AssetGUID, tmpPackage);

								let tmpTwice = buildPackage(libPath.join(tmpScratch, 'twice'), '7e7e7e7e');
								tmpServer.addFault({ Kind: 'put', Path: 'poster.jpg', Times: 2, Action: 'corrupt' });
								let tmpCommitsBefore = tmpServer.entries('commit').length;
								publish(tmpTwice.Directory, {}, guard(fDone, (pTwiceError) =>
									{
										Expect(pTwiceError).to.be.an('error');
										Expect(pTwiceError.StatusCode).to.equal(409);
										Expect(pTwiceError.message).to.contain('commit');
										Expect(pTwiceError.message).to.contain('did not match');
										Expect(tmpServer.entries('commit').length - tmpCommitsBefore).to.equal(2);
										fDone();
									}));
							}));
					}
				);

				test
				(
					'commit 409 Missing re-sends the missing file, then commits',
					(fDone) =>
					{
						tmpServer.addFault({ Kind: 'commit', Action: 'unstage', File: 'poster.jpg' });
						publish(tmpPackage.Directory, {}, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(tmpServer.entries('commit').map((pEntry) => pEntry.Status)).to.deep.equal([409, 200]);
								Expect(tmpServer.entries('put', 'poster.jpg').length).to.equal(2);
								assertLive(tmpServer, pResult.AssetGUID, tmpPackage);
								fDone();
							}));
					}
				);

				test
				(
					'a staged file LONGER than the package\'s (left by an interrupted push of another encode with the same PackageVersion) is left for the commit to empty, then re-sent from 0',
					(fDone) =>
					{
						// Same source, same plan -> same PackageVersion, but the two encodes' bytes differ: A's master.m3u8 is 140 bytes, B's 120.
						let tmpSource = { Name: 'clip.mp4', Sha256: 'd'.repeat(64) };
						let tmpA = buildPackage(libPath.join(tmpScratch, 'oversize-a'), '5e5e5e5e', Object.assign({}, DEFAULT_SIZES, { 'master.m3u8': 140 }));
						let tmpB = buildPackage(libPath.join(tmpScratch, 'oversize-b'), '5e5e5e5e');
						// Push A stops once master.m3u8 is whole (files go in Path order; poster.jpg is next).
						tmpServer.addFault({ Kind: 'put', Path: 'poster.jpg', Action: 'status', Status: 400 });
						publish(tmpA.Directory, { Source: tmpSource }, guard(fDone, (pError) =>
							{
								Expect(pError.StatusCode).to.equal(400);
								let tmpGUID = Object.keys(tmpServer.Assets)[0];
								let tmpStagedMaster = libPath.join(tmpServer.stagingDirectory(tmpGUID, '5e5e5e5e'), 'master.m3u8');
								Expect(libFS.statSync(tmpStagedMaster).size).to.equal(140);

								// A server whose commit names the file but does not empty it: the push stops after ONE commit, saying why.
								tmpServer.addFault({ Kind: 'commit', Action: 'status', Status: 409, Body: { Error: 'Some files did not match their Sha256.', Mismatched: ['master.m3u8'] } });
								let tmpBrokenBefore = tmpServer.Log.length;
								publish(tmpB.Directory, { Source: tmpSource }, guard(fDone, (pBrokenError) =>
									{
										Expect(pBrokenError).to.be.an('error');
										Expect(pBrokenError.message).to.contain('holds 140 bytes of a 120-byte file');
										Expect(pBrokenError.message).to.contain('even after the commit');
										Expect(tmpServer.Log.slice(tmpBrokenBefore).filter((pEntry) => pEntry.Kind === 'commit').length).to.equal(1);
										Expect(libFS.statSync(tmpStagedMaster).size).to.equal(140);

										// A real commit empties it (409 Mismatched); the client sends it again from 0 and commits.
										let tmpLog = recordingLog();
										let tmpBefore = tmpServer.Log.length;
										publish(tmpB.Directory, { Source: tmpSource, Log: tmpLog }, guard(fDone, (pFinalError, pResult) =>
											{
												Expect(pFinalError).to.equal(null);
												Expect(pResult).to.include({ AssetGUID: tmpGUID, PackageVersion: '5e5e5e5e', State: 'ready' });
												let tmpAfter = tmpServer.Log.slice(tmpBefore);
												Expect(tmpAfter.filter((pEntry) => pEntry.Kind === 'commit').map((pEntry) => pEntry.Status)).to.deep.equal([409, 200]);
												// master.m3u8: HEADed (140 > 120: left alone), then after the first commit HEADed at 0 and sent.
												Expect(tmpAfter.filter((pEntry) => pEntry.Path === 'master.m3u8' || pEntry.Kind === 'commit').map((pEntry) => `${pEntry.Kind}@${pEntry.Offset}:${pEntry.Status}`))
													.to.deep.equal(['head@140:200', 'commit@null:409', 'head@0:200', 'put@0:200', 'commit@null:200']);
												Expect(tmpLog.Lines.join('\n')).to.contain('holds 140 bytes of a 120-byte file');
												assertLive(tmpServer, tmpGUID, tmpB);
												fDone();
											}));
									}));
							}));
					}
				);

				test
				(
					'a commit 409 without Missing / Mismatched is success only when the server reports the version live; a version replaced before its commit fails',
					(fDone) =>
					{
						tmpServer.options.CommitAlreadyLive = 'conflict';
						let tmpSource = { Name: 'clip.mp4', Sha256: 'e'.repeat(64) };
						let tmpW = buildPackage(libPath.join(tmpScratch, 'replaced-w'), 'aaaaaaaa');
						let tmpX = buildPackage(libPath.join(tmpScratch, 'replaced-x'), 'bbbbbbbb');
						publish(tmpW.Directory, { Source: tmpSource }, guard(fDone, (pError, pW) =>
							{
								Expect(pError).to.equal(null);
								let tmpAsset = tmpServer.Assets[pW.AssetGUID];
								// X uploads every file, but its commit fails: W stays live, X stays fully staged.
								tmpServer.addFault({ Kind: 'commit', Action: 'status', Status: 500 });
								publish(tmpX.Directory, { Source: tmpSource, Retries: 1 }, guard(fDone, (pCommitError) =>
									{
										Expect(pCommitError.message).to.contain('commit: gave up');
										Expect(tmpAsset).to.include({ PackageVersion: 'aaaaaaaa', UploadPackageVersion: 'bbbbbbbb' });

										// Re-push X: register says "ready, nothing missing". Before its commit, a register of another
										// re-encode (cccccccc) of the same source takes the upload slot and drops X's staging.
										let tmpHijacked = false;
										let tmpBefore = tmpServer.Log.length;
										publish(tmpX.Directory, { Source: tmpSource, onProgress: (pEvent) =>
											{
												if (pEvent.Phase === 'commit' && pEvent.Done === 0 && !tmpHijacked)
												{
													tmpHijacked = true;
													libFS.rmSync(tmpServer.stagingDirectory(pW.AssetGUID, 'bbbbbbbb'), { recursive: true, force: true });
													tmpAsset.UploadPackageVersion = 'cccccccc';
												}
											} }, guard(fDone, (pReplacedError, pReplaced) =>
											{
												Expect(pReplaced).to.equal(undefined);
												Expect(pReplacedError).to.be.an('error');
												Expect(pReplacedError.StatusCode).to.equal(409);
												Expect(pReplacedError.ServerError).to.equal('This package version is not being uploaded.');
												Expect(pReplacedError.message).to.contain('aaaaaaaa');
												Expect(tmpServer.Log.slice(tmpBefore).map((pEntry) => `${pEntry.Kind}:${pEntry.Status}`)).to.deep.equal(['register:200', 'commit:409', 'status:200']);
												Expect(tmpAsset.PackageVersion).to.equal('aaaaaaaa');
												Expect(libFS.existsSync(tmpServer.liveDirectory(pW.AssetGUID, 'bbbbbbbb'))).to.equal(false);

												// A server with no status route cannot confirm "already live": a bare 409 is a failure, never a guess.
												tmpServer.options.StatusRoute = false;
												publish(tmpW.Directory, { Source: tmpSource, Retries: 1 }, guard(fDone, (pUnconfirmed) =>
													{
														Expect(pUnconfirmed).to.be.an('error');
														Expect(pUnconfirmed.StatusCode).to.equal(409);
														Expect(pUnconfirmed.message).to.contain('Could not confirm');
														fDone();
													}));
											}));
									}));
							}));
					}
				);

				test
				(
					'the version closing under a running push (another push committed it) ends in the commit -- success -- not a bare "HEAD answered 409"',
					(fDone) =>
					{
						let tmpGUID = null;
						tmpServer.addFault(
							{
								Kind: 'put', Path: 'v0/media.mp4', Skip: 1, Action: 'status', Status: 409, Body: { Error: 'Already committed.' },
								onStart: () =>
								{
									// Another push of the same package finishes first: every file whole, committed.
									tmpGUID = Object.keys(tmpServer.Assets)[0];
									tmpPackage.Document.Files.forEach((pFile) =>
										{
											let tmpTarget = libPath.join(tmpServer.stagingDirectory(tmpGUID, '1a2b3c4d'), pFile.Path);
											libFS.mkdirSync(libPath.dirname(tmpTarget), { recursive: true });
											libFS.copyFileSync(libPath.join(tmpPackage.Directory, pFile.Path), tmpTarget);
										});
									Expect(tmpServer.commitNow(tmpGUID, '1a2b3c4d').Status).to.equal(200);
								}
							});
						publish(tmpPackage.Directory, {}, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult).to.include({ AssetGUID: tmpGUID, PackageVersion: '1a2b3c4d', State: 'ready' });
								Expect(tmpServer.Log.filter((pEntry) => pEntry.Path === 'v0/media.mp4' || pEntry.Kind === 'commit').map((pEntry) => `${pEntry.Kind}@${pEntry.Offset}:${pEntry.Status}`))
									.to.deep.equal(['head@0:200', 'put@0:200', 'put@65536:409', 'head@null:409', 'commit@null:200']);
								// Nothing after the closed file was sent.
								Expect(tmpServer.entries('head', 'v1/media.mp4').length).to.equal(0);
								assertLive(tmpServer, tmpGUID, tmpPackage);
								fDone();
							}));
					}
				);

				test
				(
					'the version replaced under a running push fails with the server\'s reason, not a bare "HEAD answered 409"',
					(fDone) =>
					{
						let tmpY = buildPackage(libPath.join(tmpScratch, 'replaced-y'), '9d9d9d9d');
						let tmpAsset = null;
						tmpServer.addFault(
							{
								Kind: 'put', Path: 'v0/media.mp4', Skip: 1, Action: 'status', Status: 409, Body: { Error: 'This package version is not being uploaded.' },
								onStart: () =>
								{
									// A register of another re-encode takes the upload slot and drops this version's staging.
									tmpAsset = tmpServer.Assets[Object.keys(tmpServer.Assets)[0]];
									libFS.rmSync(tmpServer.stagingDirectory(tmpAsset.GUID, '9d9d9d9d'), { recursive: true, force: true });
									tmpAsset.UploadPackageVersion = 'cccccccc';
								}
							});
						publish(tmpY.Directory, {}, guard(fDone, (pError, pResult) =>
							{
								Expect(pResult).to.equal(undefined);
								Expect(pError).to.be.an('error');
								Expect(pError.StatusCode).to.equal(409);
								Expect(pError.ServerError).to.equal('This package version is not being uploaded.');
								Expect(pError.message).to.contain('This package version is not being uploaded.');
								Expect(tmpServer.entries('head', 'v0/media.mp4').map((pEntry) => pEntry.Status)).to.deep.equal([200, 409]);
								Expect(tmpServer.entries('commit').map((pEntry) => pEntry.Status)).to.deep.equal([409]);
								Expect(libFS.existsSync(tmpServer.liveDirectory(tmpAsset.GUID, '9d9d9d9d'))).to.equal(false);
								fDone();
							}));
					}
				);

				test
				(
					'register: a 4xx fails at once with the server\'s Error; a 503 and a cut-off answer are retried; a bad token never appears in the error',
					(fDone) =>
					{
						tmpServer.addFault({ Kind: 'register', Action: 'status', Status: 403, Body: { Error: 'Media publishing is limited to this server\'s operators.' } });
						publish(tmpPackage.Directory, {}, guard(fDone, (pError) =>
							{
								Expect(pError.StatusCode).to.equal(403);
								Expect(pError.ServerError).to.equal('Media publishing is limited to this server\'s operators.');
								Expect(pError.message).to.contain('operators');
								Expect(tmpServer.entries('register').length).to.equal(1);

								tmpServer.addFault({ Kind: 'register', Action: 'status', Status: 503 });
								tmpServer.addFault({ Kind: 'register', Action: 'cutoff' });
								publish(tmpPackage.Directory, {}, guard(fDone, (pRetriedError, pResult) =>
									{
										Expect(pRetriedError).to.equal(null);
										Expect(pResult.State).to.equal('ready');
										Expect(tmpServer.entries('register').map((pEntry) => pEntry.Status)).to.deep.equal([403, 503, 'cutoff', 200]);

										publish(tmpPackage.Directory, { Token: 'exo_not-the-right-one' }, guard(fDone, (pTokenError) =>
											{
												Expect(pTokenError.StatusCode).to.equal(401);
												Expect(pTokenError.message).to.not.contain('exo_not-the-right-one');
												Expect(tmpServer.AuthorizationHeaders.slice(-1)[0]).to.equal('Bearer exo_not-the-right-one');
												fDone();
											}));
									}));
							}));
					}
				);

				test
				(
					'a server that names a file outside the package (or another version, or a bad asset id) is refused; nothing is read or sent',
					(fDone) =>
					{
						let tmpGUID = libCrypto.randomUUID();
						tmpServer.addFault({ Kind: 'register', Action: 'status', Status: 200, Body: { AssetGUID: tmpGUID, PackageVersion: '1a2b3c4d', State: 'uploading', Missing: [{ Path: '../../../etc/passwd', Bytes: 5, ReceivedBytes: 0 }] } });
						publish(tmpPackage.Directory, {}, guard(fDone, (pError) =>
							{
								Expect(pError.message).to.contain('not a file in this package');
								tmpServer.addFault({ Kind: 'register', Action: 'status', Status: 200, Body: { AssetGUID: tmpGUID, PackageVersion: 'ffffffff', State: 'uploading', Missing: [] } });
								publish(tmpPackage.Directory, {}, guard(fDone, (pVersionError) =>
									{
										Expect(pVersionError.message).to.contain('ffffffff');
										tmpServer.addFault({ Kind: 'register', Action: 'status', Status: 200, Body: { AssetGUID: '../x', PackageVersion: '1a2b3c4d', State: 'uploading', Missing: [] } });
										publish(tmpPackage.Directory, {}, guard(fDone, (pGUIDError) =>
											{
												Expect(pGUIDError.message).to.contain('AssetGUID');
												Expect(tmpServer.Log.filter((pEntry) => pEntry.Kind !== 'register').length).to.equal(0);
												fDone();
											}));
									}));
							}));
					}
				);

				test
				(
					'server text in a failure is made printable: control, C1 and bidi characters escaped, each string capped, an echoed token redacted; a JSON object where text or a number belongs is shown as JSON, never a crash',
					(fDone) =>
					{
						let tmpGUID = libCrypto.randomUUID();
						let fRegisterAnswer = (pExtra) => Object.assign({ AssetGUID: tmpGUID, PackageVersion: '1a2b3c4d', State: 'uploading', Missing: [] }, pExtra);
						let tmpCases =
						[
							// A register refused, with a hostile Error and Errors[].
							[{ Kind: 'register', Action: 'status', Status: 403, Body: { Error: HOSTILE, Errors: [HOSTILE, 7, HOSTILE] } }, {}, (pError) =>
								{
									Expect(pError.StatusCode).to.equal(403);
									Expect(pError.message).to.contain(`register: the server answered 403: denied${escaped(0x1b)}]0;TITLE-HIJACK${escaped(0x07)}${escaped(0x1b)}[2K${escaped(0x0d)}media-ladder: pushed OK${escaped(0x0a)}`);
									Expect(pError.message).to.contain(`${escaped(0x9b)}31m${escaped(0x7f)}${escaped(0x202e)}gpj.exe${escaped(0x2066)} Bearer <token> AAAA`);
									Expect(pError.ServerError).to.have.lengthOf(303);
									Expect(pError.ServerError.slice(-3)).to.equal('...');
									Expect(pError.Errors).to.have.lengthOf(3);
									Expect(pError.Errors[1]).to.equal('7');
									[pError.ServerError].concat(pError.Errors).forEach((pText, pIndex) => assertPrintable(pText, `register 403 field ${pIndex}`));
									Expect(pError.message.length).to.be.below(4 * 310);
								}],
							// Register answers that name a hostile PackageVersion, path or size.
							[{ Kind: 'register', Action: 'status', Status: 200, Body: fRegisterAnswer({ PackageVersion: HOSTILE }) }, {}, (pError) =>
								{
									Expect(pError.message).to.contain(`register: the server registered PackageVersion "denied${escaped(0x1b)}`);
								}],
							[{ Kind: 'register', Action: 'status', Status: 200, Body: fRegisterAnswer({ Missing: [{ Path: HOSTILE, Bytes: 5 }] }) }, {}, (pError) =>
								{
									Expect(pError.message).to.contain('register: the server asked for "denied');
									Expect(pError.message).to.contain('which is not a file in this package');
								}],
							[{ Kind: 'register', Action: 'status', Status: 200, Body: fRegisterAnswer({ Missing: [{ Path: 'poster.jpg', Bytes: HOSTILE }] }) }, {}, (pError) =>
								{
									Expect(pError.message).to.contain(`register: the server expects poster.jpg to be denied${escaped(0x1b)}`);
								}],
							// A PUT refused as busy with a hostile Error (BusyWaitMS 0: give up at the first busy answer).
							[{ Kind: 'put', Path: 'master.m3u8', Times: 1000, Action: 'status', Status: 409, Body: { Error: HOSTILE } }, { BusyWaitMS: 0 }, (pError) =>
								{
									Expect(pError.message).to.contain(`Gave up sending master.m3u8: for 0.0 s the server has answered that another upload to this file is in progress (denied${escaped(0x1b)}`);
								}],
							// A JSON object where text belongs (String() of it throws): Errors[] entries shown as JSON, their
							// strings still made printable and capped; an Error that is not a string is left out.
							[{ Kind: 'register', Action: 'status', Status: 403, Body: { Error: NOT_TEXT, Errors: [NOT_TEXT, { Error: HOSTILE }] } }, {}, (pError) =>
								{
									Expect(pError.StatusCode).to.equal(403);
									Expect(pError.ServerError).to.equal(null);
									Expect(pError.Errors).to.have.lengthOf(2);
									Expect(pError.Errors[0]).to.equal(NOT_TEXT_JSON);
									Expect(pError.Errors[1].indexOf('{"Error":"denied\\u001b]0;TITLE-HIJACK\\u0007')).to.equal(0);
									Expect(pError.Errors[1]).to.have.lengthOf(303);
									Expect(pError.Errors[1]).to.contain(`${escaped(0x9b)}31m${escaped(0x7f)}${escaped(0x202e)}gpj.exe${escaped(0x2066)} Bearer <token> AAAA`);
									Expect(pError.message.indexOf(`register: the server answered 403. (${NOT_TEXT_JSON}; {"Error":"denied`)).to.equal(0);
								}],
							// ... and where a number belongs (Number() of it throws): a Bytes that is such an object is a mismatch.
							[{ Kind: 'register', Action: 'status', Status: 200, Body: fRegisterAnswer({ Missing: [{ Path: 'poster.jpg', Bytes: NOT_TEXT }] }) }, {}, (pError) =>
								{
									Expect(pError.message).to.equal(`register: the server expects poster.jpg to be ${NOT_TEXT_JSON} bytes, but the package has 5000.`);
								}],
							// A commit 409 naming no files, then a status answer whose PackageVersion, State and TotalBytes are such objects.
							[[{ Kind: 'commit', Action: 'status', Status: 409, Body: { Error: 'Refused.' } },
								{ Kind: 'status', Action: 'status', Status: 200, Body: { Asset: { PackageVersion: NOT_TEXT, State: NOT_TEXT, TotalBytes: NOT_TEXT } } }], {}, (pError) =>
								{
									Expect(pError.StatusCode).to.equal(409);
									Expect(pError.message).to.equal(`commit: the server answered 409: Refused. The asset has no live version yet (state ${NOT_TEXT_JSON}).`);
									Expect(tmpServer.Log.slice(-2).map((pEntry) => `${pEntry.Kind}:${pEntry.Status}:${pEntry.Fault}`)).to.deep.equal(['commit:409:status', 'status:200:status']);
								}],
							// JSON nested too deep for JSON.stringify, as the register's PackageVersion and as the status route's State:
							// a normal error callback, never an uncaught RangeError from the response handler.
							[{ Kind: 'register', Action: 'status', Status: 200, BodyText: `{"AssetGUID":"${tmpGUID}","PackageVersion":${DEEP_JSON},"State":"uploading","Missing":[]}` }, {}, (pError) =>
								{
									Expect(pError.message).to.match(/^register: the server registered PackageVersion \[object Array\], not [0-9a-f]{8}\.$/);
								}],
							[[{ Kind: 'commit', Action: 'status', Status: 409, Body: { Error: 'Refused.' } },
								{ Kind: 'status', Action: 'status', Status: 200, BodyText: `{"Asset":{"PackageVersion":"zz","State":${DEEP_JSON}}}` }], {}, (pError) =>
								{
									Expect(pError.StatusCode).to.equal(409);
									Expect(pError.message).to.equal('commit: the server answered 409: Refused. The asset has no live version yet (state [object Array]).');
								}]
						];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								return fDone();
							}
							let tmpCase = tmpCases[pIndex];
							tmpServer.clearFaults();
							[].concat(tmpCase[0]).forEach((pFault) => tmpServer.addFault(pFault));
							let tmpLog = recordingLog();
							publish(tmpPackage.Directory, Object.assign({ Log: tmpLog }, tmpCase[1]), guard(fDone, (pError, pResult) =>
								{
									Expect(pResult, `case ${pIndex}`).to.equal(undefined);
									Expect(pError, `case ${pIndex}`).to.be.an('error');
									assertPrintable(pError.message, `case ${pIndex} message`);
									tmpLog.Lines.forEach((pLine) => assertPrintable(pLine, `case ${pIndex} log`));
									tmpCase[2](pError);
									fNext(pIndex + 1);
								}));
						};
						fNext(0);
					}
				);

				test
				(
					'server text in a successful push is made printable too: the Title a re-push kept (warning and result) and the committed State (progress and result)',
					(fDone) =>
					{
						publish(tmpPackage.Directory, { Title: HOSTILE }, guard(fDone, (pError) =>
							{
								Expect(pError).to.equal(null);
								tmpServer.addFault({ Kind: 'commit', Action: 'status', Status: 200, Body: { State: HOSTILE } });
								let tmpLog = recordingLog();
								let tmpEvents = [];
								publish(tmpPackage.Directory, { Title: 'Lake day', Log: tmpLog, onProgress: (pEvent) => tmpEvents.push(pEvent) }, guard(fDone, (pSecondError, pSecond) =>
									{
										Expect(pSecondError).to.equal(null);
										Expect(pSecond.Ignored).to.deep.equal(['Title']);
										assertPrintable(pSecond.Current.Title, 'Current.Title');
										Expect(pSecond.Current.Title).to.have.lengthOf(203);
										Expect(pSecond.Current.Title.indexOf(`denied${escaped(0x1b)}]0;TITLE-HIJACK`)).to.equal(0);
										assertPrintable(pSecond.State, 'State');
										Expect(pSecond.State.indexOf(`denied${escaped(0x1b)}`)).to.equal(0);
										Expect(tmpLog.Lines.filter((pLine) => /already exists/.test(pLine)).length).to.equal(1);
										tmpLog.Lines.forEach((pLine) => assertPrintable(pLine, 'warning'));
										tmpEvents.forEach((pEvent) => assertPrintable(pEvent.Message, `${pEvent.Phase} progress`));
										Expect(tmpEvents[tmpEvents.length - 1]).to.include({ Phase: 'done' });
										Expect(tmpEvents[tmpEvents.length - 1].Message).to.contain(`is denied${escaped(0x1b)}`);
										fDone();
									}));
							}));
					}
				);

				test
				(
					'a TotalBytes that is a JSON object (Number() of it throws) is left unknown, from the commit and from the status route; a number in a string is still taken',
					(fDone) =>
					{
						publish(tmpPackage.Directory, {}, guard(fDone, (pError, pFirst) =>
							{
								Expect(pError).to.equal(null);
								Expect(pFirst.TotalBytes).to.equal(totalBytes(tmpPackage));
								tmpServer.addFault({ Kind: 'commit', Action: 'status', Status: 200, Body: { State: 'ready', TotalBytes: NOT_TEXT } });
								publish(tmpPackage.Directory, {}, guard(fDone, (pCommitError, pFromCommit) =>
									{
										Expect(pCommitError).to.equal(null);
										Expect(pFromCommit).to.include({ AssetGUID: pFirst.AssetGUID, State: 'ready', TotalBytes: null });
										tmpServer.addFault({ Kind: 'commit', Action: 'status', Status: 409, Body: { Error: 'Already committed.' } });
										tmpServer.addFault({ Kind: 'status', Action: 'status', Status: 200, Body: { Asset: { PackageVersion: '1a2b3c4d', State: 'ready', TotalBytes: NOT_TEXT } } });
										publish(tmpPackage.Directory, {}, guard(fDone, (pStatusError, pFromStatus) =>
											{
												Expect(pStatusError).to.equal(null);
												Expect(pFromStatus).to.include({ AssetGUID: pFirst.AssetGUID, State: 'ready', TotalBytes: null });
												tmpServer.addFault({ Kind: 'commit', Action: 'status', Status: 200, Body: { State: 'ready', TotalBytes: '4096' } });
												publish(tmpPackage.Directory, {}, guard(fDone, (pStringError, pFromString) =>
													{
														Expect(pStringError).to.equal(null);
														Expect(pFromString.TotalBytes).to.equal(4096);
														Expect(tmpServer.Faults.every((pFault) => pFault.Times === 0)).to.equal(true);
														fDone();
													}));
											}));
									}));
							}));
					}
				);

				test
				(
					'refused before contacting the server: <PV>.partial, <PV>.lock, a missing directory, a non-package name, a damaged package, bad options',
					(fDone) =>
					{
						let tmpOut = libPath.join(tmpScratch, 'refusals');
						libFS.mkdirSync(tmpOut, { recursive: true });
						let tmpPartial = copyDirectory(tmpPackage.Directory, libPath.join(tmpOut, '1a2b3c4d.partial'));
						libFS.writeFileSync(libPath.join(tmpOut, '1a2b3c4d.lock'), '{}');
						let tmpOddName = copyDirectory(tmpPackage.Directory, libPath.join(tmpOut, 'latest'));
						let tmpDamaged = copyDirectory(tmpPackage.Directory, libPath.join(tmpOut, 'damaged', '1a2b3c4d'));
						let tmpMedia = libPath.join(tmpDamaged, 'v1', 'media.mp4');
						let tmpBytes = libFS.readFileSync(tmpMedia);
						tmpBytes[100] = tmpBytes[100] ^ 0xFF;
						libFS.writeFileSync(tmpMedia, tmpBytes);

						let tmpCases =
						[
							[tmpPartial, {}, (pError) => { Expect(pError.Refused).to.equal(true); Expect(pError.message).to.contain('unfinished encode'); }],
							[libPath.join(tmpOut, '1a2b3c4d.lock'), {}, (pError) => { Expect(pError.Refused).to.equal(true); Expect(pError.message).to.contain('lock file'); }],
							[libPath.join(tmpOut, 'ffffffff'), {}, (pError) => { Expect(pError.Refused).to.equal(true); Expect(pError.message).to.contain('not found'); }],
							[tmpOddName, {}, (pError) => { Expect(pError.message).to.contain('not a package directory'); }],
							[tmpDamaged, {}, (pError) => { Expect(pError.Damaged).to.equal(true); Expect(pError.Problems).to.deep.equal(['v1/media.mp4 does not match its Sha256']); }],
							[tmpPackage.Directory, { Token: '' }, (pError) => { Expect(pError.message).to.contain('token is required'); }],
							[tmpPackage.Directory, { Token: 'two words' }, (pError) => { Expect(pError.message).to.contain('cannot be sent in a header'); Expect(pError.message).to.not.contain('two words'); }],
							[tmpPackage.Directory, { Server: 'ftp://example' }, (pError) => { Expect(pError.message).to.contain('http'); }],
							[tmpPackage.Directory, { Sensitivity: 'secret' }, (pError) => { Expect(pError.message).to.contain('Sensitivity'); }],
							[tmpPackage.Directory, { Source: { Sha256: 'nope' } }, (pError) => { Expect(pError.message).to.contain('Sha256'); }],
							[tmpPackage.Directory, { Source: libPath.join(tmpOut, 'no-such-original.mov') }, (pError) => { Expect(pError.message).to.contain('Source file not found'); }]
						];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								Expect(tmpServer.Log.length).to.equal(0);
								return fDone();
							}
							let tmpCase = tmpCases[pIndex];
							publish(tmpCase[0], tmpCase[1], guard(fDone, (pError, pResult) =>
								{
									Expect(pError, `case ${pIndex}`).to.be.an('error');
									Expect(pResult).to.equal(undefined);
									tmpCase[2](pError);
									fNext(pIndex + 1);
								}));
						};
						fNext(0);
					}
				);

				test
				(
					'cancel() drops the in-flight chunk (the server keeps whole chunks) and calls back Cancelled; the next push resumes',
					(fDone) =>
					{
						let tmpHandle = null;
						tmpServer.addFault({ Kind: 'put', Path: 'v0/media.mp4', Skip: 2, Action: 'hang', onStart: () => { setTimeout(() => { tmpHandle.cancel(); }, 30); } });
						let tmpEvents = [];
						tmpHandle = publish(tmpPackage.Directory, { onProgress: (pEvent) => tmpEvents.push(pEvent) }, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.be.an('error');
								Expect(pError.Cancelled).to.equal(true);
								Expect(pResult).to.equal(undefined);
								Expect(tmpHandle.cancel()).to.equal(false);
								Expect(tmpHandle.abort()).to.equal(false);
								Expect(tmpEvents.some((pEvent) => pEvent.Phase === 'commit')).to.equal(false);
								let tmpGUID = Object.keys(tmpServer.Assets)[0];
								Expect(libFS.statSync(libPath.join(tmpServer.stagingDirectory(tmpGUID, '1a2b3c4d'), 'v0', 'media.mp4')).size).to.equal(131072);

								publish(tmpPackage.Directory, {}, guard(fDone, (pResumeError, pResumed) =>
									{
										Expect(pResumeError).to.equal(null);
										Expect(pResumed.AssetGUID).to.equal(tmpGUID);
										Expect(pResumed.UploadedBytes).to.equal((300000 - 131072) + 300 + 100000);
										assertLive(tmpServer, tmpGUID, tmpPackage);
										fDone();
									}));
							}));
						Expect(tmpHandle.cancel).to.be.a('function');
					}
				);

				test
				(
					'abort() calls back at once (synchronously, Cancelled); later cancel/abort calls are no-ops',
					(fDone) =>
					{
						let tmpHandle = null;
						let tmpState = { InsideAbort: false, CalledBack: 0, AbortResult: null };
						tmpServer.addFault({ Kind: 'put', Path: 'v0/media.mp4', Action: 'hang', onStart: () =>
							{
								setTimeout(() =>
									{
										tmpState.InsideAbort = true;
										tmpState.AbortResult = tmpHandle.abort();
										tmpState.InsideAbort = false;
										setTimeout(guard(fDone, () =>
											{
												Expect(tmpState.AbortResult).to.equal(true);
												Expect(tmpState.CalledBack).to.equal(1);
												Expect(tmpHandle.abort()).to.equal(false);
												Expect(tmpHandle.cancel()).to.equal(false);
												fDone();
											}), 50);
									}, 10);
							} });
						tmpHandle = publish(tmpPackage.Directory, {}, (pError) =>
							{
								tmpState.CalledBack++;
								if (!pError || !pError.Cancelled || !tmpState.InsideAbort)
								{
									return fDone(new Error(`abort did not call back synchronously with a cancel (${pError && pError.message})`));
								}
							});
					}
				);

				test
				(
					'a Source block is sent as given; a new PackageVersion of the same source uploads beside the live one, and a fully-staged re-encode still commits',
					(fDone) =>
					{
						let tmpSource = { Name: 'DJI_0001.MP4', Sha256: 'a'.repeat(64), Transfer: 'hlg', CaptureDate: '2024-05-01T10:00:00Z' };
						let tmpNext = buildPackage(libPath.join(tmpScratch, 'reencode'), 'cafef00d');
						publish(tmpPackage.Directory, { Source: tmpSource }, guard(fDone, (pError, pFirst) =>
							{
								Expect(pError).to.equal(null);
								Expect(tmpServer.Registrations[0].Source).to.deep.equal({ Name: 'DJI_0001.MP4', Sha256: 'a'.repeat(64), Transfer: 'hlg', CaptureDate: '2024-05-01T10:00:00.000Z' });
								Expect(pFirst.Source).to.deep.equal(tmpServer.Registrations[0].Source);

								// The re-encode uploads but its commit keeps failing: the push gives up with everything staged.
								tmpServer.addFault({ Kind: 'commit', Action: 'status', Status: 500, Times: 100 });
								publish(tmpNext.Directory, { Source: tmpSource, Retries: 2 }, guard(fDone, (pCommitError) =>
									{
										Expect(pCommitError).to.be.an('error');
										Expect(pCommitError.message).to.contain('commit: gave up after 2');
										let tmpAsset = tmpServer.Assets[pFirst.AssetGUID];
										Expect(tmpAsset).to.include({ State: 'ready', PackageVersion: '1a2b3c4d', UploadPackageVersion: 'cafef00d' });

										// Re-run: register answers "ready, nothing missing" for the staged version; the client
										// still commits it (it is not the live one), and it becomes current.
										tmpServer.clearFaults();
										let tmpBefore = tmpServer.Log.length;
										publish(tmpNext.Directory, { Source: tmpSource }, guard(fDone, (pFinalError, pFinal) =>
											{
												Expect(pFinalError).to.equal(null);
												Expect(pFinal).to.include({ AssetGUID: pFirst.AssetGUID, PackageVersion: 'cafef00d', State: 'ready', UploadedFiles: 0 });
												Expect(tmpServer.Log.slice(tmpBefore).map((pEntry) => `${pEntry.Kind}:${pEntry.Status}`)).to.deep.equal(['register:200', 'commit:200']);
												Expect(tmpAsset).to.include({ PackageVersion: 'cafef00d', PreviousPackageVersion: '1a2b3c4d', UploadPackageVersion: '' });
												assertLive(tmpServer, pFirst.AssetGUID, tmpNext);
												fDone();
											}));
									}));
							}));
					}
				);

				test
				(
					'Server, Token and tuning keys given to the constructor are per-call defaults (the call wins)',
					(fDone) =>
					{
						let tmpPublisher = new libPublisher({ Log: recordingLog(), Server: tmpServer.BaseURL, Token: 'exo_wrong', ChunkBytes: 100 * KIB });
						tmpPublisher.publish(tmpPackage.Directory, { Token: TOKEN }, guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResult.State).to.equal('ready');
								Expect(tmpServer.entries('put', 'v0/media.mp4').map((pEntry) => pEntry.ContentLength)).to.deep.equal([102400, 102400, 300000 - 204800]);
								Expect(tmpServer.AuthorizationHeaders.every((pHeader) => pHeader === `Bearer ${TOKEN}`)).to.equal(true);
								fDone();
							}));
					}
				);

				test
				(
					'works as a Fable service: RetoldMediaLadder.push with a base path and a custom prefix',
					(fDone) =>
					{
						let libFable = require('fable');
						let tmpFable = new libFable({ Product: 'PublisherTest', LogStreams: [{ level: 'fatal' }] });
						tmpFable.addAndInstantiateServiceType('RetoldMediaLadder', libRetoldMediaLadder);
						let tmpPrefixed = new libFakeServer({ Root: libFS.mkdtempSync(libPath.join(tmpScratch, 'prefixed-')), Token: TOKEN, Prefix: '/media/api/Ingest' });
						tmpPrefixed.start(() =>
							{
								tmpFable.RetoldMediaLadder.push(tmpPackage.Directory, { Server: `${tmpPrefixed.BaseURL}/media/`, Token: TOKEN, Prefix: '/api/Ingest/', ChunkBytes: 128 * KIB }, (pError, pResult) =>
									{
										tmpPrefixed.stop(() =>
											{
												try
												{
													Expect(pError).to.equal(null);
													Expect(pResult.State).to.equal('ready');
													Expect(tmpFable.RetoldMediaLadder.Publisher.fable).to.equal(tmpFable);
													assertLive(tmpPrefixed, pResult.AssetGUID, tmpPackage);
												}
												catch (pAssertError)
												{
													return fDone(pAssertError);
												}
												return fDone();
											});
									});
							});
					}
				);
			}
		);

		suite
		(
			'the CLI: --version, --help, no arguments, the macOS-only --fast, flag values and the plan command line',
			function ()
			{
				/** Run the CLI in a process whose process.platform reads pPlatform (a preload swaps it). */
				let fRunAs = (pPlatform, pArguments, pEnvironment, fCallback) =>
				{
					if (typeof pEnvironment === 'function')
					{
						fCallback = pEnvironment;
						pEnvironment = {};
					}
					let tmpPreload = libPath.join(tmpScratch, `pretend-${pPlatform}.js`);
					libFS.writeFileSync(tmpPreload, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(pPlatform)} });\n`);
					return libChildProcess.execFile(process.execPath, ['-r', tmpPreload, BIN].concat(pArguments), { env: cleanEnvironment(pEnvironment) }, (pError, pStdout, pStderr) =>
						{
							return fCallback((pError && typeof pError.code === 'number') ? pError.code : (pError ? -1 : 0), String(pStdout), String(pStderr));
						});
				};

				/**
				 * The environment for a stand-in ffprobe that answers every probe with a fixture (so any file
				 * "probes" as that source) and a stand-in ffmpeg that lists everything the ladder can use, at a
				 * path with a space in it.
				 */
				let fStandIns = () =>
				{
					let tmpDirectory = libPath.join(tmpScratch, 'stand ins');
					let tmpFFprobe = libPath.join(tmpDirectory, 'ffprobe');
					let tmpFFmpeg = libPath.join(tmpDirectory, 'ffmpeg');
					if (!libFS.existsSync(tmpFFprobe))
					{
						libFS.mkdirSync(tmpDirectory, { recursive: true });
						libFS.writeFileSync(tmpFFprobe, [`#!${process.execPath}`, `process.stdout.write(${JSON.stringify(libFS.readFileSync(libPath.join(__dirname, 'fixtures', 'source-720p.json'), 'utf8'))});`, ''].join('\n'));
						libFS.chmodSync(tmpFFprobe, 0o755);
						libStandInFFmpeg.writeStandInFFmpeg(tmpFFmpeg);
					}
					return { FFprobe: tmpFFprobe, FFmpeg: tmpFFmpeg, Environment: { RETOLD_MEDIA_LADDER_FFPROBE: tmpFFprobe, RETOLD_MEDIA_LADDER_FFMPEG: tmpFFmpeg } };
				};

				test
				(
					'--version and -V print just the version on stdout and exit 0, with or without a command',
					(fDone) =>
					{
						let tmpVersion = require('../package.json').version;
						let tmpCases = [['--version'], ['-V'], ['encode', '--version'], ['plan', 'in.mp4', '-V'], ['push', '--version']];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								return fDone();
							}
							runCLI(tmpCases[pIndex], {}, guard(fDone, (pCode, pStdout, pStderr) =>
								{
									Expect(pCode, `${tmpCases[pIndex].join(' ')}: ${pStderr}`).to.equal(0);
									Expect(pStdout).to.equal(`${tmpVersion}\n`);
									Expect(pStderr).to.equal('');
									fNext(pIndex + 1);
								}));
						};
						fNext(0);
					}
				);

				test
				(
					'--help and -h print the usage on stdout and exit 0; no command is a usage error: the usage on stderr, exit 2',
					(fDone) =>
					{
						runCLI(['--help'], {}, guard(fDone, (pCode, pStdout, pStderr) =>
							{
								Expect(pCode, pStderr).to.equal(0);
								Expect(pStderr).to.equal('');
								Expect(pStdout).to.contain('Usage:');
								Expect(pStdout.split('\n')).to.include('  --fast                  encode with h264_videotoolbox instead of x264 (macOS only)');
								Expect(pStdout.split('\n')).to.include('  -V, --version           print the version and exit');
								// Every value --preset, --profile and --segment-seconds accepts is in the usage.
								Expect(pStdout).to.contain(
									'  --preset <name>         x264 preset (default medium): ultrafast, superfast, veryfast,\n'
									+ '                          faster, fast, medium, slow, slower, veryslow or placebo\n');
								Expect(pStdout.split('\n')).to.include('  --profile <name>        standard (default) or hq (caps 1080p at 7800k, not 6000k)');
								Expect(pStdout.split('\n')).to.include('  --segment-seconds <n>   HLS segment length in whole seconds, 1 to 60 (default 6)');
								runCLI(['encode', '-h'], {}, guard(fDone, (pHelpCode, pHelpStdout, pHelpStderr) =>
									{
										Expect(pHelpCode, pHelpStderr).to.equal(0);
										Expect(pHelpStdout).to.equal(pStdout);
										Expect(pHelpStderr).to.equal('');
										runCLI([], {}, guard(fDone, (pBareCode, pBareStdout, pBareStderr) =>
											{
												Expect(pBareCode).to.equal(2);
												Expect(pBareStdout).to.equal('');
												Expect(pBareStderr).to.equal(pStdout);
												runCLI(['--verbose'], {}, guard(fDone, (pFlagsCode, pFlagsStdout, pFlagsStderr) =>
													{
														Expect(pFlagsCode).to.equal(2);
														Expect(pFlagsStdout).to.equal('');
														Expect(pFlagsStderr).to.equal(pStdout);
														fDone();
													}));
											}));
									}));
							}));
					}
				);

				test
				(
					'--fast is a usage error (exit 2) anywhere but macOS, before any probing; on macOS it is accepted',
					(fDone) =>
					{
						let libCLI = require('../bin/media-ladder.js');
						let tmpReason = 'Fast encoding (--fast / Fast: true) uses h264_videotoolbox, which is only available on macOS.';
						Expect(() => libCLI.ladderOptions({ '--fast': true }, 'linux')).to.throw(tmpReason);
						Expect(() => libCLI.ladderOptions({ '--fast': true }, 'win32')).to.throw(tmpReason);
						Expect(libCLI.ladderOptions({ '--fast': true, '--out': 'packages' }, 'darwin')).to.deep.equal({ Fast: true, OutputDirectory: 'packages' });
						Expect(libCLI.ladderOptions({ '--out': 'packages' }, 'linux')).to.deep.equal({ OutputDirectory: 'packages' });

						let tmpOutput = libPath.join(tmpScratch, 'fast-out');
						let tmpMissing = libPath.join(tmpScratch, 'no-such-source.mp4');
						fRunAs('linux', ['encode', tmpMissing, '--out', tmpOutput, '--fast'], guard(fDone, (pCode, pStdout, pStderr) =>
							{
								Expect(pCode, pStderr).to.equal(2);
								Expect(pStderr).to.equal(`media-ladder: ${tmpReason}\n`);
								Expect(pStdout).to.equal('');
								Expect(libFS.existsSync(tmpOutput)).to.equal(false);
								fRunAs('win32', ['plan', tmpMissing, '--fast'], guard(fDone, (pPlanCode, pPlanStdout, pPlanStderr) =>
									{
										Expect(pPlanCode, pPlanStderr).to.equal(2);
										Expect(pPlanStderr).to.equal(`media-ladder: ${tmpReason}\n`);
										Expect(pPlanStdout).to.equal('');
										// On macOS the flag passes: the run gets as far as the (missing) source.
										fRunAs('darwin', ['plan', tmpMissing, '--fast'], guard(fDone, (pMacCode, pMacStdout, pMacStderr) =>
											{
												Expect(pMacCode, pMacStderr).to.equal(1);
												Expect(pMacStderr).to.contain('Input file not found');
												Expect(pMacStderr).to.not.contain('only available on macOS');
												Expect(pMacStdout).to.equal('');
												fDone();
											}));
									}));
							}));
					}
				);

				test
				(
					'a malformed --segment-seconds, --preset or --profile is a usage error (exit 2) naming the flag, before any probing; a missing file stays a failure (exit 1)',
					(fDone) =>
					{
						let libCLI = require('../bin/media-ladder.js');
						let tmpPresets = 'ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow, placebo';
						let tmpBad =
						[
							[{ '--segment-seconds': '61' }, '--segment-seconds must be a whole number from 1 to 60 (got 61).'],
							[{ '--segment-seconds': '2.5' }, '--segment-seconds must be a whole number from 1 to 60 (got 2.5).'],
							[{ '--segment-seconds': '0' }, '--segment-seconds must be a whole number from 1 to 60 (got 0).'],
							[{ '--segment-seconds': 'six' }, '--segment-seconds must be a whole number from 1 to 60 (got six).'],
							[{ '--segment-seconds': '6.5' }, '--segment-seconds must be a whole number from 1 to 60 (got 6.5).'],
							[{ '--segment-seconds': '0x6' }, '--segment-seconds must be a whole number from 1 to 60 (got 0x6).'],
							[{ '--segment-seconds': '6e0' }, '--segment-seconds must be a whole number from 1 to 60 (got 6e0).'],
							[{ '--segment-seconds': '60.01' }, '--segment-seconds must be a whole number from 1 to 60 (got 60.01).'],
							[{ '--preset': 'bogus' }, `--preset must be one of ${tmpPresets} (got bogus).`],
							// A value is echoed printable: it can hold anything.
							[{ '--preset': 'x\x1b[2Ky' }, `--preset must be one of ${tmpPresets} (got x\\u001b[2Ky).`],
							[{ '--profile': 'foo' }, '--profile must be one of standard, hq (got foo).']
						];
						tmpBad.forEach((pCase) =>
							{
								Expect(() => libCLI.ladderOptions(pCase[0], 'darwin'), pCase[1]).to.throw(pCase[1]);
							});
						Expect(libCLI.ladderOptions({ '--segment-seconds': '1', '--preset': 'placebo', '--profile': 'standard' }, 'linux')).to.deep.equal({ SegmentSeconds: 1, Preset: 'placebo', Profile: 'standard' });
						Expect(libCLI.ladderOptions({ '--segment-seconds': '60', '--preset': 'ultrafast', '--profile': 'hq' }, 'linux')).to.deep.equal({ SegmentSeconds: 60, Preset: 'ultrafast', Profile: 'hq' });
						// A whole number written with a zero fraction is still one (1.0.0 took "6.0").
						Expect(libCLI.ladderOptions({ '--segment-seconds': '6.0' }, 'linux')).to.deep.equal({ SegmentSeconds: 6 });
						Expect(libCLI.ladderOptions({ '--segment-seconds': '060.00' }, 'linux')).to.deep.equal({ SegmentSeconds: 60 });

						let tmpStandIns = fStandIns();
						let tmpSource = libPath.join(tmpScratch, 'flag-value-source.mp4');
						libFS.writeFileSync(tmpSource, 'stands in for a video: the stand-in ffprobe answers for it');
						let tmpOutput = libPath.join(tmpScratch, 'flag-value-out');
						let tmpRuns =
						[
							[['plan', tmpSource, '--segment-seconds', '61'], 2, 'media-ladder: --segment-seconds must be a whole number from 1 to 60 (got 61).\n'],
							[['encode', tmpSource, '--out', tmpOutput, '--segment-seconds=2.5'], 2, 'media-ladder: --segment-seconds must be a whole number from 1 to 60 (got 2.5).\n'],
							[['encode', tmpSource, '--out', tmpOutput, '--preset', 'bogus'], 2, `media-ladder: --preset must be one of ${tmpPresets} (got bogus).\n`],
							[['plan', tmpSource, '--profile', 'foo'], 2, 'media-ladder: --profile must be one of standard, hq (got foo).\n'],
							// Runtime failures stay exit 1: a missing source, a missing LUT.
							[['plan', libPath.join(tmpScratch, 'no-such-source.mp4'), '--segment-seconds', '60'], 1, `media-ladder: Input file not found: ${libPath.join(tmpScratch, 'no-such-source.mp4')}\n`],
							[['plan', tmpSource, '--lut', libPath.join(tmpScratch, 'no-such.cube')], 1, `media-ladder: LUT file not found: ${libPath.join(tmpScratch, 'no-such.cube')}\n`]
						];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpRuns.length)
							{
								Expect(libFS.existsSync(tmpOutput)).to.equal(false);
								return fDone();
							}
							let tmpRun = tmpRuns[pIndex];
							fRunAs('darwin', tmpRun[0], tmpStandIns.Environment, guard(fDone, (pCode, pStdout, pStderr) =>
								{
									Expect(pCode, `${tmpRun[0].join(' ')}: ${pStderr}`).to.equal(tmpRun[1]);
									Expect(pStderr).to.equal(tmpRun[2]);
									Expect(pStdout).to.equal('');
									fNext(pIndex + 1);
								}));
						};
						fNext(0);
					}
				);

				test
				(
					'probe ignores --fast on every platform (it never encodes); plan and encode still refuse it off macOS',
					(fDone) =>
					{
						let tmpStandIns = fStandIns();
						let tmpSource = libPath.join(tmpScratch, 'probe-fast-source.mp4');
						libFS.writeFileSync(tmpSource, 'stands in for a video: the stand-in ffprobe answers for it');
						let tmpPlatforms = ['linux', 'win32', 'darwin'];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpPlatforms.length)
							{
								return fRunAs('linux', ['plan', tmpSource, '--fast'], tmpStandIns.Environment, guard(fDone, (pPlanCode, pPlanStdout, pPlanStderr) =>
									{
										Expect(pPlanCode, pPlanStderr).to.equal(2);
										Expect(pPlanStderr).to.equal('media-ladder: Fast encoding (--fast / Fast: true) uses h264_videotoolbox, which is only available on macOS.\n');
										Expect(pPlanStdout).to.equal('');
										fDone();
									}));
							}
							fRunAs(tmpPlatforms[pIndex], ['probe', tmpSource, '--fast'], tmpStandIns.Environment, guard(fDone, (pCode, pStdout, pStderr) =>
								{
									Expect(pCode, `${tmpPlatforms[pIndex]}: ${pStderr}`).to.equal(0);
									Expect(pStderr).to.equal('');
									let tmpSummary = JSON.parse(pStdout);
									Expect(tmpSummary.Video.DisplayWidth).to.equal(1280);
									Expect(tmpSummary.Raw).to.equal(undefined);
									fNext(pIndex + 1);
								}));
						};
						fNext(0);
					}
				);

				test
				(
					'plan prints the ffmpeg command line for the platform\'s shell: cmd.exe quoting on Windows, POSIX quoting elsewhere',
					(fDone) =>
					{
						let tmpStandIns = fStandIns();
						let tmpSource = libPath.join(tmpScratch, 'plan-command source (1).mp4');
						libFS.writeFileSync(tmpSource, 'stands in for a video: the stand-in ffprobe answers for it');
						let tmpLut = libPath.join(tmpScratch, "it's,[odd];.cube");
						libFS.writeFileSync(tmpLut, 'LUT_3D_SIZE 2\n');
						let fPlan = (pPlatform, fCheck) =>
						{
							fRunAs(pPlatform, ['plan', tmpSource, '--lut', tmpLut], tmpStandIns.Environment, guard(fDone, (pCode, pStdout, pStderr) =>
								{
									Expect(pCode, `${pPlatform}: ${pStderr}`).to.equal(0);
									Expect(pStderr).to.equal('');
									let tmpOutput = JSON.parse(pStdout);
									let tmpArguments = libLadderPlanner.buildEncodeArguments(tmpOutput.Plan, tmpSource);
									Expect(tmpOutput.Plan.Colour.Lut.File).to.equal(tmpLut);
									fCheck(tmpOutput.Command, tmpArguments);
								}));
						};
						fPlan('win32', (pWindowsCommand, pWindowsArguments) =>
							{
								Expect(pWindowsCommand).to.equal(libLadderPlanner.formatCommandLine(tmpStandIns.FFmpeg, pWindowsArguments, 'win32'));
								Expect(pWindowsCommand).to.not.equal(libLadderPlanner.formatCommandLine(tmpStandIns.FFmpeg, pWindowsArguments));
								Expect(pWindowsCommand.indexOf(`"${tmpStandIns.FFmpeg}" `)).to.equal(0);
								Expect(pWindowsCommand).to.contain(` -i "${tmpSource}" `);
								Expect(pWindowsCommand).to.contain(' -force_key_frames "expr:gte(t,n_forced*2)" ');
								fPlan('linux', (pPosixCommand, pPosixArguments) =>
									{
										Expect(pPosixCommand).to.equal(libLadderPlanner.formatCommandLine(tmpStandIns.FFmpeg, pPosixArguments));
										Expect(pPosixCommand.indexOf(`'${tmpStandIns.FFmpeg}' `)).to.equal(0);
										Expect(pPosixCommand).to.contain(" -force_key_frames 'expr:gte(t,n_forced*2)' ");
										fDone();
									});
							});
					}
				);

				test
				(
					'plan prints JSON, so the README says to decode its Command string before pasting it: the decodings it gives recover the line, which as printed is JSON-escaped',
					(fDone) =>
					{
						let tmpReadme = libFS.readFileSync(libPath.join(__dirname, '..', 'README.md'), 'utf8');
						Expect(libFS.readFileSync(libPath.join(__dirname, '..', 'docs', 'README.md'), 'utf8'), 'docs/README.md is a copy of README.md').to.equal(tmpReadme);
						// The command-line section's paragraph on what plan prints.
						let tmpParagraphs = tmpReadme.split(/\n[ \t]*\n/).filter((pBlock) => /^`plan` /.test(pBlock));
						Expect(tmpParagraphs).to.have.length(1);
						let tmpParagraph = tmpParagraphs[0].replace(/\s+/g, ' ');
						let tmpJq = /`media-ladder plan \S+ \| jq -r \.([A-Za-z]+)`/.exec(tmpParagraph);
						let tmpPowerShell = /`\(media-ladder plan \S+ \| ConvertFrom-Json\)\.([A-Za-z]+)`/.exec(tmpParagraph);
						Expect(tmpJq, `the README gives a jq decoding: ${tmpParagraph}`).to.not.equal(null);
						Expect(tmpPowerShell, `the README gives a PowerShell decoding: ${tmpParagraph}`).to.not.equal(null);
						Expect(tmpParagraph).to.contain('in a `.bat` or `.cmd` file');
						let tmpStandIns = fStandIns();
						let tmpSource = libPath.join(tmpScratch, 'paste source (2).mp4');
						libFS.writeFileSync(tmpSource, 'stands in for a video: the stand-in ffprobe answers for it');
						fRunAs('win32', ['plan', tmpSource], tmpStandIns.Environment, guard(fDone, (pCode, pStdout, pStderr) =>
							{
								Expect(pCode, pStderr).to.equal(0);
								let tmpOutput = JSON.parse(pStdout);
								let tmpLine = libLadderPlanner.formatCommandLine(tmpStandIns.FFmpeg, libLadderPlanner.buildEncodeArguments(tmpOutput.Plan, tmpSource), 'win32');
								// What both of the README's decodings read is the cmd.exe line ...
								Expect(tmpOutput[tmpJq[1]]).to.equal(tmpLine);
								Expect(tmpOutput[tmpPowerShell[1]]).to.equal(tmpLine);
								// ... which is not on stdout as it stands: JSON escaped its quotes (the spaced ffmpeg path,
								// the input, -force_key_frames' parentheses), so pasting the printed text would break it.
								Expect(tmpLine).to.contain(' -force_key_frames "expr:gte(t,n_forced*2)" ');
								Expect(pStdout).to.not.contain(tmpLine);
								Expect(pStdout).to.contain(JSON.stringify(tmpLine));
								// The ladder's v%v paths are why a .bat or .cmd file must double each %.
								Expect(tmpLine).to.contain(' v%v/media.mp4 ');
								// The README's own pipeline, where jq is installed: jq -r prints the line itself.
								let tmpJqProcess = libChildProcess.execFile('jq', ['-r', `.${tmpJq[1]}`], guard(fDone, (pJqError, pJqStdout) =>
									{
										if (pJqError && pJqError.code === 'ENOENT')
										{
											return fDone();
										}
										Expect(pJqError).to.equal(null);
										Expect(String(pJqStdout)).to.equal(`${tmpLine}\n`);
										fDone();
									}));
								tmpJqProcess.stdin.on('error', () => {});
								tmpJqProcess.stdin.end(pStdout);
							}));
					}
				);
			}
		);

		suite
		(
			'the push CLI',
			function ()
			{
				let tmpServer = null;

				setup
				(
					(fDone) =>
					{
						tmpServer = new libFakeServer({ Root: libFS.mkdtempSync(libPath.join(tmpScratch, 'cli-server-')), Token: TOKEN });
						tmpServer.start(fDone);
					}
				);

				teardown
				(
					(fDone) =>
					{
						tmpServer.stop(fDone);
					}
				);

				test
				(
					'pushOptions: flags win over the environment; bad values are usage errors that never echo the token',
					() =>
					{
						let libCLI = require('../bin/media-ladder.js');
						let tmpEnvironment = { MEDIA_LADDER_SERVER: 'http://env.example', MEDIA_LADDER_TOKEN: 'env-token' };
						Expect(libCLI.pushOptions({}, tmpEnvironment)).to.deep.equal({ Server: 'http://env.example', Token: 'env-token', Prefix: '/1.0/MediaIngest' });
						Expect(libCLI.pushOptions({ '--server': 'https://flag.example', '--token': 'flag-token', '--prefix': '/x/Ingest', '--chunk-mib': '8', '--retries': '0', '--sensitivity': 'conversation', '--title': 'T', '--description': 'D', '--source': 'a.mov' }, tmpEnvironment))
							.to.deep.equal({ Server: 'https://flag.example', Token: 'flag-token', Prefix: '/x/Ingest', ChunkBytes: 8 * MIB, Retries: 0, Sensitivity: 'conversation', Title: 'T', Description: 'D', Source: 'a.mov' });
						let fUsage = (pFlags, pEnvironment) =>
						{
							try
							{
								libCLI.pushOptions(pFlags, pEnvironment || tmpEnvironment);
							}
							catch (pError)
							{
								Expect(pError.message).to.not.contain('env-token');
								return pError.message;
							}
							throw new Error('no usage error');
						};
						Expect(fUsage({}, { MEDIA_LADDER_TOKEN: 'env-token' })).to.contain('--server');
						Expect(fUsage({}, { MEDIA_LADDER_SERVER: 'http://x' })).to.contain('--token');
						Expect(fUsage({ '--sensitivity': 'secret' })).to.contain('--sensitivity');
						Expect(fUsage({ '--chunk-mib': '0' })).to.contain('--chunk-mib');
						Expect(fUsage({ '--chunk-mib': '1.5' })).to.contain('--chunk-mib');
						Expect(fUsage({ '--retries': '-1' })).to.contain('--retries');
						Expect(fUsage({ '--prefix': 'nope' })).to.contain('prefix');
						Expect(fUsage({ '--server': 'https://u:p@x' })).to.contain('credentials');
					}
				);

				test
				(
					'usage errors exit 2: no directory, no server, no token, a bad flag value, an encode flag on push, a push flag on encode',
					(fDone) =>
					{
						let tmpCases =
						[
							[['push'], {}, 'needs exactly one package directory'],
							[['push', tmpPackage.Directory, 'extra'], {}, 'needs exactly one package directory'],
							[['push', tmpPackage.Directory], { MEDIA_LADDER_TOKEN: TOKEN }, 'push needs --server'],
							[['push', tmpPackage.Directory, '--server', tmpServer.BaseURL], {}, 'push needs --token'],
							[['push', tmpPackage.Directory, '--sensitivity', 'secret'], { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN }, '--sensitivity must be'],
							[['push', tmpPackage.Directory, '--chunk-mib', 'lots'], { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN }, '--chunk-mib needs'],
							[['push', tmpPackage.Directory, '--retries', 'x'], { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN }, '--retries needs'],
							[['push', tmpPackage.Directory, '--out', '/tmp/x'], { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN }, '--out is not a push flag'],
							[['encode', 'in.mp4', '--out', '/tmp/x', '--server', tmpServer.BaseURL], {}, '--server is only for push'],
							[['push', tmpPackage.Directory, '--title'], {}, '--title needs a value']
						];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								Expect(tmpServer.Log.length).to.equal(0);
								return fDone();
							}
							let tmpCase = tmpCases[pIndex];
							runCLI(tmpCase[0], tmpCase[1], guard(fDone, (pCode, pStdout, pStderr) =>
								{
									Expect(pCode, `${tmpCase[0].join(' ')}: ${pStderr}`).to.equal(2);
									Expect(pStderr).to.contain(tmpCase[2]);
									Expect(pStderr).to.not.contain(TOKEN);
									Expect(pStdout).to.equal('');
									fNext(pIndex + 1);
								}));
						};
						fNext(0);
					}
				);

				test
				(
					'a bad --server, --token or --prefix (or MEDIA_LADDER_SERVER / _TOKEN) is a usage error naming where it came from, never echoing it; a missing --source is a failure (exit 1)',
					(fDone) =>
					{
						let libCLI = require('../bin/media-ladder.js');
						let fUsage = (pFlags, pEnvironment) =>
						{
							try
							{
								libCLI.pushOptions(pFlags, pEnvironment);
							}
							catch (pError)
							{
								return pError.message;
							}
							throw new Error('no usage error');
						};
						let tmpGood = { MEDIA_LADDER_SERVER: 'https://env.example', MEDIA_LADDER_TOKEN: 'env-token' };
						Expect(fUsage({ '--server': 'ftp://x' }, tmpGood)).to.equal('--server: The server URL must start with http:// or https://.');
						Expect(fUsage({}, { MEDIA_LADDER_SERVER: 'ftp://x', MEDIA_LADDER_TOKEN: 'env-token' })).to.equal('MEDIA_LADDER_SERVER: The server URL must start with http:// or https://.');
						let tmpCredentials = fUsage({ '--server': 'https://user:secret-pass@x' }, tmpGood);
						Expect(tmpCredentials).to.equal('--server: The server URL must not carry credentials; pass a token instead.');
						Expect(fUsage({ '--token': 'two words' }, tmpGood)).to.equal('--token: The token contains characters that cannot be sent in a header.');
						Expect(fUsage({}, { MEDIA_LADDER_SERVER: 'https://env.example', MEDIA_LADDER_TOKEN: 'env token' })).to.equal('MEDIA_LADDER_TOKEN: The token contains characters that cannot be sent in a header.');
						Expect(fUsage({ '--prefix': 'nope' }, tmpGood)).to.equal('--prefix: The prefix must be a path such as /1.0/MediaIngest.');

						let tmpEnvironment = { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN };
						runCLI(['push', tmpPackage.Directory, '--server', 'https://user:secret-pass@x'], tmpEnvironment, guard(fDone, (pCode, pStdout, pStderr) =>
							{
								Expect(pCode, pStderr).to.equal(2);
								Expect(pStderr.indexOf('media-ladder: --server: The server URL must not carry credentials; pass a token instead.\n')).to.equal(0);
								Expect(pStderr).to.not.contain('secret-pass');
								Expect(pStdout).to.equal('');
								let tmpMissing = libPath.join(tmpScratch, 'no-such-original.mov');
								runCLI(['push', tmpPackage.Directory, '--source', tmpMissing], tmpEnvironment, guard(fDone, (pSourceCode, pSourceStdout, pSourceStderr) =>
									{
										Expect(pSourceCode, pSourceStderr).to.equal(1);
										Expect(pSourceStderr).to.contain(tmpMissing);
										Expect(pSourceStderr).to.not.contain('Usage:');
										Expect(pSourceStdout).to.equal('');
										Expect(tmpServer.Log.length).to.equal(0);
										fDone();
									}));
							}));
					}
				);

				test
				(
					'refuses a <PV>.partial directory and a damaged package (exit 1) without contacting the server',
					(fDone) =>
					{
						let tmpOut = libPath.join(tmpScratch, 'cli-refusals');
						let tmpPartial = copyDirectory(tmpPackage.Directory, libPath.join(tmpOut, '1a2b3c4d.partial'));
						let tmpDamaged = copyDirectory(tmpPackage.Directory, libPath.join(tmpOut, 'damaged', '1a2b3c4d'));
						libFS.appendFileSync(libPath.join(tmpDamaged, 'poster.jpg'), 'x');
						let tmpEnvironment = { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN };
						runCLI(['push', tmpPartial], tmpEnvironment, guard(fDone, (pCode, pStdout, pStderr) =>
							{
								Expect(pCode).to.equal(1);
								Expect(pStderr).to.contain('unfinished encode');
								Expect(pStdout).to.equal('');
								runCLI(['push', tmpDamaged], tmpEnvironment, guard(fDone, (pDamagedCode, pDamagedStdout, pDamagedStderr) =>
									{
										Expect(pDamagedCode).to.equal(1);
										Expect(pDamagedStderr).to.contain('is damaged');
										Expect(pDamagedStderr).to.contain('poster.jpg is 5001 bytes, not 5000');
										Expect(pDamagedStdout).to.equal('');
										Expect(tmpServer.Log.length).to.equal(0);
										fDone();
									}));
							}));
					}
				);

				test
				(
					'pushes: "<AssetGUID> <PackageVersion>" on stdout, progress on stderr, the --server flag beats the environment, the token never printed; --json',
					(fDone) =>
					{
						// The environment points at a closed port; the flag wins.
						let tmpEnvironment = { MEDIA_LADDER_SERVER: 'http://127.0.0.1:9', MEDIA_LADDER_TOKEN: TOKEN };
						runCLI(['push', tmpPackage.Directory, '--server', tmpServer.BaseURL, '--title', 'Lake day', '--sensitivity', 'conversation'], tmpEnvironment, guard(fDone, (pCode, pStdout, pStderr) =>
							{
								Expect(pCode, pStderr).to.equal(0);
								let tmpMatch = /^([0-9a-f-]{36}) 1a2b3c4d\n$/.exec(pStdout);
								Expect(tmpMatch, pStdout).to.not.equal(null);
								Expect(pStderr).to.contain('register: ');
								Expect(pStderr).to.contain('upload 100%');
								Expect(pStderr).to.contain('commit: ');
								Expect(pStdout + pStderr).to.not.contain(TOKEN);
								Expect(tmpServer.Registrations[0]).to.include({ Title: 'Lake day', Sensitivity: 'conversation' });
								assertLive(tmpServer, tmpMatch[1], tmpPackage);

								runCLI(['push', tmpPackage.Directory, '--json'], { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN }, guard(fDone, (pJSONCode, pJSONStdout, pJSONStderr) =>
									{
										Expect(pJSONCode, pJSONStderr).to.equal(0);
										let tmpResult = JSON.parse(pJSONStdout);
										Expect(tmpResult).to.include({ AssetGUID: tmpMatch[1], PackageVersion: '1a2b3c4d', State: 'ready', UploadedFiles: 0, UploadedBytes: 0 });
										fDone();
									}));
							}));
					}
				);

				test
				(
					'a rejected token exits 1 with the server\'s error, never the token',
					(fDone) =>
					{
						runCLI(['push', tmpPackage.Directory], { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: 'exo_wrong-token-xyz' }, guard(fDone, (pCode, pStdout, pStderr) =>
							{
								Expect(pCode).to.equal(1);
								Expect(pStderr).to.contain('401');
								Expect(pStderr).to.contain('Not signed in.');
								Expect(pStdout + pStderr).to.not.contain('exo_wrong-token-xyz');
								fDone();
							}));
					}
				);

				test
				(
					'a server\'s error text reaches stderr printable: no escape sequence, control or bidi character, never the token (even echoed back)',
					(fDone) =>
					{
						tmpServer.addFault({ Kind: 'register', Action: 'status', Status: 403, Body: { Error: HOSTILE, Errors: [HOSTILE] } });
						runCLI(['push', tmpPackage.Directory], { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN }, guard(fDone, (pCode, pStdout, pStderr) =>
							{
								Expect(pCode, pStderr).to.equal(1);
								Expect(pStdout).to.equal('');
								Expect(pStderr).to.contain('media-ladder: register: the server answered 403: denied');
								Expect(pStderr).to.contain(`${escaped(0x0d)}media-ladder: pushed OK${escaped(0x0a)}`);
								Expect(pStderr).to.contain('Bearer <token> ');
								// The line ends are the CLI's own; nothing else that a terminal acts on gets through.
								assertPrintable(pStderr.replace(/\n/g, ''), 'stderr');
								Expect(pStderr.split('\n').filter((pLine) => /^media-ladder: /.test(pLine)).length).to.equal(1);
								fDone();
							}));
					}
				);

				test
				(
					'a JSON object where the server should send text (String() of it throws) is shown as JSON: exit 1 with the CLI\'s own message, never a stack trace',
					(fDone) =>
					{
						let tmpEnvironment = { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN };
						tmpServer.addFault({ Kind: 'register', Action: 'status', Status: 403, Body: { Error: 'Refused.', Errors: [NOT_TEXT] } });
						runCLI(['push', tmpPackage.Directory], tmpEnvironment, guard(fDone, (pCode, pStdout, pStderr) =>
							{
								Expect(pCode, pStderr).to.equal(1);
								Expect(pStdout).to.equal('');
								Expect(pStderr).to.contain(`media-ladder: register: the server answered 403: Refused. (${NOT_TEXT_JSON})\n`);
								Expect(pStderr, pStderr).to.not.match(/TypeError|primitive value|\n\s+at /);

								// A commit 409 naming no files, then a status answer whose State is such an object.
								tmpServer.addFault({ Kind: 'commit', Action: 'status', Status: 409, Body: { Error: 'Refused.' } });
								tmpServer.addFault({ Kind: 'status', Action: 'status', Status: 200, Body: { Asset: { PackageVersion: 'zz', State: NOT_TEXT } } });
								runCLI(['push', tmpPackage.Directory], tmpEnvironment, guard(fDone, (pStatusCode, pStatusStdout, pStatusStderr) =>
									{
										Expect(pStatusCode, pStatusStderr).to.equal(1);
										Expect(pStatusStdout).to.equal('');
										Expect(pStatusStderr).to.contain(`media-ladder: commit: the server answered 409: Refused. The asset has no live version yet (state ${NOT_TEXT_JSON}).\n`);
										Expect(pStatusStderr, pStatusStderr).to.not.match(/TypeError|primitive value|\n\s+at /);
										Expect(tmpServer.entries('status').map((pEntry) => pEntry.Fault)).to.deep.equal(['status']);
										fDone();
									}));
							}));
					}
				);

				test
				(
					'an interrupt cancels the in-flight chunk and exits 130; the next push resumes and completes',
					(fDone) =>
					{
						let tmpChild = null;
						tmpServer.addFault({ Kind: 'put', Path: 'v0/media.mp4', Action: 'hang', onStart: () => { setTimeout(() => tmpChild.kill('SIGINT'), 50); } });
						tmpChild = libChildProcess.spawn(process.execPath, [BIN, 'push', tmpPackage.Directory], { env: cleanEnvironment({ MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN }), stdio: ['ignore', 'pipe', 'pipe'] });
						let tmpStderr = '';
						let tmpStdout = '';
						tmpChild.stderr.on('data', (pChunk) => { tmpStderr += pChunk.toString('utf8'); });
						tmpChild.stdout.on('data', (pChunk) => { tmpStdout += pChunk.toString('utf8'); });
						tmpChild.on('close', guard(fDone, (pCode) =>
							{
								Expect(pCode, tmpStderr).to.equal(130);
								Expect(tmpStderr).to.contain('cancelling');
								Expect(tmpStderr).to.contain('cancelled');
								Expect(tmpStdout).to.equal('');
								Expect(tmpServer.entries('commit').length).to.equal(0);
								runCLI(['push', tmpPackage.Directory], { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN }, guard(fDone, (pCode2, pStdout2, pStderr2) =>
									{
										Expect(pCode2, pStderr2).to.equal(0);
										let tmpGUID = pStdout2.split(' ')[0];
										assertLive(tmpServer, tmpGUID, tmpPackage);
										fDone();
									}));
							}));
					}
				);
			}
		);

		suite
		(
			'a real encoded package and --source probing (ffmpeg)',
			function ()
			{
				let tmpServer = null;
				let tmpSource = null;
				let tmpEncoded = null;

				suiteSetup
				(
					function (fDone)
					{
						if (!TOOLS_AVAILABLE)
						{
							// eslint-disable-next-line no-console
							console.warn('\n  !!! retold-media-ladder push integration tests SKIPPED: ffmpeg/ffprobe not found on PATH !!!\n');
							this.skip();
							return;
						}
						this.timeout(120000);
						tmpSource = libPath.join(tmpScratch, 'DJI_20240501100000_0001_D.mp4');
						let tmpMake = libChildProcess.spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
							'-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
							'-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
							'-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
							'-metadata', 'creation_time=2024-05-01T10:00:00Z', tmpSource], { encoding: 'utf8' });
						if (tmpMake.status !== 0)
						{
							return fDone(new Error(`ffmpeg failed building the push source: ${tmpMake.stderr}`));
						}
						new libRetoldMediaLadder({ Log: recordingLog() }).encode(tmpSource, { OutputDirectory: libPath.join(tmpScratch, 'encoded'), Preset: 'ultrafast', Hwaccel: false }, (pError, pResult) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								tmpEncoded = { Directory: pResult.PackageDirectory, PackageVersion: pResult.PackageVersion, Document: pResult.Package };
								tmpServer = new libFakeServer({ Root: libFS.mkdtempSync(libPath.join(tmpScratch, 'real-server-')), Token: TOKEN });
								tmpServer.start(fDone);
							});
					}
				);

				suiteTeardown
				(
					(fDone) =>
					{
						if (tmpServer)
						{
							return tmpServer.stop(fDone);
						}
						return fDone();
					}
				);

				test
				(
					'Publisher: --source sends the original\'s name, sha256, transfer and creation_time; the encoded package goes live intact',
					(fDone) =>
					{
						let tmpEvents = [];
						new libPublisher({ Log: recordingLog() }).publish(tmpEncoded.Directory,
							{ Server: tmpServer.BaseURL, Token: TOKEN, Source: tmpSource, ChunkBytes: 32 * KIB, onProgress: (pEvent) => tmpEvents.push(pEvent) },
							guard(fDone, (pError, pResult) =>
							{
								Expect(pError).to.equal(null);
								let tmpExpectedSource = { Name: 'DJI_20240501100000_0001_D.mp4', Sha256: sha256Of(libFS.readFileSync(tmpSource)), Transfer: 'sdr', CaptureDate: '2024-05-01T10:00:00.000Z' };
								Expect(tmpServer.Registrations[0].Source).to.deep.equal(tmpExpectedSource);
								Expect(pResult.Source).to.deep.equal(tmpExpectedSource);
								// The package itself carries none of it.
								Expect(JSON.stringify(tmpServer.Registrations[0].Package)).to.not.contain('DJI_');
								Expect(tmpEvents.map((pEvent) => pEvent.Phase)).to.include('source');
								Expect(pResult.UploadedFiles).to.equal(tmpEncoded.Document.Files.length);
								assertLive(tmpServer, pResult.AssetGUID, tmpEncoded);
								fDone();
							}));
					}
				);

				test
				(
					'CLI: push --source --title --json against the same server dedups onto the same asset',
					(fDone) =>
					{
						runCLI(['push', tmpEncoded.Directory, '--source', tmpSource, '--title', 'Drone', '--json', '--chunk-mib', '1'], { MEDIA_LADDER_SERVER: tmpServer.BaseURL, MEDIA_LADDER_TOKEN: TOKEN }, guard(fDone, (pCode, pStdout, pStderr) =>
							{
								Expect(pCode, pStderr).to.equal(0);
								let tmpResult = JSON.parse(pStdout);
								Expect(tmpResult.Source.CaptureDate).to.equal('2024-05-01T10:00:00.000Z');
								Expect(tmpResult).to.include({ PackageVersion: tmpEncoded.PackageVersion, State: 'ready', UploadedFiles: 0 });
								Expect(Object.keys(tmpServer.Assets)).to.deep.equal([tmpResult.AssetGUID]);
								Expect(pStderr).to.contain('source: ');
								Expect(pStdout + pStderr).to.not.contain(TOKEN);
								fDone();
							}));
					}
				);
			}
		);
	}
);
