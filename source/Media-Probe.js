/**
* Retold Media Ladder -- MediaProbe
*
* Runs ffprobe for the FULL JSON (format + every stream) and condenses it into
* the handful of facts the ladder planner decides on:
*
*   - transfer function (HLG `arib-std-b67`, PQ `smpte2084`, otherwise SDR),
*     primaries, matrix and range
*   - display rotation, read from the Display Matrix side data (or the legacy
*     `rotate` tag), and the DISPLAYED width/height that follow from it
*   - frame rate, pixel format and bit depth
*   - whether ANY audio stream exists (DJI Mini / Air drones record none)
*
* `summarize(pRaw)` is pure and is what the tests drive with fixtures; the
* raw ffprobe JSON rides along on the summary as `Raw`.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libTools = require('./Media-Ladder-Tools.js');

const TRANSFER_HLG = 'arib-std-b67';
const TRANSFER_PQ = 'smpte2084';

/**
 * Normalise a rotation in degrees to 0, 90, 180 or 270.
 *
 * @param {number} pDegrees
 * @returns {number}
 */
function normalizeRotation(pDegrees)
{
	let tmpDegrees = Number(pDegrees);
	if (!isFinite(tmpDegrees))
	{
		return 0;
	}
	let tmpQuarter = Math.round(tmpDegrees / 90) * 90;
	return ((tmpQuarter % 360) + 360) % 360;
}

/**
 * Read a stream's display rotation: Display Matrix side data first (ffmpeg 5+),
 * then the legacy `rotate` tag.
 *
 * @param {Object} pStream
 * @returns {number} 0, 90, 180 or 270
 */
function streamRotation(pStream)
{
	if (Array.isArray(pStream.side_data_list))
	{
		for (let i = 0; i < pStream.side_data_list.length; i++)
		{
			let tmpSideData = pStream.side_data_list[i];
			if (tmpSideData && (typeof tmpSideData.rotation !== 'undefined'))
			{
				return normalizeRotation(tmpSideData.rotation);
			}
		}
	}
	if (pStream.tags && (typeof pStream.tags.rotate !== 'undefined'))
	{
		return normalizeRotation(pStream.tags.rotate);
	}
	return 0;
}

/**
 * Bit depth from bits_per_raw_sample, else from the pixel format name
 * (yuv420p10le -> 10, p010le -> 10, yuv420p -> 8).
 *
 * @param {Object} pStream
 * @returns {number}
 */
function streamBitDepth(pStream)
{
	let tmpRaw = Number(pStream.bits_per_raw_sample);
	if (tmpRaw > 0)
	{
		return tmpRaw;
	}
	let tmpPixelFormat = String(pStream.pix_fmt || '');
	let tmpMatch = tmpPixelFormat.match(/p(\d{2})(le|be)$/);
	if (tmpMatch)
	{
		return Number(tmpMatch[1]);
	}
	tmpMatch = tmpPixelFormat.match(/^p0(\d{2})/);
	if (tmpMatch)
	{
		return Number(tmpMatch[1]);
	}
	return 8;
}

/**
 * Map an ffprobe color_transfer to the ladder's three transfer classes.
 *
 * @param {string} pColorTransfer
 * @returns {string} 'hlg' | 'pq' | 'sdr'
 */
function classifyTransfer(pColorTransfer)
{
	if (pColorTransfer === TRANSFER_HLG)
	{
		return 'hlg';
	}
	if (pColorTransfer === TRANSFER_PQ)
	{
		return 'pq';
	}
	return 'sdr';
}

/**
 * Condense full ffprobe JSON into the ladder's probe summary. Pure.
 *
 * @param {Object} pRaw - ffprobe `-show_format -show_streams` JSON
 * @returns {Object} summary
 */
function summarize(pRaw)
{
	let tmpRaw = pRaw || {};
	let tmpStreams = Array.isArray(tmpRaw.streams) ? tmpRaw.streams : [];
	let tmpFormat = tmpRaw.format || {};

	let tmpVideoStreams = tmpStreams.filter((pStream) => pStream.codec_type === 'video' && !(pStream.disposition && pStream.disposition.attached_pic));
	let tmpAudioStreams = tmpStreams.filter((pStream) => pStream.codec_type === 'audio');

	let tmpSummary =
	{
		FormatName: tmpFormat.format_name || null,
		DurationSeconds: Number(tmpFormat.duration) > 0 ? Number(tmpFormat.duration) : 0,
		Size: Number(tmpFormat.size) > 0 ? Number(tmpFormat.size) : 0,
		BitRate: Number(tmpFormat.bit_rate) > 0 ? Number(tmpFormat.bit_rate) : 0,
		HasVideo: tmpVideoStreams.length > 0,
		HasAudio: tmpAudioStreams.length > 0,
		AudioStreamCount: tmpAudioStreams.length,
		DataStreamCount: tmpStreams.filter((pStream) => pStream.codec_type === 'data').length,
		SubtitleStreamCount: tmpStreams.filter((pStream) => pStream.codec_type === 'subtitle').length,
		Video: null,
		Audio: null,
		Raw: tmpRaw
	};

	if (tmpVideoStreams.length > 0)
	{
		let tmpStream = tmpVideoStreams[0];
		let tmpWidth = Number(tmpStream.width) || 0;
		let tmpHeight = Number(tmpStream.height) || 0;
		let tmpRotation = streamRotation(tmpStream);

		// Non-square pixels: the displayed width stretches by the SAR.
		let tmpSAR = libTools.parseRational(String(tmpStream.sample_aspect_ratio || '').replace(':', '/'));
		let tmpStoredDisplayWidth = tmpWidth;
		if (tmpSAR && tmpSAR.Value !== 1)
		{
			tmpStoredDisplayWidth = Math.round(tmpWidth * tmpSAR.Value);
		}
		let tmpSwap = (tmpRotation === 90 || tmpRotation === 270);

		let tmpFrameRate = libTools.parseRational(tmpStream.r_frame_rate);
		let tmpAverageFrameRate = libTools.parseRational(tmpStream.avg_frame_rate);
		// r_frame_rate is the container's base rate; fall back to the average
		// when it is missing or absurd (some VFR phone files report 90000/1).
		let tmpChosenRate = tmpFrameRate;
		if (!tmpChosenRate || tmpChosenRate.Value > 1000)
		{
			tmpChosenRate = tmpAverageFrameRate;
		}

		let tmpColorTransfer = tmpStream.color_transfer || null;
		let tmpTransfer = classifyTransfer(tmpColorTransfer);

		tmpSummary.Video =
		{
			Index: tmpStream.index,
			Codec: tmpStream.codec_name || null,
			Profile: tmpStream.profile || null,
			Width: tmpWidth,
			Height: tmpHeight,
			Rotation: tmpRotation,
			SampleAspectRatio: tmpStream.sample_aspect_ratio || null,
			DisplayWidth: tmpSwap ? tmpHeight : tmpStoredDisplayWidth,
			DisplayHeight: tmpSwap ? tmpStoredDisplayWidth : tmpHeight,
			FrameRate: tmpChosenRate ? libTools.formatRational(tmpChosenRate) : null,
			FrameRateValue: tmpChosenRate ? libTools.roundTo(tmpChosenRate.Value, 3) : 0,
			AverageFrameRate: tmpAverageFrameRate ? libTools.formatRational(tmpAverageFrameRate) : null,
			PixelFormat: tmpStream.pix_fmt || null,
			BitDepth: streamBitDepth(tmpStream),
			ColorTransfer: tmpColorTransfer,
			ColorPrimaries: tmpStream.color_primaries || null,
			ColorSpace: tmpStream.color_space || null,
			ColorRange: tmpStream.color_range || null,
			Transfer: tmpTransfer,
			IsHDR: (tmpTransfer !== 'sdr'),
			DurationSeconds: Number(tmpStream.duration) > 0 ? Number(tmpStream.duration) : 0
		};
		if (!(tmpSummary.DurationSeconds > 0) && tmpSummary.Video.DurationSeconds > 0)
		{
			tmpSummary.DurationSeconds = tmpSummary.Video.DurationSeconds;
		}
	}

	if (tmpAudioStreams.length > 0)
	{
		let tmpStream = tmpAudioStreams[0];
		tmpSummary.Audio =
		{
			Index: tmpStream.index,
			Codec: tmpStream.codec_name || null,
			Channels: Number(tmpStream.channels) || 0,
			ChannelLayout: tmpStream.channel_layout || null,
			SampleRate: Number(tmpStream.sample_rate) || 0
		};
	}

	return tmpSummary;
}

class MediaProbe extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'MediaProbe';

		if (!this.log)
		{
			this.log = this.options.Log || libTools.createFallbackLog(this.options.Verbose);
		}
		this.binaries = libTools.resolveBinaries(this.options);
	}

	/**
	 * Run ffprobe on a file and return the raw JSON.
	 *
	 * @param {string} pPath
	 * @param {function} fCallback - (pError, pRawJSON)
	 * @returns {Object} handle { cancel(pImmediate), Process }
	 */
	probeRaw(pPath, fCallback)
	{
		let tmpArguments = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', pPath];
		return libTools.spawnCollect(this.binaries.FFprobe, tmpArguments, {}, (pError, pResult) =>
			{
				if (pError)
				{
					return fCallback(pError.Cancelled ? pError : new Error(`ffprobe is not runnable (${this.binaries.FFprobe}): ${pError.message}`));
				}
				if (pResult.Code !== 0)
				{
					return fCallback(new Error(`ffprobe could not read the file (exit ${pResult.Code}): ${libTools.stderrTail(pResult.Stderr)}`));
				}
				let tmpRaw;
				try
				{
					tmpRaw = JSON.parse(pResult.Stdout.toString('utf8'));
				}
				catch (pParseError)
				{
					return fCallback(new Error(`ffprobe returned unparseable JSON: ${pParseError.message}`));
				}
				return fCallback(null, tmpRaw);
			});
	}

	/**
	 * Probe a file into the ladder's summary (raw JSON on `.Raw`).
	 *
	 * @param {string} pPath
	 * @param {function} fCallback - (pError, pSummary)
	 * @returns {Object} handle { cancel(pImmediate), Process }
	 */
	probe(pPath, fCallback)
	{
		return this.probeRaw(pPath, (pError, pRaw) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				return fCallback(null, summarize(pRaw));
			});
	}
}

module.exports = MediaProbe;
module.exports.summarize = summarize;
module.exports.normalizeRotation = normalizeRotation;
module.exports.streamRotation = streamRotation;
module.exports.streamBitDepth = streamBitDepth;
module.exports.classifyTransfer = classifyTransfer;
module.exports.TRANSFER_HLG = TRANSFER_HLG;
module.exports.TRANSFER_PQ = TRANSFER_PQ;
