/**
* Retold Media Ladder -- shared tools
*
* Small, dependency-free helpers every ladder service leans on: binary
* resolution, an async spawn-and-collect and a streaming sha256 (both hand
* back a cancel handle), a key-sorted ("stable") JSON stringify, rational
* frame-rate maths, ffmpeg filtergraph escaping, and the ffmpeg capability
* preflight (what an encode needs, read from its argument lists, against
* what `ffmpeg -encoders / -filters / -hwaccels` lists).  Everything here
* except the spawn/hash helpers (ffmpegVersion, ffmpegCapabilities,
* checkFFmpegCapabilities among them) is pure.
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

// The ffmpeg major version media-ladder is built and tested against.  An
// older build only warns: it may well work.
const TESTED_FFMPEG_MAJOR = 7;
// -hwaccel values every ffmpeg accepts without listing them under -hwaccels.
const UNLISTED_HWACCELS = ['auto', 'none'];
// What a capability error says media-ladder needs (the README's requirements).
const FFMPEG_REQUIREMENT = 'media-ladder needs ffmpeg 7.x built with libx264, zscale (zimg) and tonemap.';
// Added when the missing piece is the Fast encoder, which only macOS builds have.
const FFMPEG_FAST_HINT = 'Fast encoding (--fast / Fast: true) needs h264_videotoolbox, a macOS encoder; leave it off to encode with libx264.';
// Added when the missing piece is the decode's hwaccel, which can be turned off.
const FFMPEG_HWACCEL_HINT = 'Turn the hardware decode off (--no-hwaccel / Hwaccel: false) to decode in software instead.';
// The encoder Fast encoding uses.
const FAST_ENCODER = 'h264_videotoolbox';
// Characters a terminal acts on instead of showing (the same set as the
// Publisher's printableServerText): C0 controls, DEL, C1 controls, the
// bidirectional marks, embeddings, overrides and isolates, and the Unicode
// line and paragraph separators.
const UNPRINTABLE_PATTERN = /[\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
// The most of one path or version line a capability message prints.
const MAX_PRINTABLE_CHARS = 500;

// Capability listings ({ Encoders, Filters, Hwaccels }) by ffmpeg path, for
// the life of the process.  Only a complete, successful listing is kept.
const _FFmpegCapabilityCache = {};

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

/**
 * The major version from `ffmpeg -version`'s first line: "ffmpeg version
 * 7.1", "ffmpeg version 6.1.1-3ubuntu5" and "ffmpeg version n7.0.2" give 7,
 * 6 and 7.  A git build ("ffmpeg version N-117000-g...") or anything else
 * without a major.minor gives null: no judgement. Pure.
 *
 * @param {string} pVersionLine
 * @returns {number|null}
 */
function parseFFmpegMajorVersion(pVersionLine)
{
	let tmpMatch = /^\s*ffmpeg version n?(\d+)\.\d+/.exec(String(pVersionLine || ''));
	return tmpMatch ? Number(tmpMatch[1]) : null;
}

/**
 * The version part of `ffmpeg -version`'s first line, without the copyright
 * ("ffmpeg version 6.1.1-3ubuntu5"), or null. Pure.
 *
 * @param {string} pVersionLine
 * @returns {string|null}
 */
function ffmpegVersionText(pVersionLine)
{
	let tmpText = String(pVersionLine || '').replace(/\s+Copyright\b.*$/, '').trim();
	return tmpText.length > 0 ? tmpText : null;
}

/**
 * Make text from the host (a binary path, which can hold anything, or what
 * an ffmpeg build prints) safe for an error message or a log line: every
 * character a terminal acts on instead of showing becomes a visible
 * `\uXXXX` escape, and the result is cut at pMaxChars ('...' marks the cut;
 * a surrogate pair is never split). Pure.
 *
 * @param {*} pValue
 * @param {number} [pMaxChars=500]
 * @returns {string}
 */
function printableText(pValue, pMaxChars)
{
	let tmpMaxChars = (pMaxChars > 0) ? pMaxChars : MAX_PRINTABLE_CHARS;
	let tmpText = String((pValue === null || typeof pValue === 'undefined') ? '' : pValue).slice(0, tmpMaxChars + 1);
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
 * Names from an `ffmpeg -encoders` or `ffmpeg -filters` listing: every line
 * shaped " <flags> <name> ...", where the flags are capitals and dots
 * (" V....D libx264 ...", " .S. zscale ...").  The legend above the list
 * (" V..... = Video", "  T.. = Timeline support") and the "------" rule
 * never match. Pure.
 *
 * @param {string} pText
 * @returns {Array<string>} names, in listing order
 */
function parseListedNames(pText)
{
	let tmpNames = [];
	String(pText || '').split(/\r?\n/).forEach((pLine) =>
		{
			let tmpMatch = /^\s+[A-Z.]{2,}\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)(?:\s|$)/.exec(pLine);
			if (tmpMatch && tmpNames.indexOf(tmpMatch[1]) < 0)
			{
				tmpNames.push(tmpMatch[1]);
			}
		});
	return tmpNames;
}

/**
 * Encoder names from `ffmpeg -hide_banner -encoders`. Pure.
 *
 * @param {string} pText
 * @returns {Array<string>}
 */
function parseEncoderList(pText)
{
	return parseListedNames(pText);
}

/**
 * Filter names from `ffmpeg -hide_banner -filters`. Pure.
 *
 * @param {string} pText
 * @returns {Array<string>}
 */
function parseFilterList(pText)
{
	return parseListedNames(pText);
}

/**
 * Hardware acceleration methods from `ffmpeg -hide_banner -hwaccels`: one
 * name per line under "Hardware acceleration methods:". Pure.
 *
 * @param {string} pText
 * @returns {Array<string>}
 */
function parseHwaccelList(pText)
{
	let tmpNames = [];
	String(pText || '').split(/\r?\n/).forEach((pLine) =>
		{
			let tmpMatch = /^\s*([A-Za-z0-9_]+)\s*$/.exec(pLine);
			if (tmpMatch && tmpNames.indexOf(tmpMatch[1]) < 0)
			{
				tmpNames.push(tmpMatch[1]);
			}
		});
	return tmpNames;
}

/**
 * The filter names a filtergraph uses (-filter_complex, -vf), read the way
 * ffmpeg's graph parser reads them: filters are separated by ',' and ';',
 * `[labels]` around them are skipped, the name is what comes before '=',
 * and the options after it run to the next ',', ';', '[' or ']' that is not
 * backslash-escaped or inside '...' quotes -- so an escaped path in
 * `lut3d=file=...` (escapeFilterValue) never splits the graph.  An instance
 * suffix ("scale@top") is dropped, and a leading `sws_flags=...;` is not a
 * filter. Pure.
 *
 * @param {string} pGraph
 * @returns {Array<string>} names, each once, in graph order
 */
function filterGraphNames(pGraph)
{
	let tmpGraph = String(pGraph || '');
	let tmpNames = [];
	let i = 0;
	let fIsSpace = (pCharacter) => /\s/.test(pCharacter);
	let fSkipLabels = () =>
	{
		while (i < tmpGraph.length && fIsSpace(tmpGraph[i]))
		{
			i++;
		}
		while (tmpGraph[i] === '[')
		{
			let tmpClose = tmpGraph.indexOf(']', i);
			i = (tmpClose < 0) ? tmpGraph.length : (tmpClose + 1);
			while (i < tmpGraph.length && fIsSpace(tmpGraph[i]))
			{
				i++;
			}
		}
	};
	while (i < tmpGraph.length)
	{
		let tmpStart = i;
		fSkipLabels();
		let tmpNameStart = i;
		while (i < tmpGraph.length && '=,;[]'.indexOf(tmpGraph[i]) < 0 && !fIsSpace(tmpGraph[i]))
		{
			i++;
		}
		let tmpName = tmpGraph.slice(tmpNameStart, i).split('@')[0];
		while (i < tmpGraph.length && fIsSpace(tmpGraph[i]))
		{
			i++;
		}
		if (tmpGraph[i] === '=')
		{
			i++;
			while (i < tmpGraph.length && '[],;'.indexOf(tmpGraph[i]) < 0)
			{
				if (tmpGraph[i] === '\\')
				{
					i += 2;
				}
				else if (tmpGraph[i] === '\'')
				{
					let tmpClose = tmpGraph.indexOf('\'', i + 1);
					i = (tmpClose < 0) ? tmpGraph.length : (tmpClose + 1);
				}
				else
				{
					i++;
				}
			}
		}
		fSkipLabels();
		if (tmpGraph[i] === ',' || tmpGraph[i] === ';')
		{
			i++;
		}
		else if (i === tmpStart)
		{
			// A stray ']' (not something a ladder graph holds): step over it.
			i++;
		}
		if (tmpName.length > 0 && tmpName !== 'sws_flags' && tmpNames.indexOf(tmpName) < 0)
		{
			tmpNames.push(tmpName);
		}
	}
	return tmpNames;
}

/**
 * What a set of ffmpeg runs needs from the build, read from their argument
 * lists: encoders from -c / -codec (any stream specifier) and -vcodec /
 * -acodec ('copy' needs none), filters from the graphs of -filter_complex,
 * -lavfi, -vf, -af and -filter, and the -hwaccel ('auto' and 'none' are
 * always accepted). Pure.
 *
 * @param {Array<Array<string>>} pArgumentLists - one ffmpeg argument list per run
 * @returns {Object} { Encoders, Filters, Hwaccels } -- each a list of names, each once
 */
function capabilityRequirements(pArgumentLists)
{
	let tmpRequired = { Encoders: [], Filters: [], Hwaccels: [] };
	let fAdd = (pList, pName) =>
	{
		if (pName && pList.indexOf(pName) < 0)
		{
			pList.push(pName);
		}
	};
	(pArgumentLists || []).forEach((pArguments) =>
		{
			let tmpArguments = (pArguments || []).map((pArgument) => String(pArgument));
			for (let i = 0; i < tmpArguments.length - 1; i++)
			{
				let tmpFlag = tmpArguments[i];
				let tmpValue = tmpArguments[i + 1];
				if (/^-(?:c|codec)(?::\S*)?$/.test(tmpFlag) || /^-[vas]codec$/.test(tmpFlag))
				{
					if (tmpValue !== 'copy')
					{
						fAdd(tmpRequired.Encoders, tmpValue);
					}
					i++;
				}
				else if (/^-(?:filter_complex|lavfi|vf|af|filter(?::\S*)?)$/.test(tmpFlag))
				{
					filterGraphNames(tmpValue).forEach((pName) => fAdd(tmpRequired.Filters, pName));
					i++;
				}
				else if (tmpFlag === '-hwaccel')
				{
					if (UNLISTED_HWACCELS.indexOf(tmpValue) < 0)
					{
						fAdd(tmpRequired.Hwaccels, tmpValue);
					}
					i++;
				}
				else if (tmpFlag === '-i')
				{
					// An input path is never a flag, whatever it is called.
					i++;
				}
			}
		});
	return tmpRequired;
}

/**
 * The required pieces a capability listing does not have. Pure.
 *
 * @param {Object} pListing - { Encoders, Filters, Hwaccels } (ffmpegCapabilities)
 * @param {Object} pRequired - { Encoders, Filters, Hwaccels } (capabilityRequirements)
 * @returns {Array<Object>} [{ Kind: 'encoder' | 'filter' | 'hwaccel', Name }], encoders first
 */
function missingCapabilities(pListing, pRequired)
{
	let tmpListing = pListing || {};
	let tmpRequired = pRequired || {};
	let tmpMissing = [];
	[['Encoders', 'encoder'], ['Filters', 'filter'], ['Hwaccels', 'hwaccel']].forEach((pKind) =>
		{
			let tmpHave = tmpListing[pKind[0]] || [];
			(tmpRequired[pKind[0]] || []).forEach((pName) =>
				{
					if (tmpHave.indexOf(pName) < 0)
					{
						tmpMissing.push({ Kind: pKind[1], Name: pName });
					}
				});
		});
	return tmpMissing;
}

/**
 * "This ffmpeg (<path>, <version>)", made printable. Pure.
 *
 * @param {string} pFFmpeg
 * @param {string} [pVersionLine]
 * @returns {string}
 */
function describeFFmpeg(pFFmpeg, pVersionLine)
{
	let tmpVersion = ffmpegVersionText(pVersionLine);
	return `This ffmpeg (${printableText(pFFmpeg)}${tmpVersion ? `, ${printableText(tmpVersion)}` : ''})`;
}

/**
 * The one message for an ffmpeg that cannot run an encode, naming every
 * missing piece and what media-ladder needs, e.g. "This ffmpeg
 * (/usr/bin/ffmpeg, ffmpeg version 6.1.1) cannot run this encode: it has no
 * libx264 encoder and no zscale filter. media-ladder needs ffmpeg 7.x built
 * with libx264, zscale (zimg) and tonemap."  A missing h264_videotoolbox
 * encoder adds FFMPEG_FAST_HINT, and a missing hwaccel FFMPEG_HWACCEL_HINT;
 * both name the CLI flag and the library option. Pure.
 *
 * @param {string} pFFmpeg
 * @param {string} pVersionLine
 * @param {Array<Object>} pMissing - [{ Kind, Name }]
 * @returns {string}
 */
function describeMissingCapabilities(pFFmpeg, pVersionLine, pMissing)
{
	let tmpPieces = (pMissing || []).map((pPiece) => `no ${printableText(pPiece.Name, 100)} ${pPiece.Kind}`);
	let tmpList = (tmpPieces.length < 2) ? tmpPieces.join('') : `${tmpPieces.slice(0, -1).join(', ')} and ${tmpPieces[tmpPieces.length - 1]}`;
	let tmpMessage = `${describeFFmpeg(pFFmpeg, pVersionLine)} cannot run this encode: it has ${tmpList}. ${FFMPEG_REQUIREMENT}`;
	if ((pMissing || []).some((pPiece) => (pPiece.Kind === 'encoder') && (pPiece.Name === FAST_ENCODER)))
	{
		tmpMessage += ` ${FFMPEG_FAST_HINT}`;
	}
	if ((pMissing || []).some((pPiece) => pPiece.Kind === 'hwaccel'))
	{
		tmpMessage += ` ${FFMPEG_HWACCEL_HINT}`;
	}
	return tmpMessage;
}

/**
 * The Error for an ffmpeg that cannot run an encode: describeMissingCapabilities'
 * message, marked `.Capability = true`, with `.Missing` ([{ Kind, Name }]),
 * `.FFmpeg` (the path) and `.FFmpegVersion` (the -version line).
 *
 * @param {string} pFFmpeg
 * @param {string} pVersionLine
 * @param {Array<Object>} pMissing
 * @returns {Error}
 */
function capabilityError(pFFmpeg, pVersionLine, pMissing)
{
	let tmpError = new Error(describeMissingCapabilities(pFFmpeg, pVersionLine, pMissing));
	tmpError.Capability = true;
	tmpError.Missing = (pMissing || []).map((pPiece) => ({ Kind: pPiece.Kind, Name: pPiece.Name }));
	tmpError.FFmpeg = pFFmpeg;
	tmpError.FFmpegVersion = pVersionLine || null;
	return tmpError;
}

/**
 * The warning for an ffmpeg older than the 7.x media-ladder is tested
 * with, or null (7 or newer, or a version that cannot be read). Pure.
 *
 * @param {string} pFFmpeg
 * @param {string} pVersionLine
 * @returns {string|null}
 */
function olderFFmpegWarning(pFFmpeg, pVersionLine)
{
	let tmpMajor = parseFFmpegMajorVersion(pVersionLine);
	if (tmpMajor === null || tmpMajor >= TESTED_FFMPEG_MAJOR)
	{
		return null;
	}
	return `${describeFFmpeg(pFFmpeg, pVersionLine)} is older than the ${TESTED_FFMPEG_MAJOR}.x media-ladder is tested with; the encode may still work, but if it fails, install ffmpeg ${TESTED_FFMPEG_MAJOR}.x.`;
}

// The listings a capability check reads, run side by side.
const FFMPEG_CAPABILITY_QUERIES =
[
	{ Key: 'Encoders', Flag: '-encoders', Parse: parseEncoderList },
	{ Key: 'Filters', Flag: '-filters', Parse: parseFilterList },
	{ Key: 'Hwaccels', Flag: '-hwaccels', Parse: parseHwaccelList }
];

/**
 * What an ffmpeg build has: `ffmpeg -hide_banner -encoders`, `-filters` and
 * `-hwaccels`, run side by side, once per ffmpeg path per process (a failed
 * or cancelled listing is not kept; `Refresh` lists again).  It calls back
 * only once all three processes have closed, a cancel included.  The
 * listing is shared: treat it as read-only.
 *
 * @param {string} pFFmpeg
 * @param {Object} [pOptions] - { Refresh }
 * @param {function} fCallback - (pError, { Encoders, Filters, Hwaccels }, pFromCache); a cancel yields an Error with `.Cancelled = true`
 * @returns {Object} handle { cancel(pImmediate) }
 */
function ffmpegCapabilities(pFFmpeg, pOptions, fCallback)
{
	let tmpOptions = pOptions || {};
	let tmpKey = String(pFFmpeg);
	if (!tmpOptions.Refresh && Object.prototype.hasOwnProperty.call(_FFmpegCapabilityCache, tmpKey))
	{
		let tmpCached = _FFmpegCapabilityCache[tmpKey];
		setImmediate(() => fCallback(null, tmpCached, true));
		return inertHandle();
	}
	// Calls back once every listing process has closed, so a callback -- a
	// cancel's included -- never leaves one running.
	let tmpState = { Finished: false, Cancelled: false, Handles: [], Listing: {}, Open: FFMPEG_CAPABILITY_QUERIES.length, Error: null };
	let fSettle = () =>
	{
		if (tmpState.Finished || tmpState.Open > 0)
		{
			return;
		}
		tmpState.Finished = true;
		if (tmpState.Error)
		{
			return fCallback(tmpState.Error);
		}
		let tmpListing = Object.freeze({ Encoders: tmpState.Listing.Encoders, Filters: tmpState.Listing.Filters, Hwaccels: tmpState.Listing.Hwaccels });
		_FFmpegCapabilityCache[tmpKey] = tmpListing;
		return fCallback(null, tmpListing, false);
	};
	let fFail = (pError) =>
	{
		if (!tmpState.Error)
		{
			tmpState.Error = pError;
			// The other listings no longer matter.
			tmpState.Handles.forEach((pHandle) => { pHandle.cancel(true); });
		}
		return fSettle();
	};
	FFMPEG_CAPABILITY_QUERIES.forEach((pQuery) =>
		{
			tmpState.Handles.push(spawnCollect(pFFmpeg, ['-hide_banner', pQuery.Flag], {}, (pError, pResult) =>
				{
					tmpState.Open--;
					if (tmpState.Cancelled)
					{
						return fFail((pError && pError.Cancelled) ? pError : cancelledError());
					}
					if (pError)
					{
						return fFail(pError.Cancelled ? pError : new Error(`ffmpeg is not runnable (${pFFmpeg}): ${pError.message}`));
					}
					if (pResult.Code !== 0)
					{
						return fFail(new Error(`ffmpeg ${pQuery.Flag} exited with code ${pResult.Code}: ${stderrTail(pResult.Stderr)}`));
					}
					tmpState.Listing[pQuery.Key] = Object.freeze(pQuery.Parse(pResult.Stdout.toString('utf8')));
					return fSettle();
				}));
		});
	return (
		{
			cancel: (pImmediate) =>
			{
				if (tmpState.Finished)
				{
					return false;
				}
				tmpState.Cancelled = true;
				tmpState.Handles.forEach((pHandle) => { pHandle.cancel(pImmediate); });
				return true;
			}
		});
}

/**
 * Which of the required pieces this ffmpeg lacks (empty when it has them
 * all).  A cached listing that comes up short is listed again before the
 * answer stands, so an ffmpeg rebuilt or replaced at the same path while the
 * process runs is seen as it now is.
 *
 * @param {string} pFFmpeg
 * @param {Object} pRequired - { Encoders, Filters, Hwaccels } (capabilityRequirements)
 * @param {function} fCallback - (pError, pMissing [{ Kind, Name }]); pError when ffmpeg cannot be listed; a cancel yields an Error with `.Cancelled = true`
 * @returns {Object} handle { cancel(pImmediate) }
 */
function checkFFmpegCapabilities(pFFmpeg, pRequired, fCallback)
{
	let tmpState = { Current: null, Finished: false, Cancelled: false };
	let fFinish = (pError, pMissing) =>
	{
		if (tmpState.Finished)
		{
			return;
		}
		tmpState.Finished = true;
		return fCallback(pError, pMissing);
	};
	let fCheck = (pRefresh) =>
	{
		tmpState.Current = ffmpegCapabilities(pFFmpeg, { Refresh: pRefresh }, (pError, pListing, pFromCache) =>
			{
				if (tmpState.Cancelled)
				{
					return fFinish((pError && pError.Cancelled) ? pError : cancelledError());
				}
				if (pError)
				{
					return fFinish(pError);
				}
				let tmpMissing = missingCapabilities(pListing, pRequired);
				if (tmpMissing.length > 0 && pFromCache)
				{
					return fCheck(true);
				}
				return fFinish(null, tmpMissing);
			});
	};
	fCheck(false);
	return (
		{
			cancel: (pImmediate) =>
			{
				if (tmpState.Finished)
				{
					return false;
				}
				tmpState.Cancelled = true;
				tmpState.Current.cancel(pImmediate);
				return true;
			}
		});
}

/**
 * Forget the capability listing kept for one ffmpeg path, or for every path.
 *
 * @param {string} [pFFmpeg]
 */
function clearFFmpegCapabilityCache(pFFmpeg)
{
	Object.keys(_FFmpegCapabilityCache).forEach((pKey) =>
		{
			if (typeof pFFmpeg === 'undefined' || pKey === String(pFFmpeg))
			{
				delete _FFmpegCapabilityCache[pKey];
			}
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
	ffmpegVersion: ffmpegVersion,
	TESTED_FFMPEG_MAJOR: TESTED_FFMPEG_MAJOR,
	FFMPEG_REQUIREMENT: FFMPEG_REQUIREMENT,
	FFMPEG_FAST_HINT: FFMPEG_FAST_HINT,
	FFMPEG_HWACCEL_HINT: FFMPEG_HWACCEL_HINT,
	parseFFmpegMajorVersion: parseFFmpegMajorVersion,
	ffmpegVersionText: ffmpegVersionText,
	printableText: printableText,
	parseEncoderList: parseEncoderList,
	parseFilterList: parseFilterList,
	parseHwaccelList: parseHwaccelList,
	filterGraphNames: filterGraphNames,
	capabilityRequirements: capabilityRequirements,
	missingCapabilities: missingCapabilities,
	describeMissingCapabilities: describeMissingCapabilities,
	capabilityError: capabilityError,
	olderFFmpegWarning: olderFFmpegWarning,
	ffmpegCapabilities: ffmpegCapabilities,
	checkFFmpegCapabilities: checkFFmpegCapabilities,
	clearFFmpegCapabilityCache: clearFFmpegCapabilityCache
};
