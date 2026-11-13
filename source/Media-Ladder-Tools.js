/**
* Retold Media Ladder -- shared tools
*
* Small, dependency-free helpers every ladder service leans on: binary
* resolution, an async spawn-and-collect and a streaming sha256 (both hand
* back a cancel handle), a key-sorted ("stable") JSON stringify, rational
* frame-rate maths and ffmpeg filtergraph escaping.  Everything here except
* the spawn/hash helpers is pure.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libChildProcess = require('node:child_process');
const libCrypto = require('node:crypto');
const libFS = require('node:fs');

const DEFAULT_FFMPEG = 'ffmpeg';
const DEFAULT_FFPROBE = 'ffprobe';

// How much of a child's stderr to keep for error messages.
const STDERR_TAIL_BYTES = 16384;
// SIGTERM -> SIGKILL grace for the short helper processes (ffprobe, poster, remux).
const DEFAULT_COLLECT_KILL_TIMEOUT_MS = 2000;

/**
 * Resolve the ffmpeg / ffprobe binaries: explicit option, then environment,
 * then whatever is on PATH.
 *
 * @param {Object} [pOptions] - { FFmpegPath, FFprobePath }
 * @returns {Object} { FFmpeg, FFprobe }
 */
function resolveBinaries(pOptions)
{
	let tmpOptions = pOptions || {};
	return (
		{
			FFmpeg: tmpOptions.FFmpegPath || process.env.RETOLD_MEDIA_LADDER_FFMPEG || DEFAULT_FFMPEG,
			FFprobe: tmpOptions.FFprobePath || process.env.RETOLD_MEDIA_LADDER_FFPROBE || DEFAULT_FFPROBE
		});
}

/**
 * A logger shaped like fable's, for services constructed without a Fable.
 * Quiet by default (trace/debug/info dropped); warnings and errors go to stderr.
 *
 * @param {boolean} [pVerbose]
 * @returns {Object}
 */
function createFallbackLog(pVerbose)
{
	let fQuiet = function () {};
	let fError = function (pMessage) { process.stderr.write(`${pMessage}\n`); };
	return (
		{
			trace: pVerbose ? fError : fQuiet,
			debug: pVerbose ? fError : fQuiet,
			info: pVerbose ? fError : fQuiet,
			warn: fError,
			error: fError
		});
}

/**
 * An Error marked as a cancellation (`.Cancelled = true`).
 *
 * @param {string} [pMessage]
 * @returns {Error}
 */
function cancelledError(pMessage)
{
	let tmpError = new Error(pMessage || 'Cancelled.');
	tmpError.Cancelled = true;
	return tmpError;
}

/**
 * A handle for work that cannot be cancelled (or has already finished).
 *
 * @returns {Object} { cancel() } -- always returns false
 */
function inertHandle()
{
	return { cancel: () => false, Process: null };
}

/**
 * Spawn a command, collecting stdout (as a Buffer) and the tail of stderr.
 * Never throws; spawn failures (ENOENT) arrive as the callback error.
 *
 * The returned handle's `cancel(pImmediate)` stops the child: SIGTERM, then
 * SIGKILL after `KillTimeoutMS` (or SIGKILL at once when pImmediate), and the
 * callback receives an Error with `.Cancelled = true`.
 *
 * @param {string} pCommand
 * @param {Array<string>} pArguments
 * @param {Object} [pOptions] - { Cwd, KillTimeoutMS (default 2000) }
 * @param {function} fCallback - (pError, { Code, Signal, Stdout, Stderr })
 * @returns {Object} handle { cancel(pImmediate), Process }
 */
function spawnCollect(pCommand, pArguments, pOptions, fCallback)
{
	let tmpOptions = pOptions || {};
	let tmpKillTimeout = (typeof tmpOptions.KillTimeoutMS === 'number') ? tmpOptions.KillTimeoutMS : DEFAULT_COLLECT_KILL_TIMEOUT_MS;
	let tmpStdout = [];
	let tmpStderr = '';
	let tmpState = { Finished: false, Cancelled: false, KillTimer: null };

	let fFinish = function (pError, pResult)
	{
		if (tmpState.Finished)
		{
			return;
		}
		tmpState.Finished = true;
		if (tmpState.KillTimer)
		{
			clearTimeout(tmpState.KillTimer);
			tmpState.KillTimer = null;
		}
		return fCallback(pError, pResult);
	};

	let tmpChild;
	try
	{
		tmpChild = libChildProcess.spawn(pCommand, pArguments, { cwd: tmpOptions.Cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] });
	}
	catch (pSpawnError)
	{
		setImmediate(() => fFinish(pSpawnError));
		return inertHandle();
	}

	tmpChild.stdout.on('data', (pChunk) => { tmpStdout.push(pChunk); });
	tmpChild.stderr.on('data', (pChunk) =>
		{
			tmpStderr += pChunk.toString('utf8');
			if (tmpStderr.length > STDERR_TAIL_BYTES)
			{
				tmpStderr = tmpStderr.slice(tmpStderr.length - STDERR_TAIL_BYTES);
			}
		});
	tmpChild.on('error', (pError) => { return fFinish(tmpState.Cancelled ? cancelledError() : pError); });
	tmpChild.on('close', (pCode, pSignal) =>
		{
			if (tmpState.Cancelled)
			{
				let tmpCancelError = cancelledError();
				tmpCancelError.Signal = pSignal;
				return fFinish(tmpCancelError);
			}
			return fFinish(null, { Code: pCode, Signal: pSignal, Stdout: Buffer.concat(tmpStdout), Stderr: tmpStderr });
		});

	return (
		{
			Process: tmpChild,
			cancel: (pImmediate) => killChild(tmpChild, tmpState, tmpKillTimeout, pImmediate)
		});
}

/**
 * Cancel a child process: SIGTERM then SIGKILL after pKillTimeout, or SIGKILL
 * at once when pImmediate.  A second, immediate cancel escalates straight to
 * SIGKILL.  Shared by spawnCollect and EncodeRunner.run.
 *
 * @param {Object} pChild - a ChildProcess
 * @param {Object} pState - { Finished, Cancelled, KillTimer } (mutated)
 * @param {number} pKillTimeout - milliseconds
 * @param {boolean} [pImmediate]
 * @returns {boolean} true when a signal was sent
 */
function killChild(pChild, pState, pKillTimeout, pImmediate)
{
	if (pState.Finished || (pState.Cancelled && !pImmediate))
	{
		return false;
	}
	pState.Cancelled = true;
	let fSignal = (pSignal) =>
	{
		try
		{
			pChild.kill(pSignal);
		}
		catch (pKillError)
		{
			// Already gone.
		}
	};
	if (pImmediate)
	{
		if (pState.KillTimer)
		{
			clearTimeout(pState.KillTimer);
			pState.KillTimer = null;
		}
		fSignal('SIGKILL');
		return true;
	}
	fSignal('SIGTERM');
	pState.KillTimer = setTimeout(() =>
		{
			pState.KillTimer = null;
			if (!pState.Finished)
			{
				fSignal('SIGKILL');
			}
		}, pKillTimeout);
	return true;
}

/**
 * The last few non-empty lines of a stderr capture, for error messages.
 *
 * @param {string} pStderr
 * @param {number} [pLines=6]
 * @returns {string}
 */
function stderrTail(pStderr, pLines)
{
	let tmpLines = String(pStderr || '').split(/\r?\n/).filter((pLine) => pLine.trim().length > 0);
	return tmpLines.slice(-1 * (pLines || 6)).join(' | ');
}

/**
 * Stream a file through sha256.  The returned handle's `cancel()` stops the
 * read (a multi-GB source on a slow disk can take minutes) and the callback
 * receives an Error with `.Cancelled = true`.
 *
 * @param {string} pPath
 * @param {function} fCallback - (pError, pHexDigest)
 * @returns {Object} handle { cancel() }
 */
function sha256File(pPath, fCallback)
{
	let tmpHash = libCrypto.createHash('sha256');
	let tmpStream = libFS.createReadStream(pPath);
	let tmpFinished = false;
	let tmpCancelled = false;
	let fFinish = (pError, pDigest) =>
	{
		if (tmpFinished)
		{
			return;
		}
		tmpFinished = true;
		return fCallback(pError, pDigest);
	};
	tmpStream.on('error', (pError) =>
		{
			if (!tmpCancelled)
			{
				return fFinish(pError);
			}
		});
	tmpStream.on('data', (pChunk) => { tmpHash.update(pChunk); });
	tmpStream.on('end', () =>
		{
			if (!tmpCancelled)
			{
				return fFinish(null, tmpHash.digest('hex'));
			}
		});
	return (
		{
			cancel: () =>
			{
				if (tmpFinished || tmpCancelled)
				{
					return false;
				}
				tmpCancelled = true;
				tmpStream.destroy();
				setImmediate(() => fFinish(cancelledError(`Hashing ${pPath} cancelled.`)));
				return true;
			}
		});
}

/**
 * sha256 of a string or Buffer, as hex.
 *
 * @param {string|Buffer} pValue
 * @returns {string}
 */
function sha256Hex(pValue)
{
	return libCrypto.createHash('sha256').update(pValue).digest('hex');
}

/**
 * JSON.stringify with object keys sorted at every depth, so the same plan
 * always hashes to the same PackageVersion. `undefined` members are dropped
 * exactly as JSON.stringify drops them.
 *
 * @param {*} pValue
 * @returns {string}
 */
function stableStringify(pValue)
{
	if (pValue === null || typeof pValue !== 'object')
	{
		let tmpScalar = JSON.stringify(pValue);
		return (typeof tmpScalar === 'undefined') ? 'null' : tmpScalar;
	}
	if (Array.isArray(pValue))
	{
		return '[' + pValue.map((pItem) => stableStringify(pItem)).join(',') + ']';
	}
	let tmpKeys = Object.keys(pValue).filter((pKey) => typeof pValue[pKey] !== 'undefined' && typeof pValue[pKey] !== 'function').sort();
	return '{' + tmpKeys.map((pKey) => JSON.stringify(pKey) + ':' + stableStringify(pValue[pKey])).join(',') + '}';
}

function greatestCommonDivisor(pA, pB)
{
	let tmpA = Math.abs(pA);
	let tmpB = Math.abs(pB);
	while (tmpB)
	{
		let tmpT = tmpB;
		tmpB = tmpA % tmpB;
		tmpA = tmpT;
	}
	return tmpA || 1;
}

/**
 * Build a reduced rational.
 *
 * @param {number} pNumerator
 * @param {number} pDenominator
 * @returns {Object} { Num, Den, Value }
 */
function makeRational(pNumerator, pDenominator)
{
	let tmpGCD = greatestCommonDivisor(pNumerator, pDenominator);
	let tmpNum = Math.round(pNumerator / tmpGCD);
	let tmpDen = Math.round(pDenominator / tmpGCD);
	return { Num: tmpNum, Den: tmpDen, Value: tmpNum / tmpDen };
}

/**
 * Parse an ffprobe rational ("30000/1001", "100/1", "25") into a reduced
 * rational, or null when it is absent, zero or malformed ("0/0").
 *
 * @param {string|number} pText
 * @returns {Object|null} { Num, Den, Value }
 */
function parseRational(pText)
{
	if (typeof pText === 'number')
	{
		if (!(pText > 0) || !isFinite(pText))
		{
			return null;
		}
		// Express decimals over 1000 so 29.97 stays exact-ish.
		return makeRational(Math.round(pText * 1000), 1000);
	}
	if (typeof pText !== 'string' || pText.length < 1)
	{
		return null;
	}
	let tmpParts = pText.split('/');
	let tmpNum = Number(tmpParts[0]);
	let tmpDen = (tmpParts.length > 1) ? Number(tmpParts[1]) : 1;
	if (!(tmpNum > 0) || !(tmpDen > 0) || !isFinite(tmpNum) || !isFinite(tmpDen))
	{
		return null;
	}
	if (Math.round(tmpNum) !== tmpNum || Math.round(tmpDen) !== tmpDen)
	{
		return makeRational(Math.round(tmpNum / tmpDen * 1000), 1000);
	}
	return makeRational(tmpNum, tmpDen);
}

/**
 * @param {Object} pRational - { Num, Den }
 * @returns {string} "Num/Den"
 */
function formatRational(pRational)
{
	return `${pRational.Num}/${pRational.Den}`;
}

/**
 * Escape a value (typically a file path) for use as a filter OPTION inside
 * an ffmpeg -filter_complex graph. Two levels apply (see the ffmpeg-filters
 * manual, "Notes on filtergraph escaping"): first the option parser
 * (`\ ' :`), then the graph parser (`\ ' [ ] , ;`).
 *
 * @param {string} pValue
 * @returns {string}
 */
function escapeFilterValue(pValue)
{
	let tmpLevelOne = String(pValue).replace(/[\\':]/g, (pCharacter) => `\\${pCharacter}`);
	return tmpLevelOne.replace(/[\\'[\],;]/g, (pCharacter) => `\\${pCharacter}`);
}

/**
 * Round to a fixed number of decimals and return a number.
 *
 * @param {number} pValue
 * @param {number} pDecimals
 * @returns {number}
 */
function roundTo(pValue, pDecimals)
{
	let tmpFactor = Math.pow(10, pDecimals);
	return Math.round(pValue * tmpFactor) / tmpFactor;
}

/**
 * First line of `ffmpeg -version`, e.g. "ffmpeg version 7.1 Copyright ...".
 *
 * @param {string} pFFmpeg
 * @param {function} fCallback - (pError, pVersionLine)
 * @returns {Object} handle { cancel(pImmediate) }
 */
function ffmpegVersion(pFFmpeg, fCallback)
{
	return spawnCollect(pFFmpeg, ['-hide_banner', '-version'], {}, (pError, pResult) =>
		{
			if (pError)
			{
				return fCallback(pError.Cancelled ? pError : new Error(`ffmpeg is not runnable (${pFFmpeg}): ${pError.message}`));
			}
			if (pResult.Code !== 0)
			{
				return fCallback(new Error(`ffmpeg -version exited with code ${pResult.Code}: ${stderrTail(pResult.Stderr)}`));
			}
			let tmpFirstLine = pResult.Stdout.toString('utf8').split(/\r?\n/)[0].trim();
			return fCallback(null, tmpFirstLine);
		});
}

module.exports =
{
	DEFAULT_FFMPEG: DEFAULT_FFMPEG,
	DEFAULT_FFPROBE: DEFAULT_FFPROBE,
	resolveBinaries: resolveBinaries,
	createFallbackLog: createFallbackLog,
	cancelledError: cancelledError,
	inertHandle: inertHandle,
	spawnCollect: spawnCollect,
	killChild: killChild,
	stderrTail: stderrTail,
	sha256File: sha256File,
	sha256Hex: sha256Hex,
	stableStringify: stableStringify,
	greatestCommonDivisor: greatestCommonDivisor,
	makeRational: makeRational,
	parseRational: parseRational,
	formatRational: formatRational,
	escapeFilterValue: escapeFilterValue,
	roundTo: roundTo,
	ffmpegVersion: ffmpegVersion
};
