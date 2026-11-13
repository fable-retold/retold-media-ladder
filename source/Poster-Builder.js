/**
* Retold Media Ladder -- PosterBuilder
*
* The poster is a freshly rendered frame, not an extracted thumbnail: seek to
* ~10% of the source, run the SAME scale + colour chain as the ladder (so an
* HLG clip's poster is tone-mapped too), let ffmpeg's `thumbnail` filter pick
* the most representative of the next couple of seconds' frames, and write a
* full-range JPEG.  The mjpeg encoder writes only a JFIF header: no EXIF, no
* comment, nothing from the source.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libTools = require('./Media-Ladder-Tools.js');
const libLadderPlanner = require('./Ladder-Planner.js');

const POSTER_FILE = 'poster.jpg';
const JPEG_QUALITY = '3';

/**
 * ffmpeg arguments for the poster. Pure.
 *
 * @param {Object} pPlan
 * @param {string} pInputPath
 * @param {string} pOutputPath
 * @returns {Array<string>}
 */
function buildPosterArguments(pPlan, pInputPath, pOutputPath)
{
	let tmpArguments = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
	if (pPlan.Decode && pPlan.Decode.Hwaccel)
	{
		tmpArguments.push('-hwaccel', pPlan.Decode.Hwaccel);
	}
	if (pPlan.Poster && pPlan.Poster.AtSeconds > 0)
	{
		tmpArguments.push('-ss', String(pPlan.Poster.AtSeconds));
	}
	tmpArguments.push('-i', pInputPath);

	let tmpChain = libLadderPlanner.buildPictureChain(pPlan, false);
	tmpChain.push(`thumbnail=${(pPlan.Poster && pPlan.Poster.Frames) || 50}`);
	// JPEG is full range by convention.
	tmpChain.push('scale=out_range=full', 'format=yuvj420p');

	tmpArguments.push(
		'-filter_complex', `[0:v]${tmpChain.join(',')}[poster]`,
		'-map', '[poster]',
		'-frames:v', '1',
		'-map_metadata', '-1',
		'-map_chapters', '-1',
		'-fflags', '+bitexact',
		'-flags:v', '+bitexact',
		'-c:v', 'mjpeg',
		'-q:v', JPEG_QUALITY,
		'-f', 'image2',
		'-update', '1',
		pOutputPath);
	return tmpArguments;
}

class PosterBuilder extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'PosterBuilder';

		if (!this.log)
		{
			this.log = this.options.Log || libTools.createFallbackLog(this.options.Verbose);
		}
		this.binaries = libTools.resolveBinaries(this.options);
	}

	/**
	 * Render the poster.
	 *
	 * @param {Object} pPlan
	 * @param {string} pInputPath
	 * @param {string} pOutputPath
	 * @param {function} fCallback - (pError, pOutputPath); a cancel yields an Error with `.Cancelled = true`
	 * @returns {Object} handle { cancel(pImmediate), Process }
	 */
	build(pPlan, pInputPath, pOutputPath, fCallback)
	{
		let tmpArguments = buildPosterArguments(pPlan, pInputPath, pOutputPath);
		return libTools.spawnCollect(this.binaries.FFmpeg, tmpArguments, {}, (pError, pResult) =>
			{
				if (pError)
				{
					return fCallback(pError.Cancelled ? pError : new Error(`Poster: ffmpeg is not runnable: ${pError.message}`));
				}
				if (pResult.Code !== 0)
				{
					return fCallback(new Error(`Poster: ffmpeg exited with code ${pResult.Code}: ${libTools.stderrTail(pResult.Stderr)}`));
				}
				return fCallback(null, pOutputPath);
			});
	}
}

module.exports = PosterBuilder;
module.exports.buildPosterArguments = buildPosterArguments;
module.exports.POSTER_FILE = POSTER_FILE;
