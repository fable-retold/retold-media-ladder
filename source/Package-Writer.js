/**
* Retold Media Ladder -- PackageWriter
*
* Finishes a package directory after the encode:
*
*   1. Reorders `master.m3u8` so the 540p rung (or the closest rung at or
*      below 540) is FIRST: native Safari and hls.js (startLevel unset) both
*      start on the first variant, and Apple recommends ~2 Mbps to start.
*   2. Hashes every file and writes `package.json` -- the one wire contract the
*      encoder, the server and the player share (see the README):
*      Version, Kind, PackageVersion, DurationMS, displayed Width/Height,
*      SegmentSeconds, HasAudio, Manifest, Poster, Download, Renditions
*      (top rung first; BANDWIDTH/CODECS copied from ffmpeg's master), Audio
*      and Files[] ({Path, Bytes, Sha256} for every file but package.json).
*
* PackageVersion = first 8 hex of sha256(stable-JSON(plan) + ffmpeg version
* line + source sha256).  It identifies the INPUTS, not the bytes: the plan is
* fingerprinted without its Warnings and without the LUT's file path (its
* sha256 stays), so moving a LUT or a new warning wording never changes the
* version, while any change to the plan, ffmpeg or the source does.  Two
* encodes with the same inputs share a PackageVersion but NOT their bytes
* (x264 VBV rate control with threads, and VideoToolbox, are not
* deterministic), which is why a finished package is verified and reused,
* never re-encoded in place (see `verifyPackage`).
*
* ffmpeg 7.1 writes a master playlist with no variants at all when every
* segment is 0.5 s or shorter (it leaves those out of its peak bitrate, then
* reports "Bandwidth info not available"); `reorderMasterFile` rebuilds the
* master from the rung playlists in that case, with ffmpeg's own formula.
*
* The parsing / reordering / document-building functions are pure.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libFS = require('node:fs');
const libPath = require('node:path');

const libTools = require('./Media-Ladder-Tools.js');

const PACKAGE_FILE = 'package.json';
const MASTER_FILE = 'master.m3u8';
const PACKAGE_DOCUMENT_VERSION = 1;

/**
 * Parse an HLS attribute list (`A=1,B="x,y",C=z`). Pure.
 *
 * @param {string} pText
 * @returns {Object}
 */
function parseAttributeList(pText)
{
	let tmpAttributes = {};
	let tmpPattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
	let tmpMatch;
	while ((tmpMatch = tmpPattern.exec(String(pText || ''))) !== null)
	{
		let tmpValue = tmpMatch[2];
		if (tmpValue.length >= 2 && tmpValue[0] === '"' && tmpValue[tmpValue.length - 1] === '"')
		{
			tmpValue = tmpValue.slice(1, -1);
		}
		tmpAttributes[tmpMatch[1]] = tmpValue;
	}
	return tmpAttributes;
}

/**
 * Parse a master playlist into its header and variant blocks. Pure.
 *
 * @param {string} pText
 * @returns {Object} { Header: [lines], Variants: [{ InfLine, Attributes, URI, Bandwidth, Codecs, Width, Height }] }
 */
function parseMasterPlaylist(pText)
{
	let tmpLines = String(pText || '').split(/\r?\n/);
	let tmpHeader = [];
	let tmpVariants = [];
	for (let i = 0; i < tmpLines.length; i++)
	{
		let tmpLine = tmpLines[i].trim();
		if (tmpLine.length < 1)
		{
			continue;
		}
		if (tmpLine.indexOf('#EXT-X-STREAM-INF:') === 0)
		{
			// The URI is the next non-blank, non-comment line.
			let tmpURI = null;
			for (let j = i + 1; j < tmpLines.length; j++)
			{
				let tmpCandidate = tmpLines[j].trim();
				if (tmpCandidate.length > 0 && tmpCandidate[0] !== '#')
				{
					tmpURI = tmpCandidate;
					i = j;
					break;
				}
			}
			let tmpAttributes = parseAttributeList(tmpLine.slice('#EXT-X-STREAM-INF:'.length));
			let tmpResolution = String(tmpAttributes.RESOLUTION || '').split('x');
			tmpVariants.push(
				{
					InfLine: tmpLine,
					Attributes: tmpAttributes,
					URI: tmpURI,
					Bandwidth: Number(tmpAttributes.BANDWIDTH) || 0,
					Codecs: tmpAttributes.CODECS || null,
					Width: Number(tmpResolution[0]) || 0,
					Height: Number(tmpResolution[1]) || 0
				});
			continue;
		}
		if (tmpVariants.length < 1)
		{
			tmpHeader.push(tmpLine);
		}
	}
	return { Header: tmpHeader, Variants: tmpVariants };
}

/**
 * Re-emit a master playlist with the variant whose URI is pFirstURI first and
 * the rest in their original order. Pure.
 *
 * @param {string} pText
 * @param {string} pFirstURI
 * @returns {string}
 */
function reorderMaster(pText, pFirstURI)
{
	let tmpParsed = parseMasterPlaylist(pText);
	let tmpFirst = tmpParsed.Variants.filter((pVariant) => pVariant.URI === pFirstURI);
	if (tmpFirst.length < 1)
	{
		throw new Error(`The master playlist has no variant ${pFirstURI}.`);
	}
	let tmpOrdered = tmpFirst.concat(tmpParsed.Variants.filter((pVariant) => pVariant.URI !== pFirstURI));
	let tmpOut = tmpParsed.Header.slice();
	tmpOrdered.forEach((pVariant) =>
		{
			tmpOut.push(pVariant.InfLine);
			tmpOut.push(pVariant.URI);
		});
	return tmpOut.join('\n') + '\n';
}

/**
 * Parse a media (rung) playlist. Pure.
 *
 * @param {string} pText
 * @returns {Object} { Map, Segments, DurationSeconds, TargetDuration, PlaylistType, IndependentSegments, EndList }
 */
function parseMediaPlaylist(pText)
{
	let tmpLines = String(pText || '').split(/\r?\n/);
	let tmpResult =
	{
		Map: null,
		Segments: [],
		DurationSeconds: 0,
		TargetDuration: 0,
		PlaylistType: null,
		IndependentSegments: false,
		EndList: false
	};
	let tmpPending = null;
	for (let i = 0; i < tmpLines.length; i++)
	{
		let tmpLine = tmpLines[i].trim();
		if (tmpLine.length < 1)
		{
			continue;
		}
		if (tmpLine.indexOf('#EXT-X-MAP:') === 0)
		{
			let tmpAttributes = parseAttributeList(tmpLine.slice('#EXT-X-MAP:'.length));
			tmpResult.Map = { URI: tmpAttributes.URI || null, ByteRange: tmpAttributes.BYTERANGE || null };
		}
		else if (tmpLine.indexOf('#EXTINF:') === 0)
		{
			tmpPending = { Duration: parseFloat(tmpLine.slice('#EXTINF:'.length)) || 0, ByteRange: null, URI: null };
		}
		else if (tmpLine.indexOf('#EXT-X-BYTERANGE:') === 0)
		{
			if (tmpPending)
			{
				tmpPending.ByteRange = tmpLine.slice('#EXT-X-BYTERANGE:'.length);
			}
		}
		else if (tmpLine.indexOf('#EXT-X-TARGETDURATION:') === 0)
		{
			tmpResult.TargetDuration = Number(tmpLine.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
		}
		else if (tmpLine.indexOf('#EXT-X-PLAYLIST-TYPE:') === 0)
		{
			tmpResult.PlaylistType = tmpLine.slice('#EXT-X-PLAYLIST-TYPE:'.length);
		}
		else if (tmpLine === '#EXT-X-INDEPENDENT-SEGMENTS')
		{
			tmpResult.IndependentSegments = true;
		}
		else if (tmpLine === '#EXT-X-ENDLIST')
		{
			tmpResult.EndList = true;
		}
		else if (tmpLine[0] !== '#' && tmpPending)
		{
			tmpPending.URI = tmpLine;
			tmpResult.Segments.push(tmpPending);
			tmpResult.DurationSeconds += tmpPending.Duration;
			tmpPending = null;
		}
	}
	return tmpResult;
}

/**
 * Parse an HLS BYTERANGE (`<length>[@<offset>]`). Pure.
 *
 * @param {string} pText
 * @returns {Object|null} { Length, Offset } (Offset null when absent)
 */
function parseByteRange(pText)
{
	let tmpMatch = /^(\d+)(?:@(\d+))?$/.exec(String(pText || '').trim());
	if (!tmpMatch)
	{
		return null;
	}
	return { Length: Number(tmpMatch[1]), Offset: (typeof tmpMatch[2] === 'string') ? Number(tmpMatch[2]) : null };
}

/**
 * Peak and average bitrate of a parsed rung playlist, the way ffmpeg's HLS
 * muxer measures them (segment bytes * 8 / segment duration; the init
 * section is not counted) -- except that a segment of 0.5 s or less counts
 * too, since it may be the only one. Pure.
 *
 * @param {Object} pMediaPlaylist - from parseMediaPlaylist
 * @returns {Object} { Bandwidth, AverageBandwidth }
 */
function measureBandwidth(pMediaPlaylist)
{
	let tmpPeak = 0;
	let tmpBytes = 0;
	let tmpSeconds = 0;
	(pMediaPlaylist.Segments || []).forEach((pSegment) =>
		{
			let tmpRange = parseByteRange(pSegment.ByteRange);
			if (!tmpRange || !(pSegment.Duration > 0))
			{
				return;
			}
			tmpBytes += tmpRange.Length;
			tmpSeconds += pSegment.Duration;
			tmpPeak = Math.max(tmpPeak, Math.floor((8 * tmpRange.Length) / pSegment.Duration));
		});
	return { Bandwidth: tmpPeak, AverageBandwidth: (tmpSeconds > 0) ? Math.floor((8 * tmpBytes) / tmpSeconds) : 0 };
}

/**
 * RFC 6381 CODECS for an fMP4 init section: `avc1.PPCCLL` from the avcC
 * box, plus `mp4a.40.2` when an AAC (LC -- the ladder's only audio encoder)
 * sample entry is present. Pure.
 *
 * @param {Buffer} pInit
 * @returns {string|null} null when no avcC box is found
 */
function codecsFromInit(pInit)
{
	let tmpAvcC = pInit.indexOf(Buffer.from('avcC', 'latin1'));
	if (tmpAvcC < 4 || tmpAvcC + 8 > pInit.length)
	{
		return null;
	}
	// avcC: configurationVersion, AVCProfileIndication, profile_compatibility, AVCLevelIndication.
	let fHex = (pByte) => pByte.toString(16).padStart(2, '0');
	let tmpCodecs = [`avc1.${fHex(pInit[tmpAvcC + 5])}${fHex(pInit[tmpAvcC + 6])}${fHex(pInit[tmpAvcC + 7])}`];
	if (pInit.indexOf(Buffer.from('mp4a', 'latin1')) >= 0)
	{
		tmpCodecs.push('mp4a.40.2');
	}
	return tmpCodecs.join(',');
}

/**
 * Build a master playlist from per-rung facts, top rung first. Pure.
 *
 * @param {Array<string>} pHeader - header lines (e.g. #EXTM3U, #EXT-X-VERSION:7)
 * @param {Array<Object>} pVariants - [{ URI, Bandwidth, AverageBandwidth, Width, Height, Codecs }]
 * @returns {string}
 */
function buildMasterPlaylist(pHeader, pVariants)
{
	let tmpHeader = (pHeader && pHeader.length > 0) ? pHeader.slice() : ['#EXTM3U', '#EXT-X-VERSION:7'];
	pVariants.forEach((pVariant) =>
		{
			let tmpAttributes = [`BANDWIDTH=${pVariant.Bandwidth}`];
			if (pVariant.AverageBandwidth > 0)
			{
				tmpAttributes.push(`AVERAGE-BANDWIDTH=${pVariant.AverageBandwidth}`);
			}
			tmpAttributes.push(`RESOLUTION=${pVariant.Width}x${pVariant.Height}`);
			if (pVariant.Codecs)
			{
				tmpAttributes.push(`CODECS="${pVariant.Codecs}"`);
			}
			tmpHeader.push(`#EXT-X-STREAM-INF:${tmpAttributes.join(',')}`);
			tmpHeader.push(pVariant.URI);
		});
	return tmpHeader.join('\n') + '\n';
}

/**
 * The parts of a plan that determine the bytes. Pure.
 *
 * @param {Object} pPlan
 * @returns {Object}
 */
function planFingerprint(pPlan)
{
	let tmpCopy = JSON.parse(JSON.stringify(pPlan || {}));
	delete tmpCopy.Warnings;
	if (tmpCopy.Colour && tmpCopy.Colour.Lut)
	{
		delete tmpCopy.Colour.Lut.File;
		// The filter string embeds the path; the digest identifies the LUT.
		tmpCopy.Colour.Filter = 'lut3d';
	}
	return tmpCopy;
}

/**
 * PackageVersion = first 8 hex of sha256(stable-JSON(plan) + ffmpeg version + source sha256). Pure.
 *
 * @param {Object} pPlan
 * @param {string} pFfmpegVersion
 * @param {string} pSourceSha256
 * @returns {string}
 */
function computePackageVersion(pPlan, pFfmpegVersion, pSourceSha256)
{
	let tmpMaterial = libTools.stableStringify(planFingerprint(pPlan)) + String(pFfmpegVersion || '') + String(pSourceSha256 || '');
	return libTools.sha256Hex(tmpMaterial).slice(0, 8);
}

/**
 * Every file under a package directory, as sorted POSIX relative paths,
 * excluding package.json. Synchronous; packages hold a dozen files.
 *
 * @param {string} pDirectory
 * @returns {Array<string>}
 */
function listPackageFiles(pDirectory)
{
	let tmpFiles = [];
	let fWalk = (pAbsolute, pRelative) =>
	{
		let tmpEntries = libFS.readdirSync(pAbsolute, { withFileTypes: true });
		tmpEntries.forEach((pEntry) =>
			{
				let tmpRelative = pRelative ? `${pRelative}/${pEntry.name}` : pEntry.name;
				let tmpAbsolute = libPath.join(pAbsolute, pEntry.name);
				if (pEntry.isDirectory())
				{
					fWalk(tmpAbsolute, tmpRelative);
				}
				else if (pEntry.isFile() && tmpRelative !== PACKAGE_FILE)
				{
					tmpFiles.push(tmpRelative);
				}
			});
	};
	fWalk(pDirectory, '');
	return tmpFiles.sort();
}

/**
 * Build the package.json document. Pure.
 *
 * @param {Object} pContext
 *   - PackageVersion, Plan
 *   - Variants: parsed master variants (any order)
 *   - DurationSeconds: from the top rung's playlist
 *   - Files: [{ Path, Bytes, Sha256 }]
 *   - HasPoster, HasDownload
 * @returns {Object}
 */
function buildPackageDocument(pContext)
{
	let tmpPlan = pContext.Plan;
	let tmpFilesByPath = {};
	(pContext.Files || []).forEach((pFile) => { tmpFilesByPath[pFile.Path] = pFile; });

	let tmpRenditions = tmpPlan.Rungs.map((pRung) =>
		{
			let tmpVariant = (pContext.Variants || []).filter((pCandidate) => pCandidate.URI === pRung.Playlist)[0];
			if (!tmpVariant)
			{
				throw new Error(`The master playlist has no variant for ${pRung.Playlist}.`);
			}
			let tmpMedia = tmpFilesByPath[pRung.File];
			if (!tmpMedia)
			{
				throw new Error(`The package is missing ${pRung.File}.`);
			}
			if (!tmpFilesByPath[pRung.Playlist])
			{
				throw new Error(`The package is missing ${pRung.Playlist}.`);
			}
			let tmpWidth = tmpVariant.Width || pRung.Width;
			let tmpHeight = tmpVariant.Height || pRung.Height;
			let tmpShortSide = Math.min(tmpWidth, tmpHeight);
			return (
				{
					Name: `${tmpShortSide}p`,
					ShortSide: tmpShortSide,
					Width: tmpWidth,
					Height: tmpHeight,
					FrameRate: tmpPlan.FrameRate.OutputValue,
					Bandwidth: tmpVariant.Bandwidth,
					Codecs: tmpVariant.Codecs,
					Playlist: pRung.Playlist,
					File: pRung.File,
					Bytes: tmpMedia.Bytes,
					Sha256: tmpMedia.Sha256
				});
		});

	let tmpTop = tmpRenditions[0];
	return (
		{
			Version: PACKAGE_DOCUMENT_VERSION,
			Kind: 'video',
			PackageVersion: pContext.PackageVersion,
			DurationMS: Math.round((Number(pContext.DurationSeconds) || 0) * 1000),
			Width: tmpTop.Width,
			Height: tmpTop.Height,
			SegmentSeconds: tmpPlan.SegmentSeconds,
			HasAudio: !!(tmpPlan.Audio && tmpPlan.Audio.Enabled),
			Manifest: MASTER_FILE,
			Poster: pContext.HasPoster ? 'poster.jpg' : null,
			Download: pContext.HasDownload ? 'download.mp4' : null,
			Renditions: tmpRenditions,
			Audio: null,
			Files: (pContext.Files || []).map((pFile) => ({ Path: pFile.Path, Bytes: pFile.Bytes, Sha256: pFile.Sha256 }))
		});
}

class PackageWriter extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'PackageWriter';

		if (!this.log)
		{
			this.log = this.options.Log || libTools.createFallbackLog(this.options.Verbose);
		}
	}

	computePackageVersion(pPlan, pFfmpegVersion, pSourceSha256)
	{
		return computePackageVersion(pPlan, pFfmpegVersion, pSourceSha256);
	}

	/**
	 * Reorder the master playlist in place so the plan's first variant leads.
	 * When ffmpeg's master is missing any rung (ffmpeg 7.1 writes NO variants
	 * when every segment is 0.5 s or shorter), it is first rebuilt from the
	 * rung playlists and init sections; a rung playlist whose
	 * EXT-X-TARGETDURATION came out as 0 is raised to 1.
	 *
	 * @param {string} pDirectory
	 * @param {Object} pPlan
	 * @returns {Array<Object>} the parsed variants in ffmpeg's original order (rung order when rebuilt)
	 */
	reorderMasterFile(pDirectory, pPlan)
	{
		let tmpMasterPath = libPath.join(pDirectory, MASTER_FILE);
		let tmpText = libFS.readFileSync(tmpMasterPath, 'utf8');
		let tmpParsed = parseMasterPlaylist(tmpText);
		let tmpURIs = tmpParsed.Variants.map((pVariant) => pVariant.URI);
		let tmpMissing = pPlan.Rungs.filter((pRung) => tmpURIs.indexOf(pRung.Playlist) < 0);
		if (tmpMissing.length > 0)
		{
			this.log.warn(`PackageWriter: ffmpeg's master playlist is missing ${tmpMissing.map((pRung) => pRung.Playlist).join(', ')} (it leaves out variants whose segments are all 0.5 s or shorter); rebuilding it from the rung playlists.`);
			tmpText = buildMasterPlaylist(tmpParsed.Header, this.measureRungs(pDirectory, pPlan));
			tmpParsed = parseMasterPlaylist(tmpText);
		}
		let tmpFirstURI = pPlan.Rungs[pPlan.FirstVariantIndex].Playlist;
		libFS.writeFileSync(tmpMasterPath, reorderMaster(tmpText, tmpFirstURI));
		return tmpParsed.Variants;
	}

	/**
	 * Master-playlist facts for every rung, read from its playlist and init
	 * section (RESOLUTION from the plan).  Also raises a zero
	 * EXT-X-TARGETDURATION (a sub-0.5 s clip) to 1, which the HLS spec allows
	 * and players expect.
	 *
	 * @param {string} pDirectory
	 * @param {Object} pPlan
	 * @returns {Array<Object>} [{ URI, Bandwidth, AverageBandwidth, Width, Height, Codecs }]
	 */
	measureRungs(pDirectory, pPlan)
	{
		return pPlan.Rungs.map((pRung) =>
			{
				let tmpPlaylistPath = libPath.join(pDirectory, pRung.Playlist);
				let tmpPlaylistText = libFS.readFileSync(tmpPlaylistPath, 'utf8');
				if (/^#EXT-X-TARGETDURATION:0[ \t]*$/m.test(tmpPlaylistText))
				{
					tmpPlaylistText = tmpPlaylistText.replace(/^#EXT-X-TARGETDURATION:0[ \t]*$/m, '#EXT-X-TARGETDURATION:1');
					libFS.writeFileSync(tmpPlaylistPath, tmpPlaylistText);
				}
				let tmpPlaylist = parseMediaPlaylist(tmpPlaylistText);
				let tmpBandwidth = measureBandwidth(tmpPlaylist);
				if (!(tmpBandwidth.Bandwidth > 0))
				{
					throw new Error(`${pRung.Playlist} has no measurable segments.`);
				}
				let tmpMap = tmpPlaylist.Map ? parseByteRange(tmpPlaylist.Map.ByteRange) : null;
				let tmpMedia = libPath.join(libPath.dirname(tmpPlaylistPath), (tmpPlaylist.Map && tmpPlaylist.Map.URI) || 'media.mp4');
				let tmpInitLength = tmpMap ? tmpMap.Length : 4096;
				let tmpInit = Buffer.alloc(tmpInitLength);
				let tmpDescriptor = libFS.openSync(tmpMedia, 'r');
				let tmpRead;
				try
				{
					tmpRead = libFS.readSync(tmpDescriptor, tmpInit, 0, tmpInitLength, (tmpMap && tmpMap.Offset) || 0);
				}
				finally
				{
					libFS.closeSync(tmpDescriptor);
				}
				let tmpCodecs = codecsFromInit(tmpInit.subarray(0, tmpRead));
				if (!tmpCodecs)
				{
					throw new Error(`${pRung.File} has no avcC box in its init section.`);
				}
				return (
					{
						URI: pRung.Playlist,
						Bandwidth: tmpBandwidth.Bandwidth,
						AverageBandwidth: tmpBandwidth.AverageBandwidth,
						Width: pRung.Width,
						Height: pRung.Height,
						Codecs: tmpCodecs
					});
			});
	}

	/**
	 * Verify a finished package on disk: package.json parses, is Version 1
	 * with the expected PackageVersion, and every file in Files[] exists with
	 * its recorded Bytes and Sha256.
	 *
	 * @param {string} pDirectory
	 * @param {string} pPackageVersion - the version the directory should hold
	 * @param {function} fCallback - (pError, { Intact, Problems: [string], Document })
	 * @returns {Object} handle { cancel() }
	 */
	verifyPackage(pDirectory, pPackageVersion, fCallback)
	{
		let tmpProblems = [];
		let fDamaged = (pProblem, pDocument) =>
		{
			tmpProblems.push(pProblem);
			setImmediate(() => fCallback(null, { Intact: false, Problems: tmpProblems, Document: pDocument || null }));
			return libTools.inertHandle();
		};
		let tmpDocument;
		try
		{
			tmpDocument = JSON.parse(libFS.readFileSync(libPath.join(pDirectory, PACKAGE_FILE), 'utf8'));
		}
		catch (pError)
		{
			return fDamaged((pError.code === 'ENOENT') ? `no ${PACKAGE_FILE}` : `unreadable ${PACKAGE_FILE} (${pError.message})`);
		}
		if (!tmpDocument || typeof tmpDocument !== 'object' || tmpDocument.Version !== PACKAGE_DOCUMENT_VERSION || !Array.isArray(tmpDocument.Files))
		{
			return fDamaged(`${PACKAGE_FILE} is not a version ${PACKAGE_DOCUMENT_VERSION} package document`, tmpDocument);
		}
		if (tmpDocument.PackageVersion !== pPackageVersion)
		{
			return fDamaged(`${PACKAGE_FILE} names PackageVersion ${tmpDocument.PackageVersion}`, tmpDocument);
		}
		let tmpPresent = [];
		tmpDocument.Files.forEach((pFile) =>
			{
				let tmpRelative = String((pFile && pFile.Path) || '');
				let tmpAbsolute = libPath.resolve(pDirectory, tmpRelative);
				if (!tmpRelative || tmpAbsolute.indexOf(libPath.resolve(pDirectory) + libPath.sep) !== 0)
				{
					tmpProblems.push(`bad file path ${JSON.stringify(tmpRelative)}`);
					return;
				}
				let tmpStat;
				try
				{
					tmpStat = libFS.statSync(tmpAbsolute);
				}
				catch (pError)
				{
					tmpProblems.push(`${tmpRelative} is missing`);
					return;
				}
				if (!tmpStat.isFile() || tmpStat.size !== pFile.Bytes)
				{
					tmpProblems.push(`${tmpRelative} is ${tmpStat.size} bytes, not ${pFile.Bytes}`);
					return;
				}
				tmpPresent.push(pFile);
			});
		if (tmpProblems.length > 0)
		{
			setImmediate(() => fCallback(null, { Intact: false, Problems: tmpProblems, Document: tmpDocument }));
			return libTools.inertHandle();
		}
		return this.hashFiles(pDirectory, tmpPresent.map((pFile) => pFile.Path), (pError, pHashed) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				pHashed.forEach((pHashedFile, pIndex) =>
					{
						if (pHashedFile.Sha256 !== tmpPresent[pIndex].Sha256)
						{
							tmpProblems.push(`${pHashedFile.Path} does not match its Sha256`);
						}
					});
				return fCallback(null, { Intact: tmpProblems.length < 1, Problems: tmpProblems, Document: tmpDocument });
			});
	}

	/**
	 * Hash files (sequentially) into [{ Path, Bytes, Sha256 }].
	 *
	 * @param {string} pDirectory
	 * @param {Array<string>} pRelativePaths
	 * @param {function} fCallback - (pError, pFiles); a cancel yields an Error with `.Cancelled = true`
	 * @returns {Object} handle { cancel() }
	 */
	hashFiles(pDirectory, pRelativePaths, fCallback)
	{
		let tmpQueue = pRelativePaths.slice();
		let tmpFiles = [];
		let tmpState = { Cancelled: false, Current: null, Finished: false };
		let fFinish = (pError, pFiles) =>
		{
			if (tmpState.Finished)
			{
				return;
			}
			tmpState.Finished = true;
			return fCallback(pError, pFiles);
		};
		let fNext = () =>
		{
			if (tmpState.Cancelled)
			{
				return fFinish(libTools.cancelledError('Hashing cancelled.'));
			}
			if (tmpQueue.length < 1)
			{
				return fFinish(null, tmpFiles);
			}
			let tmpRelative = tmpQueue.shift();
			let tmpAbsolute = libPath.join(pDirectory, tmpRelative);
			tmpState.Current = libTools.sha256File(tmpAbsolute, (pError, pDigest) =>
				{
					tmpState.Current = null;
					if (pError)
					{
						return fFinish(pError);
					}
					tmpFiles.push({ Path: tmpRelative, Bytes: libFS.statSync(tmpAbsolute).size, Sha256: pDigest });
					return fNext();
				});
		};
		// Asynchronous start: the caller holds the handle before any callback.
		setImmediate(fNext);
		return (
			{
				cancel: () =>
				{
					if (tmpState.Finished || tmpState.Cancelled)
					{
						return false;
					}
					tmpState.Cancelled = true;
					if (tmpState.Current)
					{
						tmpState.Current.cancel();
					}
					return true;
				}
			});
	}

	/**
	 * Reorder the master (unless already done), hash every file and write
	 * package.json.
	 *
	 * @param {string} pDirectory - the package directory being built
	 * @param {Object} pContext - { Plan, PackageVersion, Variants? }
	 * @param {function} fCallback - (pError, pPackageDocument)
	 * @returns {Object} handle { cancel() } (cancels the hashing)
	 */
	write(pDirectory, pContext, fCallback)
	{
		let tmpVariants;
		let tmpDurationSeconds;
		try
		{
			tmpVariants = pContext.Variants || this.reorderMasterFile(pDirectory, pContext.Plan);
			let tmpTopPlaylist = libFS.readFileSync(libPath.join(pDirectory, pContext.Plan.Rungs[0].Playlist), 'utf8');
			tmpDurationSeconds = parseMediaPlaylist(tmpTopPlaylist).DurationSeconds;
		}
		catch (pError)
		{
			setImmediate(() => fCallback(pError));
			return libTools.inertHandle();
		}

		let tmpRelativePaths = listPackageFiles(pDirectory);
		return this.hashFiles(pDirectory, tmpRelativePaths, (pError, pFiles) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				let tmpDocument;
				try
				{
					tmpDocument = buildPackageDocument(
						{
							PackageVersion: pContext.PackageVersion,
							Plan: pContext.Plan,
							Variants: tmpVariants,
							DurationSeconds: tmpDurationSeconds,
							Files: pFiles,
							HasPoster: tmpRelativePaths.indexOf('poster.jpg') >= 0,
							HasDownload: tmpRelativePaths.indexOf('download.mp4') >= 0
						});
					libFS.writeFileSync(libPath.join(pDirectory, PACKAGE_FILE), JSON.stringify(tmpDocument, null, '\t') + '\n');
				}
				catch (pBuildError)
				{
					return fCallback(pBuildError);
				}
				return fCallback(null, tmpDocument);
			});
	}
}

module.exports = PackageWriter;
module.exports.parseAttributeList = parseAttributeList;
module.exports.parseMasterPlaylist = parseMasterPlaylist;
module.exports.reorderMaster = reorderMaster;
module.exports.parseMediaPlaylist = parseMediaPlaylist;
module.exports.parseByteRange = parseByteRange;
module.exports.measureBandwidth = measureBandwidth;
module.exports.codecsFromInit = codecsFromInit;
module.exports.buildMasterPlaylist = buildMasterPlaylist;
module.exports.planFingerprint = planFingerprint;
module.exports.computePackageVersion = computePackageVersion;
module.exports.listPackageFiles = listPackageFiles;
module.exports.buildPackageDocument = buildPackageDocument;
module.exports.PACKAGE_FILE = PACKAGE_FILE;
module.exports.MASTER_FILE = MASTER_FILE;
module.exports.PACKAGE_DOCUMENT_VERSION = PACKAGE_DOCUMENT_VERSION;
