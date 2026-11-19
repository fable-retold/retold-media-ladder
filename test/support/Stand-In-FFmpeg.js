/**
* A stand-in "ffmpeg" for the tests: a node script that answers `-version`
* and the capability listings (`-encoders`, `-filters`, `-hwaccels`) the way
* ffmpeg 7.1 prints them, and runs a test's own lines for anything else (an
* encode).  What it lists, a listing that never answers or fails, and a log
* of every run's arguments are all settable, so the ladder's ffmpeg
* preflight can be exercised without a real ffmpeg.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFS = require('node:fs');

const STAND_IN_VERSION_LINE = 'ffmpeg version 7.1-stand-in Copyright (c) 2000-2024 the FFmpeg developers';

// Everything the ladder can ask of a build: the encode, the poster and the download remux.
const ALL_ENCODERS = ['libx264', 'h264_videotoolbox', 'mjpeg', 'aac'];
const ALL_FILTERS = ['fps', 'setpts', 'scale', 'setsar', 'setparams', 'zscale', 'format', 'tonemap', 'lut3d', 'split', 'null', 'thumbnail'];
const ALL_HWACCELS = ['videotoolbox'];

/**
 * `ffmpeg -hide_banner -encoders` as ffmpeg 7.1 prints it (legend included).
 *
 * @param {Array<string>} pNames
 * @returns {string}
 */
function encoderListing(pNames)
{
	let tmpLines = ['Encoders:', ' V..... = Video', ' A..... = Audio', ' S..... = Subtitle', ' .F.... = Frame-level multithreading',
		' ..S... = Slice-level multithreading', ' ...X.. = Codec is experimental', ' ....B. = Supports draw_horiz_band',
		' .....D = Supports direct rendering method 1', ' ------'];
	pNames.forEach((pName) => { tmpLines.push(` ${(pName === 'aac') ? 'A' : 'V'}....D ${pName.padEnd(20)} stand-in ${pName}`); });
	return tmpLines.join('\n') + '\n';
}

/**
 * `ffmpeg -hide_banner -filters` as ffmpeg 7.1 prints it (legend included).
 *
 * @param {Array<string>} pNames
 * @returns {string}
 */
function filterListing(pNames)
{
	let tmpLines = ['Filters:', '  T.. = Timeline support', '  .S. = Slice threading', '  ..C = Command support', '  A = Audio input/output',
		'  V = Video input/output', '  N = Dynamic number and/or type of input/output', '  | = Source or sink filter'];
	pNames.forEach((pName) => { tmpLines.push(` ..C ${pName.padEnd(17)} V->V       stand-in ${pName}.`); });
	return tmpLines.join('\n') + '\n';
}

/**
 * `ffmpeg -hide_banner -hwaccels` as ffmpeg 7.1 prints it.
 *
 * @param {Array<string>} pNames
 * @returns {string}
 */
function hwaccelListing(pNames)
{
	return ['Hardware acceleration methods:'].concat(pNames).join('\n') + '\n\n';
}

/**
 * Write a stand-in ffmpeg at pPath (executable; `#!` the running node).
 *
 * @param {string} pPath
 * @param {Object} [pOptions]
 *   - VersionLine {string}           -version's first line (default STAND_IN_VERSION_LINE)
 *   - Encoders, Filters, Hwaccels    what the listings show (default: everything the ladder can use)
 *   - LogFile {string}               appends each run as one JSON line: { Pid, Arguments }
 *   - Hang {string|Array<string>}    listing flags (e.g. '-encoders') that never answer (until signalled)
 *   - Stubborn {Array<string>}       hanging listings that also ignore SIGTERM (only SIGKILL ends them)
 *   - Fail {string}                  a listing flag that fails (exit 1)
 *   - Body {Array<string>}           script lines for any other run (default: fail with exit 1)
 * @returns {string} pPath
 */
function writeStandInFFmpeg(pPath, pOptions)
{
	let tmpOptions = pOptions || {};
	let tmpAnswers =
	{
		'-version': `${tmpOptions.VersionLine || STAND_IN_VERSION_LINE}\nbuilt with a stand-in\n`,
		'-encoders': encoderListing(tmpOptions.Encoders || ALL_ENCODERS),
		'-filters': filterListing(tmpOptions.Filters || ALL_FILTERS),
		'-hwaccels': hwaccelListing(tmpOptions.Hwaccels || ALL_HWACCELS)
	};
	let tmpLines =
	[
		`#!${process.execPath}`,
		'const tmpArguments = process.argv.slice(2);',
		`const ANSWERS = ${JSON.stringify(tmpAnswers)};`,
		`const LOG_FILE = ${JSON.stringify(tmpOptions.LogFile || null)};`,
		`const HANG = ${JSON.stringify([].concat(tmpOptions.Hang || []))};`,
		`const STUBBORN = ${JSON.stringify(tmpOptions.Stubborn || [])};`,
		`const FAIL = ${JSON.stringify(tmpOptions.Fail || null)};`,
		"if (LOG_FILE) { require('fs').appendFileSync(LOG_FILE, JSON.stringify({ Pid: process.pid, Arguments: tmpArguments }) + '\\n'); }",
		'const tmpQuery = Object.keys(ANSWERS).filter((pFlag) => tmpArguments.indexOf(pFlag) >= 0)[0];',
		"if (tmpQuery && HANG.indexOf(tmpQuery) >= 0) { if (STUBBORN.indexOf(tmpQuery) >= 0) { process.on('SIGTERM', () => {}); } setInterval(() => {}, 1000); }",
		"else if (tmpQuery && tmpQuery === FAIL) { process.stderr.write('stand-in: ' + tmpQuery + ' failed\\n'); process.exit(1); }",
		'else if (tmpQuery) { process.stdout.write(ANSWERS[tmpQuery], () => process.exit(0)); }',
		'else',
		'{'
	];
	(tmpOptions.Body || ["process.stderr.write('stand-in: no encode here\\n');", 'process.exit(1);']).forEach((pLine) => { tmpLines.push(`\t${pLine}`); });
	tmpLines.push('}', '');
	libFS.writeFileSync(pPath, tmpLines.join('\n'));
	libFS.chmodSync(pPath, 0o755);
	return pPath;
}

/**
 * The runs a stand-in logged (LogFile).
 *
 * @param {string} pLogFile
 * @returns {Array<Object>} [{ Pid, Arguments }]
 */
function readStandInLog(pLogFile)
{
	if (!libFS.existsSync(pLogFile))
	{
		return [];
	}
	return libFS.readFileSync(pLogFile, 'utf8').split('\n').filter((pLine) => pLine.length > 0).map((pLine) => JSON.parse(pLine));
}

module.exports = writeStandInFFmpeg;
module.exports.writeStandInFFmpeg = writeStandInFFmpeg;
module.exports.readStandInLog = readStandInLog;
module.exports.encoderListing = encoderListing;
module.exports.filterListing = filterListing;
module.exports.hwaccelListing = hwaccelListing;
module.exports.STAND_IN_VERSION_LINE = STAND_IN_VERSION_LINE;
module.exports.ALL_ENCODERS = ALL_ENCODERS;
module.exports.ALL_FILTERS = ALL_FILTERS;
module.exports.ALL_HWACCELS = ALL_HWACCELS;
