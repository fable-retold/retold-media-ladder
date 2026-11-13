/**
* Retold Media Ladder -- DownloadBuilder
*
* `download.mp4` is a stream-copy remux of the top rung's fragmented
* `media.mp4` into an ordinary MP4 with the `moov` box first (+faststart): it
* takes seconds, imports cleanly into Photos and friends, and doubles as the
* player's progressive fallback.  Metadata is stripped again and bitexact
* keeps the movie header's creation time at zero.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libTools = require('./Media-Ladder-Tools.js');

const DOWNLOAD_FILE = 'download.mp4';

/**
 * ffmpeg arguments for the download remux. Pure.
 *
 * @param {string} pTopMediaPath - the top rung's media.mp4
 * @param {string} pOutputPath
 * @returns {Array<string>}
 */
function buildDownloadArguments(pTopMediaPath, pOutputPath)
{
	return (
		[
			'-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
			'-i', pTopMediaPath,
			'-map', '0',
			'-c', 'copy',
			'-map_metadata', '-1',
			'-map_chapters', '-1',
			'-fflags', '+bitexact',
			'-movflags', '+faststart',
			'-f', 'mp4',
			pOutputPath
		]);
}

class DownloadBuilder extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'DownloadBuilder';

		if (!this.log)
		{
			this.log = this.options.Log || libTools.createFallbackLog(this.options.Verbose);
		}
		this.binaries = libTools.resolveBinaries(this.options);
	}

	/**
	 * Remux the top rung into download.mp4.
	 *
	 * @param {string} pTopMediaPath
	 * @param {string} pOutputPath
	 * @param {function} fCallback - (pError, pOutputPath); a cancel yields an Error with `.Cancelled = true`
	 * @returns {Object} handle { cancel(pImmediate), Process }
	 */
	build(pTopMediaPath, pOutputPath, fCallback)
	{
		return libTools.spawnCollect(this.binaries.FFmpeg, buildDownloadArguments(pTopMediaPath, pOutputPath), {}, (pError, pResult) =>
			{
				if (pError)
				{
					return fCallback(pError.Cancelled ? pError : new Error(`Download: ffmpeg is not runnable: ${pError.message}`));
				}
				if (pResult.Code !== 0)
				{
					return fCallback(new Error(`Download: ffmpeg exited with code ${pResult.Code}: ${libTools.stderrTail(pResult.Stderr)}`));
				}
				return fCallback(null, pOutputPath);
			});
	}
}

module.exports = DownloadBuilder;
module.exports.buildDownloadArguments = buildDownloadArguments;
module.exports.DOWNLOAD_FILE = DOWNLOAD_FILE;
