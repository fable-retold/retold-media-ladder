/**
* Retold Media Ladder -- Sanitiser
*
* The gate every package passes before it is renamed into place.  It ffprobes
* every media output (and reads the poster's JPEG markers and the playlists'
* text) and FAILS the encode on anything identifying:
*
*   - `location` / ISO 6709 / GPS tags, `creation_time`, any
*     `com.apple.quicktime.*` (make, model, software, capture date ...)
*   - data, subtitle or attachment streams (DJI telemetry and the home point
*     hide in data tracks), attached pictures, chapters
*   - any other tag at all: only the structural MP4 brand tags, a generic
*     handler name, the null vendor id, a language code and an `encoder` that
*     is ffmpeg's own (`Lavf…` / `Lavc…`) may survive
*   - JPEG APP1..APP15 segments (EXIF, XMP, ICC) and COM comments
*   - playlist date tags (`EXT-X-PROGRAM-DATE-TIME`, `EXT-X-DATERANGE`,
*     `EXT-X-SESSION-DATA`)
*
* `inspectProbe`, `inspectJpeg` and `inspectPlaylist` are pure.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libFS = require('node:fs');
const libPath = require('node:path');

const libTools = require('./Media-Ladder-Tools.js');

const ALLOWED_FORMAT_TAGS = ['major_brand', 'minor_version', 'compatible_brands', 'encoder'];
const ALLOWED_STREAM_TAGS = ['language', 'handler_name', 'vendor_id', 'encoder'];
const ALLOWED_HANDLER_NAMES = ['VideoHandler', 'SoundHandler'];
const ALLOWED_VENDOR_IDS = ['[0][0][0][0]'];
const FFMPEG_ENCODER_PATTERN = /^Lav[fc]/;
const FORBIDDEN_STREAM_TYPES = ['data', 'subtitle', 'attachment'];
const FORBIDDEN_PLAYLIST_TAGS = ['#EXT-X-PROGRAM-DATE-TIME', '#EXT-X-DATERANGE', '#EXT-X-SESSION-DATA'];
const MEDIA_EXTENSIONS = ['.mp4', '.m4a', '.m4s', '.mov'];
const JPEG_EXTENSIONS = ['.jpg', '.jpeg'];
const PLAYLIST_EXTENSIONS = ['.m3u8'];

/**
 * Why a tag key is identifying, or false when it is merely unexpected.
 *
 * @param {string} pKey
 * @returns {string|false}
 */
function identifyingReason(pKey)
{
	let tmpKey = String(pKey).toLowerCase();
	if (tmpKey.indexOf('location') >= 0 || tmpKey.indexOf('gps') >= 0 || tmpKey.indexOf('xyz') >= 0 || tmpKey.indexOf('6709') >= 0)
	{
		return 'location tag';
	}
	if (tmpKey.indexOf('creation_time') >= 0 || tmpKey === 'date' || tmpKey.indexOf('creationdate') >= 0)
	{
		return 'capture-date tag';
	}
	if (tmpKey.indexOf('com.apple.quicktime') === 0)
	{
		return 'com.apple.quicktime.* tag';
	}
	if (tmpKey.indexOf('com.android') === 0 || tmpKey === 'make' || tmpKey === 'model' || tmpKey.indexOf('serial') >= 0)
	{
		return 'device tag';
	}
	return false;
}

function checkTags(pTags, pAllowed, pFile, pWhere, pViolations)
{
	if (!pTags || typeof pTags !== 'object')
	{
		return;
	}
	Object.keys(pTags).forEach((pKey) =>
		{
			let tmpValue = String(pTags[pKey]);
			let tmpIdentifying = identifyingReason(pKey);
			if (tmpIdentifying)
			{
				pViolations.push({ File: pFile, Where: pWhere, Key: pKey, Value: tmpValue, Reason: tmpIdentifying });
				return;
			}
			if (pAllowed.indexOf(pKey) < 0)
			{
				pViolations.push({ File: pFile, Where: pWhere, Key: pKey, Value: tmpValue, Reason: 'unexpected metadata tag' });
				return;
			}
			if (pKey === 'encoder' && !FFMPEG_ENCODER_PATTERN.test(tmpValue))
			{
				pViolations.push({ File: pFile, Where: pWhere, Key: pKey, Value: tmpValue, Reason: 'encoder tag is not ffmpeg\'s own' });
			}
			if (pKey === 'handler_name' && ALLOWED_HANDLER_NAMES.indexOf(tmpValue) < 0)
			{
				pViolations.push({ File: pFile, Where: pWhere, Key: pKey, Value: tmpValue, Reason: 'non-generic handler name' });
			}
			if (pKey === 'vendor_id' && ALLOWED_VENDOR_IDS.indexOf(tmpValue) < 0)
			{
				pViolations.push({ File: pFile, Where: pWhere, Key: pKey, Value: tmpValue, Reason: 'non-null vendor id' });
			}
		});
}

/**
 * Inspect raw ffprobe JSON (format, streams, chapters). Pure.
 *
 * @param {Object} pRaw
 * @param {string} pFile - label for the violations
 * @returns {Array<Object>} violations
 */
function inspectProbe(pRaw, pFile)
{
	let tmpViolations = [];
	let tmpRaw = pRaw || {};
	let tmpFormat = tmpRaw.format || {};
	checkTags(tmpFormat.tags, ALLOWED_FORMAT_TAGS, pFile, 'format', tmpViolations);

	let tmpStreams = Array.isArray(tmpRaw.streams) ? tmpRaw.streams : [];
	tmpStreams.forEach((pStream) =>
		{
			let tmpWhere = `stream ${pStream.index} (${pStream.codec_type})`;
			if (FORBIDDEN_STREAM_TYPES.indexOf(pStream.codec_type) >= 0)
			{
				tmpViolations.push({ File: pFile, Where: tmpWhere, Key: 'codec_type', Value: pStream.codec_type, Reason: `${pStream.codec_type} stream` });
			}
			if (pStream.disposition && pStream.disposition.attached_pic)
			{
				tmpViolations.push({ File: pFile, Where: tmpWhere, Key: 'disposition', Value: 'attached_pic', Reason: 'attached picture' });
			}
			checkTags(pStream.tags, ALLOWED_STREAM_TAGS, pFile, tmpWhere, tmpViolations);
		});

	if (Array.isArray(tmpRaw.chapters) && tmpRaw.chapters.length > 0)
	{
		tmpViolations.push({ File: pFile, Where: 'chapters', Key: 'chapters', Value: String(tmpRaw.chapters.length), Reason: 'chapters present' });
	}
	return tmpViolations;
}

/**
 * Walk a JPEG's marker segments up to the scan; only APP0 (JFIF) is allowed.
 * Pure.
 *
 * @param {Buffer} pBuffer
 * @param {string} pFile
 * @returns {Array<Object>} violations
 */
function inspectJpeg(pBuffer, pFile)
{
	let tmpViolations = [];
	if (!pBuffer || pBuffer.length < 4 || pBuffer[0] !== 0xFF || pBuffer[1] !== 0xD8)
	{
		tmpViolations.push({ File: pFile, Where: 'jpeg', Key: 'SOI', Value: '', Reason: 'not a JPEG' });
		return tmpViolations;
	}
	let tmpOffset = 2;
	while (tmpOffset + 4 <= pBuffer.length)
	{
		if (pBuffer[tmpOffset] !== 0xFF)
		{
			tmpViolations.push({ File: pFile, Where: 'jpeg', Key: 'marker', Value: String(tmpOffset), Reason: 'malformed JPEG marker stream' });
			break;
		}
		let tmpMarker = pBuffer[tmpOffset + 1];
		if (tmpMarker === 0xFF)
		{
			// Fill byte.
			tmpOffset += 1;
			continue;
		}
		if (tmpMarker === 0xDA || tmpMarker === 0xD9)
		{
			// Start of scan / end of image: no more header segments.
			break;
		}
		let tmpLength = pBuffer.readUInt16BE(tmpOffset + 2);
		let tmpMarkerName = `0xFF${tmpMarker.toString(16).toUpperCase()}`;
		if (tmpMarker >= 0xE1 && tmpMarker <= 0xEF)
		{
			let tmpIdentifier = pBuffer.slice(tmpOffset + 4, Math.min(tmpOffset + 4 + 12, pBuffer.length)).toString('latin1').replace(/[^\x20-\x7E]/g, '');
			tmpViolations.push({ File: pFile, Where: 'jpeg', Key: `APP${tmpMarker - 0xE0}`, Value: tmpIdentifier, Reason: `${tmpMarkerName} application segment (EXIF/XMP/ICC)` });
		}
		else if (tmpMarker === 0xFE)
		{
			tmpViolations.push({ File: pFile, Where: 'jpeg', Key: 'COM', Value: pBuffer.slice(tmpOffset + 4, tmpOffset + 2 + tmpLength).toString('latin1'), Reason: 'JPEG comment' });
		}
		else if (tmpMarker === 0xE0)
		{
			let tmpIdentifier = pBuffer.slice(tmpOffset + 4, tmpOffset + 9).toString('latin1');
			if (tmpIdentifier !== 'JFIF\u0000')
			{
				tmpViolations.push({ File: pFile, Where: 'jpeg', Key: 'APP0', Value: tmpIdentifier.replace(/[^\x20-\x7E]/g, ''), Reason: 'non-JFIF APP0 segment' });
			}
		}
		tmpOffset += 2 + tmpLength;
	}
	return tmpViolations;
}

/**
 * Playlists carry no metadata tags, but a date tag would leak capture time.
 * Pure.
 *
 * @param {string} pText
 * @param {string} pFile
 * @returns {Array<Object>} violations
 */
function inspectPlaylist(pText, pFile)
{
	let tmpViolations = [];
	String(pText || '').split(/\r?\n/).forEach((pLine) =>
		{
			FORBIDDEN_PLAYLIST_TAGS.forEach((pTag) =>
				{
					if (pLine.indexOf(pTag) === 0)
					{
						tmpViolations.push({ File: pFile, Where: 'playlist', Key: pTag, Value: pLine, Reason: 'playlist date tag' });
					}
				});
		});
	return tmpViolations;
}

/**
 * One line per violation, for error messages.
 *
 * @param {Array<Object>} pViolations
 * @returns {string}
 */
function describeViolations(pViolations)
{
	return pViolations.map((pViolation) => `${pViolation.File} ${pViolation.Where}: ${pViolation.Key}=${JSON.stringify(pViolation.Value)} (${pViolation.Reason})`).join('; ');
}

class Sanitiser extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'Sanitiser';

		if (!this.log)
		{
			this.log = this.options.Log || libTools.createFallbackLog(this.options.Verbose);
		}
		this.binaries = libTools.resolveBinaries(this.options);
	}

	_probe(pPath, fCallback)
	{
		let tmpArguments = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', pPath];
		return libTools.spawnCollect(this.binaries.FFprobe, tmpArguments, {}, (pError, pResult) =>
			{
				if (pError)
				{
					return fCallback(pError.Cancelled ? pError : new Error(`Sanitiser: ffprobe is not runnable: ${pError.message}`));
				}
				if (pResult.Code !== 0)
				{
					return fCallback(new Error(`Sanitiser: ffprobe could not read ${libPath.basename(pPath)}: ${libTools.stderrTail(pResult.Stderr)}`));
				}
				try
				{
					return fCallback(null, JSON.parse(pResult.Stdout.toString('utf8')));
				}
				catch (pParseError)
				{
					return fCallback(new Error(`Sanitiser: unparseable ffprobe JSON for ${libPath.basename(pPath)}`));
				}
			});
	}

	/**
	 * Check package files.
	 *
	 * @param {string} pDirectory - the package directory
	 * @param {Array<string>} pRelativePaths - files to check (POSIX, relative)
	 * @param {function} fCallback - (pError, { Passed, Violations, Checked }); a cancel yields an Error with `.Cancelled = true`
	 * @returns {Object} handle { cancel(pImmediate) } (stops the running ffprobe)
	 */
	checkFiles(pDirectory, pRelativePaths, fCallback)
	{
		let tmpViolations = [];
		let tmpChecked = [];
		let tmpQueue = (pRelativePaths || []).slice();
		let tmpState = { Cancelled: false, Current: null, Finished: false };

		let fFinish = (pError, pReport) =>
		{
			if (tmpState.Finished)
			{
				return;
			}
			tmpState.Finished = true;
			return fCallback(pError, pReport);
		};

		let fNext = () =>
		{
			if (tmpState.Cancelled)
			{
				return fFinish(libTools.cancelledError('Sanitise check cancelled.'));
			}
			if (tmpQueue.length < 1)
			{
				return fFinish(null, { Passed: tmpViolations.length < 1, Violations: tmpViolations, Checked: tmpChecked });
			}
			let tmpRelative = tmpQueue.shift();
			let tmpAbsolute = libPath.join(pDirectory, tmpRelative);
			let tmpExtension = libPath.extname(tmpRelative).toLowerCase();

			if (PLAYLIST_EXTENSIONS.indexOf(tmpExtension) >= 0)
			{
				tmpChecked.push(tmpRelative);
				tmpViolations = tmpViolations.concat(inspectPlaylist(libFS.readFileSync(tmpAbsolute, 'utf8'), tmpRelative));
				return setImmediate(fNext);
			}
			if (JPEG_EXTENSIONS.indexOf(tmpExtension) >= 0)
			{
				tmpViolations = tmpViolations.concat(inspectJpeg(libFS.readFileSync(tmpAbsolute), tmpRelative));
			}
			if (MEDIA_EXTENSIONS.indexOf(tmpExtension) < 0 && JPEG_EXTENSIONS.indexOf(tmpExtension) < 0)
			{
				return setImmediate(fNext);
			}
			tmpChecked.push(tmpRelative);
			tmpState.Current = this._probe(tmpAbsolute, (pError, pRaw) =>
				{
					tmpState.Current = null;
					if (pError)
					{
						return fFinish(pError);
					}
					tmpViolations = tmpViolations.concat(inspectProbe(pRaw, tmpRelative));
					return fNext();
				});
		};
		// Asynchronous start: the caller holds the handle before any callback.
		setImmediate(fNext);

		return (
			{
				cancel: (pImmediate) =>
				{
					if (tmpState.Finished || (tmpState.Cancelled && !pImmediate))
					{
						return false;
					}
					tmpState.Cancelled = true;
					if (tmpState.Current)
					{
						tmpState.Current.cancel(pImmediate);
					}
					return true;
				}
			});
	}
}

module.exports = Sanitiser;
module.exports.inspectProbe = inspectProbe;
module.exports.inspectJpeg = inspectJpeg;
module.exports.inspectPlaylist = inspectPlaylist;
module.exports.describeViolations = describeViolations;
module.exports.identifyingReason = identifyingReason;
module.exports.ALLOWED_FORMAT_TAGS = ALLOWED_FORMAT_TAGS;
module.exports.ALLOWED_STREAM_TAGS = ALLOWED_STREAM_TAGS;
