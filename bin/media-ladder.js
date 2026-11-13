#!/usr/bin/env node
/**
* media-ladder -- the retold-media-ladder command line.
*
*   media-ladder probe  <in> [--raw]
*   media-ladder plan   <in> [flags]
*   media-ladder encode <in> --out <dir> [flags] [--force]
*
* Flags: --preset <x264 preset>  --fast  --profile hq  --slowmo  --lut <file.cube>
*        --no-download  --no-hwaccel  --segment-seconds <n>  --json  --verbose
*
* `encode` prints progress on stderr and the finished package directory on
* stdout.  Exit codes: 0 success, 1 failure, 2 usage error, 130 cancelled
* (an interrupt cancels cleanly; a second one stops at once).
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libRetoldMediaLadder = require('../source/Retold-Media-Ladder.js');
const libPackage = require('../package.json');

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_CANCELLED = 130;

const USAGE =
`media-ladder ${libPackage.version} -- adaptive-bitrate HLS packages from video files

Usage:
  media-ladder probe  <in> [--raw]
  media-ladder plan   <in> [flags]
  media-ladder encode <in> --out <dir> [flags] [--force]

Flags:
  --out <dir>             where packages go: <dir>/<PackageVersion>/
  --preset <name>         x264 preset (default medium; e.g. ultrafast, slow)
  --fast                  encode with h264_videotoolbox instead of x264
  --profile hq            raise the 1080p cap from 6000k to 7800k
  --slowmo                stretch high-frame-rate footage to 30 fps (drops audio)
  --lut <file.cube>       apply a 3D LUT (DJI D-Log M -> Rec.709)
  --no-download           skip download.mp4
  --no-hwaccel            decode in software (no VideoToolbox)
  --segment-seconds <n>   HLS segment length (default 6)
  --force                 rebuild an existing package that fails verification
                          (an intact one is never replaced: delete it to re-encode)
  --json                  encode: print the package.json document instead of the path
  --verbose               log more
  -h, --help              this text
`;

const VALUE_FLAGS = ['--out', '--preset', '--profile', '--lut', '--segment-seconds'];
const BOOLEAN_FLAGS = ['--fast', '--slowmo', '--no-download', '--no-hwaccel', '--force', '--json', '--raw', '--verbose', '--help', '-h'];

/**
 * Parse argv into { Command, Input, Flags }. Throws on bad usage.
 *
 * @param {Array<string>} pArguments
 * @returns {Object}
 */
function parseArguments(pArguments)
{
	let tmpPositional = [];
	let tmpFlags = {};
	for (let i = 0; i < pArguments.length; i++)
	{
		let tmpArgument = pArguments[i];
		let tmpEquals = tmpArgument.indexOf('=');
		let tmpName = (tmpArgument.indexOf('--') === 0 && tmpEquals > 0) ? tmpArgument.slice(0, tmpEquals) : tmpArgument;
		if (VALUE_FLAGS.indexOf(tmpName) >= 0)
		{
			let tmpValue = (tmpEquals > 0 && tmpName !== tmpArgument) ? tmpArgument.slice(tmpEquals + 1) : pArguments[++i];
			if (typeof tmpValue === 'undefined' || tmpValue === '')
			{
				throw new Error(`${tmpName} needs a value.`);
			}
			tmpFlags[tmpName] = tmpValue;
		}
		else if (BOOLEAN_FLAGS.indexOf(tmpArgument) >= 0)
		{
			tmpFlags[tmpArgument] = true;
		}
		else if (tmpArgument.indexOf('-') === 0 && tmpArgument.length > 1)
		{
			throw new Error(`Unknown flag ${tmpArgument}.`);
		}
		else
		{
			tmpPositional.push(tmpArgument);
		}
	}
	return { Command: tmpPositional[0] || null, Input: tmpPositional[1] || null, Extra: tmpPositional.slice(2), Flags: tmpFlags };
}

/**
 * Map CLI flags to ladder options.
 *
 * @param {Object} pFlags
 * @returns {Object}
 */
function ladderOptions(pFlags)
{
	let tmpOptions = {};
	if (pFlags['--preset'])
	{
		tmpOptions.Preset = pFlags['--preset'];
	}
	if (pFlags['--fast'])
	{
		tmpOptions.Fast = true;
	}
	if (pFlags['--profile'])
	{
		tmpOptions.Profile = pFlags['--profile'];
	}
	if (pFlags['--slowmo'])
	{
		tmpOptions.SlowMotion = true;
	}
	if (pFlags['--lut'])
	{
		tmpOptions.Lut = pFlags['--lut'];
	}
	if (pFlags['--no-download'])
	{
		tmpOptions.Download = false;
	}
	if (pFlags['--no-hwaccel'])
	{
		tmpOptions.Hwaccel = false;
	}
	if (pFlags['--segment-seconds'])
	{
		let tmpSeconds = Number(pFlags['--segment-seconds']);
		if (!(tmpSeconds > 0))
		{
			throw new Error('--segment-seconds needs a positive number.');
		}
		tmpOptions.SegmentSeconds = tmpSeconds;
	}
	if (pFlags['--force'])
	{
		tmpOptions.Force = true;
	}
	if (pFlags['--out'])
	{
		tmpOptions.OutputDirectory = pFlags['--out'];
	}
	return tmpOptions;
}

function writeJSON(pValue)
{
	process.stdout.write(JSON.stringify(pValue, null, '\t') + '\n');
}

function fail(pError, pCode)
{
	process.stderr.write(`media-ladder: ${pError.message || pError}\n`);
	process.exitCode = pCode || EXIT_FAILURE;
}

function main(pArguments)
{
	let tmpParsed;
	try
	{
		tmpParsed = parseArguments(pArguments);
	}
	catch (pUsageError)
	{
		process.stderr.write(`media-ladder: ${pUsageError.message}\n\n${USAGE}`);
		process.exitCode = EXIT_USAGE;
		return;
	}

	if (tmpParsed.Flags['--help'] || tmpParsed.Flags['-h'] || !tmpParsed.Command)
	{
		process.stdout.write(USAGE);
		process.exitCode = tmpParsed.Command ? EXIT_OK : ((tmpParsed.Flags['--help'] || tmpParsed.Flags['-h']) ? EXIT_OK : EXIT_USAGE);
		return;
	}
	if (['probe', 'plan', 'encode'].indexOf(tmpParsed.Command) < 0)
	{
		process.stderr.write(`media-ladder: unknown command "${tmpParsed.Command}".\n\n${USAGE}`);
		process.exitCode = EXIT_USAGE;
		return;
	}
	if (!tmpParsed.Input || tmpParsed.Extra.length > 0)
	{
		process.stderr.write(`media-ladder: ${tmpParsed.Command} needs exactly one input file.\n\n${USAGE}`);
		process.exitCode = EXIT_USAGE;
		return;
	}

	let tmpOptions;
	try
	{
		tmpOptions = ladderOptions(tmpParsed.Flags);
	}
	catch (pUsageError)
	{
		process.stderr.write(`media-ladder: ${pUsageError.message}\n`);
		process.exitCode = EXIT_USAGE;
		return;
	}

	let tmpLadder = new libRetoldMediaLadder({ Verbose: !!tmpParsed.Flags['--verbose'] });

	if (tmpParsed.Command === 'probe')
	{
		tmpLadder.probe(tmpParsed.Input, (pError, pSummary) =>
			{
				if (pError)
				{
					return fail(pError);
				}
				if (!tmpParsed.Flags['--raw'])
				{
					delete pSummary.Raw;
				}
				return writeJSON(pSummary);
			});
		return;
	}

	if (tmpParsed.Command === 'plan')
	{
		tmpLadder.plan(tmpParsed.Input, tmpOptions, (pError, pResult) =>
			{
				if (pError)
				{
					return fail(pError);
				}
				pResult.Plan.Warnings.forEach((pWarning) => { process.stderr.write(`warning: ${pWarning}\n`); });
				return writeJSON({ Plan: pResult.Plan, Command: pResult.CommandLine });
			});
		return;
	}

	// encode
	if (!tmpOptions.OutputDirectory)
	{
		process.stderr.write(`media-ladder: encode needs --out <dir>.\n\n${USAGE}`);
		process.exitCode = EXIT_USAGE;
		return;
	}

	let tmpInteractive = !!process.stderr.isTTY;
	let tmpLastReported = { Phase: null, Decile: -1 };
	tmpOptions.onProgress = (pEvent) =>
	{
		if (pEvent.Phase === 'encode')
		{
			if (tmpInteractive)
			{
				process.stderr.write(`\rencode ${pEvent.Percent.toFixed(1).padStart(5)}%`);
				return;
			}
			let tmpDecile = Math.floor(pEvent.Percent / 10);
			if (tmpLastReported.Phase !== 'encode' || tmpDecile > tmpLastReported.Decile)
			{
				process.stderr.write(`encode ${Math.round(pEvent.Percent)}%\n`);
				tmpLastReported.Decile = tmpDecile;
			}
			tmpLastReported.Phase = 'encode';
			return;
		}
		if (tmpInteractive && tmpLastReported.Phase === 'encode')
		{
			process.stderr.write('\n');
		}
		if (pEvent.Phase !== tmpLastReported.Phase)
		{
			process.stderr.write(`${pEvent.Phase}${pEvent.Message ? `: ${pEvent.Message}` : ''}\n`);
		}
		tmpLastReported.Phase = pEvent.Phase;
	};

	let tmpHandle = tmpLadder.encode(tmpParsed.Input, tmpOptions, (pError, pResult) =>
		{
			process.removeListener('SIGINT', fInterrupt);
			process.removeListener('SIGTERM', fInterrupt);
			if (pError)
			{
				return fail(pError, pError.Cancelled ? EXIT_CANCELLED : EXIT_FAILURE);
			}
			if (pResult.Reused)
			{
				process.stderr.write(`Package ${pResult.PackageVersion} already exists and verifies intact; reusing it.\n`);
			}
			if (tmpParsed.Flags['--json'])
			{
				return writeJSON(pResult.Package);
			}
			process.stdout.write(`${pResult.PackageDirectory}\n`);
		});

	// First signal: cancel (stop the running step, clean up, exit 130).
	// Second signal: abort now (SIGKILL the step, remove the partial package, exit 130).
	let tmpInterrupts = 0;
	let fInterrupt = () =>
	{
		tmpInterrupts++;
		if (tmpInterrupts === 1)
		{
			process.stderr.write('\nmedia-ladder: cancelling... (interrupt again to stop at once)\n');
			tmpHandle.cancel();
			return;
		}
		process.stderr.write('\nmedia-ladder: stopping now.\n');
		tmpHandle.abort();
		process.exit(EXIT_CANCELLED);
	};
	process.on('SIGINT', fInterrupt);
	process.on('SIGTERM', fInterrupt);
}

if (require.main === module)
{
	main(process.argv.slice(2));
}

module.exports = { main: main, parseArguments: parseArguments, ladderOptions: ladderOptions };
