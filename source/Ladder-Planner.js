/**
* Retold Media Ladder -- LadderPlanner
*
* PURE.  Given a MediaProbe summary and the caller's flags, decide everything
* about the encode, and turn that decision into ffmpeg arguments:
*
*   - Rungs sit on the DISPLAYED short side (1080 / 720 / 540 / 360) and never
*     upscale, so a 1080x1920 portrait clip's top rung is 1080 wide.
*   - Frame rate: above 60 fps is conformed by the smallest whole divisor
*     (120 -> 60, 100 -> 50, 119.88 -> 59.94); `SlowMotion` instead stretches
*     every frame to 30 fps (setpts) and drops the audio.
*   - Colour: HLG and PQ get the verified zscale -> hable tone-map; `Lut`
*     applies a 3D LUT (D-Log M has no tag, so it can only be asked for); a
*     10-bit source tagged SDR warns "possibly D-Log".
*   - No audio stream -> video-only variants.
*   - Encoder: x264 `medium` (CRF 21, capped) by default, `Preset` overrides
*     it, `Fast` uses h264_videotoolbox; `Profile: 'hq'` raises 1080p to 7800k.
*
* The single-pass command scales to the top rung and conforms fps BEFORE the
* float tone-map, then splits: the expensive colour maths runs once, at the
* top rung's size, instead of at 4K/100.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libTools = require('./Media-Ladder-Tools.js');

const PLAN_VERSION = 1;

// Rung table: short side, peak cap (kbps) and VBV buffer (kbps). Apple's HLS
// authoring ladder values; buffer = 2x cap.
const RUNG_TABLE =
[
	{ ShortSide: 1080, MaxRate: 6000, BufSize: 12000 },
	{ ShortSide: 720, MaxRate: 3000, BufSize: 6000 },
	{ ShortSide: 540, MaxRate: 2000, BufSize: 4000 },
	{ ShortSide: 360, MaxRate: 730, BufSize: 1460 }
];
const HQ_1080 = { MaxRate: 7800, BufSize: 15600 };

const PROFILES = ['standard', 'hq'];
const FIRST_VARIANT_SHORT_SIDE = 540;
const MAX_FRAME_RATE = 60;
const SLOW_MOTION_FRAME_RATE = 30;
const DEFAULT_SEGMENT_SECONDS = 6;
const DEFAULT_CRF = 21;
const DEFAULT_PRESET = 'medium';
const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow', 'placebo'];
// VideoToolbox has no CRF; it targets an average under the same peak cap.
const VIDEOTOOLBOX_AVERAGE_RATIO = 0.8;
const AUDIO_CODEC = 'aac';
const AUDIO_BITRATE = '128k';
const AUDIO_CHANNELS = 2;
const POSTER_POSITION = 0.1;
const DEFAULT_HWACCEL = 'videotoolbox';

const WARNING_POSSIBLY_DLOG = 'Source is 10-bit but tagged SDR (possibly D-Log); pass --lut <file.cube> to colour-correct it.';

/**
 * The verified HLG/PQ -> SDR BT.709 tone-map (zscale linearise, hable, back
 * to BT.709 limited range). Checked on ffmpeg 7.1 (Homebrew, zimg).
 *
 * @param {string} pTransfer - 'hlg' | 'pq'
 * @returns {string}
 */
function toneMapChain(pTransfer)
{
	let tmpTransfer = (pTransfer === 'pq') ? 'smpte2084' : 'arib-std-b67';
	return `setparams=color_primaries=bt2020:color_trc=${tmpTransfer}:colorspace=bt2020nc,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`;
}

/**
 * A 3D LUT (DJI D-Log M -> Rec.709 cube) with the path escaped for a graph.
 *
 * @param {string} pLutPath
 * @returns {string}
 */
function lutChain(pLutPath)
{
	return `lut3d=file=${libTools.escapeFilterValue(pLutPath)}:interp=tetrahedral`;
}

/**
 * The long side for a short side, rounded to even exactly as ffmpeg's
 * `scale=-2:S` does: av_rescale(S, long, short * 2) * 2 (round half up).
 *
 * @param {number} pShortSide
 * @param {number} pLongSide - source long side
 * @param {number} pSourceShortSide - source short side
 * @returns {number}
 */
function evenScaledLongSide(pShortSide, pLongSide, pSourceShortSide)
{
	return Math.floor(((pShortSide * pLongSide) + pSourceShortSide) / (2 * pSourceShortSide)) * 2;
}

/**
 * Index of the rung a player should start on: 540p, else the closest rung
 * at or below 540, else the smallest.
 *
 * @param {Array<Object>} pRungs - each with ShortSide, top rung first
 * @returns {number}
 */
function chooseFirstVariantIndex(pRungs)
{
	let tmpBest = -1;
	for (let i = 0; i < pRungs.length; i++)
	{
		let tmpShortSide = pRungs[i].ShortSide;
		if (tmpShortSide <= FIRST_VARIANT_SHORT_SIDE && (tmpBest < 0 || tmpShortSide > pRungs[tmpBest].ShortSide))
		{
			tmpBest = i;
		}
	}
	return (tmpBest >= 0) ? tmpBest : Math.max(0, pRungs.length - 1);
}

/**
 * Decide the encode. PURE: no I/O.
 *
 * @param {Object} pSummary - MediaProbe summary
 * @param {Object} [pOptions]
 *   - Preset {string}        x264 preset (default 'medium')
 *   - Fast {boolean}         use h264_videotoolbox
 *   - Profile {string}       'standard' | 'hq'
 *   - SlowMotion {boolean}   stretch high-fps footage to 30 fps
 *   - Lut {string}           absolute path to a .cube file
 *   - LutSha256 {string}     its digest (so a changed LUT changes the PackageVersion)
 *   - Download {boolean}     build download.mp4 (default true)
 *   - Hwaccel {boolean}      VideoToolbox decode (default true)
 *   - SegmentSeconds {number} HLS segment length (default 6)
 *   - CRF {number}           x264 CRF (default 21)
 * @returns {Object} plan
 */
function planLadder(pSummary, pOptions)
{
	let tmpOptions = pOptions || {};
	if (!pSummary || !pSummary.Video)
	{
		throw new Error('The source has no video stream.');
	}
	let tmpVideo = pSummary.Video;
	let tmpWarnings = [];

	let tmpDisplayWidth = Number(tmpVideo.DisplayWidth) || Number(tmpVideo.Width) || 0;
	let tmpDisplayHeight = Number(tmpVideo.DisplayHeight) || Number(tmpVideo.Height) || 0;
	if (!(tmpDisplayWidth > 1) || !(tmpDisplayHeight > 1))
	{
		throw new Error(`The source video has no usable dimensions (${tmpDisplayWidth}x${tmpDisplayHeight}).`);
	}
	let tmpPortrait = (tmpDisplayHeight > tmpDisplayWidth);
	let tmpSourceShortSide = Math.min(tmpDisplayWidth, tmpDisplayHeight);
	let tmpSourceLongSide = Math.max(tmpDisplayWidth, tmpDisplayHeight);

	// ---- Profile and rungs ---------------------------------------------------
	let tmpProfile = tmpOptions.Profile || 'standard';
	if (PROFILES.indexOf(tmpProfile) < 0)
	{
		throw new Error(`Unknown profile "${tmpProfile}" (expected ${PROFILES.join(' or ')}).`);
	}

	let tmpTable = RUNG_TABLE.filter((pRung) => pRung.ShortSide <= tmpSourceShortSide).map((pRung) => Object.assign({}, pRung));
	if (tmpTable.length < 1)
	{
		let tmpEvenShortSide = Math.max(2, Math.floor(tmpSourceShortSide / 2) * 2);
		let tmpSmallest = RUNG_TABLE[RUNG_TABLE.length - 1];
		tmpTable = [{ ShortSide: tmpEvenShortSide, MaxRate: tmpSmallest.MaxRate, BufSize: tmpSmallest.BufSize }];
		tmpWarnings.push(`Source is smaller than ${tmpSmallest.ShortSide}p; encoding one rung at its own size (${tmpEvenShortSide}p).`);
	}
	if (tmpProfile === 'hq')
	{
		tmpTable.forEach((pRung) =>
			{
				if (pRung.ShortSide === 1080)
				{
					pRung.MaxRate = HQ_1080.MaxRate;
					pRung.BufSize = HQ_1080.BufSize;
				}
			});
	}

	let tmpTopShortSide = tmpTable[0].ShortSide;
	let tmpTopLongSide = evenScaledLongSide(tmpTopShortSide, tmpSourceLongSide, tmpSourceShortSide);

	let tmpFast = (tmpOptions.Fast === true);
	let tmpRungs = tmpTable.map((pRung, pIndex) =>
		{
			let tmpLongSide = (pIndex === 0) ? tmpTopLongSide : evenScaledLongSide(pRung.ShortSide, tmpTopLongSide, tmpTopShortSide);
			let tmpRung =
			{
				Index: pIndex,
				Name: `${pRung.ShortSide}p`,
				ShortSide: pRung.ShortSide,
				Width: tmpPortrait ? pRung.ShortSide : tmpLongSide,
				Height: tmpPortrait ? tmpLongSide : pRung.ShortSide,
				MaxRate: pRung.MaxRate,
				BufSize: pRung.BufSize,
				// The top rung is scaled explicitly in the shared head of the
				// graph; the rest scale from it, on the short side.
				Filter: (pIndex === 0) ? 'null' : (tmpPortrait ? `scale=${pRung.ShortSide}:-2` : `scale=-2:${pRung.ShortSide}`),
				Directory: `v${pIndex}`,
				Playlist: `v${pIndex}/index.m3u8`,
				File: `v${pIndex}/media.mp4`
			};
			if (tmpFast)
			{
				tmpRung.AverageRate = Math.round(pRung.MaxRate * VIDEOTOOLBOX_AVERAGE_RATIO);
			}
			return tmpRung;
		});

	// ---- Frame rate --------------------------------------------------------
	let tmpSourceRate = libTools.parseRational(tmpVideo.FrameRate);
	if (!tmpSourceRate)
	{
		tmpSourceRate = libTools.makeRational(30, 1);
		tmpWarnings.push('Source frame rate is unknown; assuming 30 fps.');
	}
	let tmpOutputRate = tmpSourceRate;
	let tmpSlowMotionFactor = null;
	if (tmpOptions.SlowMotion === true)
	{
		let tmpTarget = (tmpSourceRate.Den === 1001) ? libTools.makeRational(SLOW_MOTION_FRAME_RATE * 1000, 1001) : libTools.makeRational(SLOW_MOTION_FRAME_RATE, 1);
		if (tmpSourceRate.Value > (tmpTarget.Value + 0.01))
		{
			tmpSlowMotionFactor = libTools.makeRational(tmpSourceRate.Num * tmpTarget.Den, tmpSourceRate.Den * tmpTarget.Num);
			tmpOutputRate = tmpTarget;
		}
		else
		{
			tmpWarnings.push(`--slowmo ignored: the source is already ${libTools.roundTo(tmpSourceRate.Value, 3)} fps.`);
		}
	}
	if (!tmpSlowMotionFactor && tmpSourceRate.Value > (MAX_FRAME_RATE + 0.01))
	{
		let tmpDivisor = Math.ceil((tmpSourceRate.Value / MAX_FRAME_RATE) - 1e-6);
		tmpOutputRate = libTools.makeRational(tmpSourceRate.Num, tmpSourceRate.Den * tmpDivisor);
	}

	// ---- Segments and keyframes -------------------------------------------
	let tmpSegmentSeconds = (typeof tmpOptions.SegmentSeconds === 'undefined' || tmpOptions.SegmentSeconds === null) ? DEFAULT_SEGMENT_SECONDS : Number(tmpOptions.SegmentSeconds);
	if (!(tmpSegmentSeconds >= 1) || tmpSegmentSeconds > 60 || Math.round(tmpSegmentSeconds) !== tmpSegmentSeconds)
	{
		throw new Error(`SegmentSeconds must be a whole number from 1 to 60 (got ${tmpOptions.SegmentSeconds}).`);
	}
	// An IDR every 2 s (Apple), or every 1 s when the segment length is odd so
	// every segment still starts on a keyframe.
	let tmpKeyframeSeconds = (tmpSegmentSeconds % 2 === 0) ? 2 : 1;
	let tmpKeyframeInterval = Math.max(1, Math.round(tmpKeyframeSeconds * tmpOutputRate.Value));

	// ---- Colour ------------------------------------------------------------
	let tmpColour = { Mode: 'none', Filter: '', Lut: null, TagBT709: false };
	if (tmpOptions.Lut)
	{
		tmpColour = { Mode: 'lut', Filter: lutChain(tmpOptions.Lut), Lut: { File: tmpOptions.Lut, Sha256: tmpOptions.LutSha256 || null }, TagBT709: true };
		if (tmpVideo.Transfer === 'hlg' || tmpVideo.Transfer === 'pq')
		{
			tmpWarnings.push(`Source is tagged ${tmpVideo.Transfer.toUpperCase()} but --lut was given; applying the LUT instead of the tone-map.`);
		}
	}
	else if (tmpVideo.Transfer === 'hlg' || tmpVideo.Transfer === 'pq')
	{
		tmpColour = { Mode: `${tmpVideo.Transfer}-hable`, Filter: toneMapChain(tmpVideo.Transfer), Lut: null, TagBT709: true };
	}
	else if (Number(tmpVideo.BitDepth) >= 10)
	{
		tmpWarnings.push(WARNING_POSSIBLY_DLOG);
	}

	// ---- Encoder -----------------------------------------------------------
	let tmpPreset = tmpOptions.Preset || DEFAULT_PRESET;
	if (X264_PRESETS.indexOf(tmpPreset) < 0)
	{
		throw new Error(`Unknown x264 preset "${tmpPreset}" (expected one of ${X264_PRESETS.join(', ')}).`);
	}
	if (tmpFast && tmpOptions.Preset)
	{
		tmpWarnings.push(`--preset ${tmpOptions.Preset} ignored: --fast uses h264_videotoolbox.`);
	}
	let tmpCRF = (typeof tmpOptions.CRF === 'number') ? tmpOptions.CRF : DEFAULT_CRF;
	let tmpVideoEncoder = tmpFast
		? { Encoder: 'h264_videotoolbox', Preset: null, Profile: 'high', CRF: null, PixelFormat: 'yuv420p' }
		: { Encoder: 'libx264', Preset: tmpPreset, Profile: 'high', CRF: tmpCRF, PixelFormat: 'yuv420p' };

	// ---- Audio -------------------------------------------------------------
	let tmpAudio = { Enabled: false };
	if (pSummary.HasAudio && tmpSlowMotionFactor)
	{
		tmpWarnings.push('Audio dropped: slow motion stretches the picture, and stretched sound is not useful.');
	}
	else if (pSummary.HasAudio)
	{
		tmpAudio = { Enabled: true, Codec: AUDIO_CODEC, Bitrate: AUDIO_BITRATE, Channels: AUDIO_CHANNELS };
	}

	// ---- Durations, poster -------------------------------------------------
	let tmpSourceDuration = Number(pSummary.DurationSeconds) || 0;
	let tmpDuration = tmpSourceDuration * (tmpSlowMotionFactor ? tmpSlowMotionFactor.Value : 1);

	return (
		{
			PlanVersion: PLAN_VERSION,
			Kind: 'video',
			Source:
			{
				Codec: tmpVideo.Codec || null,
				Width: tmpVideo.Width,
				Height: tmpVideo.Height,
				Rotation: tmpVideo.Rotation || 0,
				DisplayWidth: tmpDisplayWidth,
				DisplayHeight: tmpDisplayHeight,
				FrameRate: libTools.formatRational(tmpSourceRate),
				PixelFormat: tmpVideo.PixelFormat || null,
				BitDepth: tmpVideo.BitDepth || 8,
				Transfer: tmpVideo.Transfer || 'sdr',
				HasAudio: !!pSummary.HasAudio,
				DurationSeconds: libTools.roundTo(tmpSourceDuration, 3)
			},
			Orientation: tmpPortrait ? 'portrait' : 'landscape',
			FrameRate:
			{
				Source: libTools.formatRational(tmpSourceRate),
				Output: libTools.formatRational(tmpOutputRate),
				OutputValue: libTools.roundTo(tmpOutputRate.Value, 3),
				SlowMotionFactor: tmpSlowMotionFactor ? libTools.formatRational(tmpSlowMotionFactor) : null
			},
			DurationSeconds: libTools.roundTo(tmpDuration, 3),
			SegmentSeconds: tmpSegmentSeconds,
			KeyframeSeconds: tmpKeyframeSeconds,
			KeyframeInterval: tmpKeyframeInterval,
			Colour: tmpColour,
			Decode: { Hwaccel: (tmpOptions.Hwaccel === false) ? null : DEFAULT_HWACCEL },
			Video: tmpVideoEncoder,
			Audio: tmpAudio,
			Profile: tmpProfile,
			Rungs: tmpRungs,
			FirstVariantIndex: chooseFirstVariantIndex(tmpRungs),
			Poster: { AtSeconds: libTools.roundTo(tmpSourceDuration * POSTER_POSITION, 3), Frames: Math.max(1, Math.min(120, Math.round(tmpOutputRate.Value * 2))) },
			Download: (tmpOptions.Download !== false),
			Warnings: tmpWarnings
		});
}

/**
 * The shared picture head: fps (and slow-motion retime), the explicit scale
 * to the top rung, square pixels, then the colour chain. Tone-mapping after
 * the scale is the whole speed win (see the design doc, section 4.2).
 *
 * @param {Object} pPlan
 * @param {boolean} [pWithFrameRate=true] - false for the poster (one frame)
 * @returns {Array<string>} filters, in order
 */
function buildPictureChain(pPlan, pWithFrameRate)
{
	let tmpChain = [];
	if (pWithFrameRate !== false)
	{
		if (pPlan.FrameRate.SlowMotionFactor)
		{
			tmpChain.push(`setpts=PTS*${pPlan.FrameRate.SlowMotionFactor}`);
		}
		tmpChain.push(`fps=${pPlan.FrameRate.Output}`);
	}
	let tmpTop = pPlan.Rungs[0];
	tmpChain.push(`scale=${tmpTop.Width}:${tmpTop.Height}`);
	tmpChain.push('setsar=1');
	if (pPlan.Colour && pPlan.Colour.Filter)
	{
		tmpChain.push(pPlan.Colour.Filter);
	}
	tmpChain.push('format=yuv420p');
	return tmpChain;
}

/**
 * The -filter_complex graph: one head, then split into the rungs.
 *
 * @param {Object} pPlan
 * @returns {string}
 */
function buildFilterGraph(pPlan)
{
	let tmpHead = buildPictureChain(pPlan, true).join(',');
	let tmpCount = pPlan.Rungs.length;
	if (tmpCount === 1)
	{
		return `[0:v]${tmpHead}[v0]`;
	}
	let tmpSplitLabels = pPlan.Rungs.map((pRung, pIndex) => `[s${pIndex}]`).join('');
	let tmpBranches = pPlan.Rungs.map((pRung, pIndex) => `[s${pIndex}]${pRung.Filter}[v${pIndex}]`);
	return `[0:v]${tmpHead},split=${tmpCount}${tmpSplitLabels};${tmpBranches.join(';')}`;
}

/**
 * The -var_stream_map value: "v:0,a:0 v:1,a:1 ..." or "v:0 v:1 ..." with no audio.
 *
 * @param {Object} pPlan
 * @returns {string}
 */
function buildVarStreamMap(pPlan)
{
	return pPlan.Rungs.map((pRung, pIndex) => (pPlan.Audio.Enabled ? `v:${pIndex},a:${pIndex}` : `v:${pIndex}`)).join(' ');
}

/**
 * The full single-pass ffmpeg argument list. Outputs are RELATIVE, so the
 * command runs with its working directory set to the package being built.
 * Progress arguments are added by the EncodeRunner.
 *
 * @param {Object} pPlan
 * @param {string} pInputPath - absolute
 * @returns {Array<string>}
 */
function buildEncodeArguments(pPlan, pInputPath)
{
	// warning level keeps stderr to what matters for an error message; the
	// EncodeRunner reads progress from -progress, not from the log.
	let tmpArguments = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'warning'];
	if (pPlan.Decode && pPlan.Decode.Hwaccel)
	{
		tmpArguments.push('-hwaccel', pPlan.Decode.Hwaccel);
	}
	tmpArguments.push('-i', pInputPath);
	tmpArguments.push('-filter_complex', buildFilterGraph(pPlan));

	pPlan.Rungs.forEach((pRung, pIndex) => { tmpArguments.push('-map', `[v${pIndex}]`); });
	if (pPlan.Audio.Enabled)
	{
		pPlan.Rungs.forEach(() => { tmpArguments.push('-map', '0:a:0'); });
	}

	// Strip everything: global + stream metadata, chapters, and version strings.
	tmpArguments.push('-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact');
	if (pPlan.Audio.Enabled)
	{
		tmpArguments.push('-flags:a', '+bitexact');
	}

	if (pPlan.Video.Encoder === 'h264_videotoolbox')
	{
		tmpArguments.push('-c:v', 'h264_videotoolbox', '-profile:v', pPlan.Video.Profile);
	}
	else
	{
		tmpArguments.push('-c:v', 'libx264', '-preset', pPlan.Video.Preset, '-profile:v', pPlan.Video.Profile, '-crf', String(pPlan.Video.CRF), '-sc_threshold', '0');
	}
	tmpArguments.push('-g', String(pPlan.KeyframeInterval), '-keyint_min', String(pPlan.KeyframeInterval));
	tmpArguments.push('-force_key_frames', `expr:gte(t,n_forced*${pPlan.KeyframeSeconds})`);

	pPlan.Rungs.forEach((pRung, pIndex) =>
		{
			if (pPlan.Video.Encoder === 'h264_videotoolbox')
			{
				tmpArguments.push(`-b:v:${pIndex}`, `${pRung.AverageRate || Math.round(pRung.MaxRate * VIDEOTOOLBOX_AVERAGE_RATIO)}k`);
			}
			tmpArguments.push(`-maxrate:v:${pIndex}`, `${pRung.MaxRate}k`, `-bufsize:v:${pIndex}`, `${pRung.BufSize}k`);
		});

	if (pPlan.Colour && pPlan.Colour.TagBT709)
	{
		tmpArguments.push('-color_primaries:v', 'bt709', '-color_trc:v', 'bt709', '-colorspace:v', 'bt709', '-color_range:v', 'tv');
	}

	if (pPlan.Audio.Enabled)
	{
		tmpArguments.push('-c:a', pPlan.Audio.Codec, '-b:a', pPlan.Audio.Bitrate, '-ac', String(pPlan.Audio.Channels));
	}

	tmpArguments.push(
		'-f', 'hls',
		'-hls_time', String(pPlan.SegmentSeconds),
		'-hls_playlist_type', 'vod',
		'-hls_flags', 'single_file+independent_segments',
		'-hls_segment_type', 'fmp4',
		// Without this, ffmpeg 7.1 names the single file index.m4s.
		'-hls_segment_filename', 'v%v/media.mp4',
		'-master_pl_name', 'master.m3u8',
		'-var_stream_map', buildVarStreamMap(pPlan),
		'v%v/index.m3u8');

	return tmpArguments;
}

/**
 * Render an argument list as a copy-pasteable shell line (for `plan` output).
 *
 * @param {string} pCommand
 * @param {Array<string>} pArguments
 * @returns {string}
 */
function formatCommandLine(pCommand, pArguments)
{
	let fQuote = (pValue) =>
	{
		let tmpValue = String(pValue);
		if (/^[A-Za-z0-9_\-+=.,/:@%]+$/.test(tmpValue))
		{
			return tmpValue;
		}
		return `'${tmpValue.replace(/'/g, `'\\''`)}'`;
	};
	return [pCommand].concat(pArguments).map(fQuote).join(' ');
}

class LadderPlanner extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'LadderPlanner';

		if (!this.log)
		{
			this.log = this.options.Log || libTools.createFallbackLog(this.options.Verbose);
		}
	}

	plan(pSummary, pOptions)
	{
		return planLadder(pSummary, pOptions);
	}

	buildEncodeArguments(pPlan, pInputPath)
	{
		return buildEncodeArguments(pPlan, pInputPath);
	}

	buildFilterGraph(pPlan)
	{
		return buildFilterGraph(pPlan);
	}
}

module.exports = LadderPlanner;
module.exports.planLadder = planLadder;
module.exports.buildPictureChain = buildPictureChain;
module.exports.buildFilterGraph = buildFilterGraph;
module.exports.buildVarStreamMap = buildVarStreamMap;
module.exports.buildEncodeArguments = buildEncodeArguments;
module.exports.formatCommandLine = formatCommandLine;
module.exports.toneMapChain = toneMapChain;
module.exports.lutChain = lutChain;
module.exports.evenScaledLongSide = evenScaledLongSide;
module.exports.chooseFirstVariantIndex = chooseFirstVariantIndex;
module.exports.RUNG_TABLE = RUNG_TABLE;
module.exports.HQ_1080 = HQ_1080;
module.exports.X264_PRESETS = X264_PRESETS;
module.exports.WARNING_POSSIBLY_DLOG = WARNING_POSSIBLY_DLOG;
module.exports.PLAN_VERSION = PLAN_VERSION;
