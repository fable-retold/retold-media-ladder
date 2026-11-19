#!/usr/bin/env node
/**
* media-ladder -- the retold-media-ladder command line.
*
*   media-ladder probe  <in> [--raw]
*   media-ladder plan   <in> [flags]
*   media-ladder encode <in> --out <dir> [flags] [--force]
*   media-ladder push   <packageDir> [push flags]
*
* Flags: --preset <x264 preset>  --fast  --profile hq  --slowmo  --lut <file.cube>
*        --no-download  --no-hwaccel  --segment-seconds <n>  --json  --verbose
* Push:  --server <URL>  --token <T>  --prefix <path>  --source <original>
*        --title <T>  --description <D>  --sensitivity normal|conversation
*        --chunk-mib <n>  --retries <n>  --json  (env MEDIA_LADDER_SERVER /
*        MEDIA_LADDER_TOKEN; flags win)
*
* `encode` prints progress on stderr and the finished package directory on
* stdout; `push` prints progress on stderr and "<AssetGUID> <PackageVersion>"
* on stdout.  Exit codes: 0 success, 1 failure, 2 usage error, 130 cancelled
* (an interrupt cancels cleanly; a second one stops at once).
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libRetoldMediaLadder = require('../source/Retold-Media-Ladder.js');
const libPublisher = require('../source/Publisher.js');
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
  media-ladder push   <packageDir> [--server URL] [--token T] [push flags]

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
  --json                  encode: print the package.json document instead of the path;
                          push: print the result JSON instead of "<AssetGUID> <PackageVersion>"
  --verbose               log more
  -h, --help              this text

Push flags (push a finished <out>/<PackageVersion>/ to a server; resumable):
  --server <URL>          the server (default $MEDIA_LADDER_SERVER)
  --token <T>             a bearer token (default $MEDIA_LADDER_TOKEN; prefer the
                          variable: a flag shows up in the process list)
  --prefix <path>         route prefix (default /1.0/MediaIngest)
  --source <original>     hash and probe the original file and send its name,
                          sha256, transfer and capture date (never uploaded)
  --title <T>             the asset's title (never derived from the file name)
  --description <D>       the asset's description
  --sensitivity <s>       normal (default) or conversation
                          (title, description and sensitivity apply only when the
                          push creates the asset: a re-push keeps the existing
                          asset's values and warns; edit the asset to change them)
  --chunk-mib <n>         upload chunk size in MiB (default 32; halves after a
                          chunk takes over 120 s, not below 8)
  --retries <n>           consecutive failed attempts on one file before giving
                          up (default 5)
`;

const PUSH_VALUE_FLAGS = ['--server', '--token', '--prefix', '--source', '--title', '--description', '--sensitivity', '--chunk-mib', '--retries'];
const VALUE_FLAGS = ['--out', '--preset', '--profile', '--lut', '--segment-seconds'].concat(PUSH_VALUE_FLAGS);
const BOOLEAN_FLAGS = ['--fast', '--slowmo', '--no-download', '--no-hwaccel', '--force', '--json', '--raw', '--verbose', '--help', '-h'];
// Everything push accepts; every other flag belongs to probe / plan / encode.
const PUSH_FLAGS = PUSH_VALUE_FLAGS.concat(['--json', '--verbose', '--help', '-h']);
const MAX_CHUNK_MIB = 1024;
const MIB = 1048576;

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

/**
 * Map push flags (and the environment) to Publisher options. Throws on bad
 * usage; never puts the token in a message.
 *
 * @param {Object} pFlags
 * @param {Object} [pEnvironment] - default process.env
 * @returns {Object} { Server, Token, Prefix, Source?, Title?, Description?, Sensitivity?, ChunkBytes?, Retries? }
 */
function pushOptions(pFlags, pEnvironment)
{
	let tmpEnvironment = pEnvironment || process.env;
	let tmpOptions = {};

	tmpOptions.Server = pFlags['--server'] || tmpEnvironment.MEDIA_LADDER_SERVER || '';
	if (!tmpOptions.Server)
	{
		throw new Error('push needs --server <URL> (or MEDIA_LADDER_SERVER).');
	}
	libPublisher.parseServerURL(tmpOptions.Server);

	tmpOptions.Token = pFlags['--token'] || tmpEnvironment.MEDIA_LADDER_TOKEN || '';
	if (!tmpOptions.Token)
	{
		throw new Error('push needs --token <T> (or MEDIA_LADDER_TOKEN).');
	}
	if (!/^[\x21-\x7e]+$/.test(tmpOptions.Token))
	{
		throw new Error('The token contains characters that cannot be sent in a header.');
	}

	tmpOptions.Prefix = libPublisher.normalizePrefix(pFlags['--prefix']);

	if (pFlags['--source'])
	{
		tmpOptions.Source = pFlags['--source'];
	}
	if (pFlags['--title'])
	{
		tmpOptions.Title = pFlags['--title'];
	}
	if (pFlags['--description'])
	{
		tmpOptions.Description = pFlags['--description'];
	}
	if (pFlags['--sensitivity'])
	{
		if (libPublisher.SENSITIVITIES.indexOf(pFlags['--sensitivity']) < 0)
		{
			throw new Error(`--sensitivity must be one of ${libPublisher.SENSITIVITIES.join(', ')}.`);
		}
		tmpOptions.Sensitivity = pFlags['--sensitivity'];
	}
	if (pFlags['--chunk-mib'])
	{
		let tmpMiB = Number(pFlags['--chunk-mib']);
		if (!/^\d+$/.test(pFlags['--chunk-mib']) || !(tmpMiB >= 1) || tmpMiB > MAX_CHUNK_MIB)
		{
			throw new Error(`--chunk-mib needs a whole number of MiB from 1 to ${MAX_CHUNK_MIB}.`);
		}
		tmpOptions.ChunkBytes = tmpMiB * MIB;
	}
	if (pFlags['--retries'])
	{
		let tmpRetries = Number(pFlags['--retries']);
		if (!/^\d+$/.test(pFlags['--retries']) || tmpRetries > 100)
		{
			throw new Error('--retries needs a whole number from 0 to 100.');
		}
		tmpOptions.Retries = tmpRetries;
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
	if (['probe', 'plan', 'encode', 'push'].indexOf(tmpParsed.Command) < 0)
	{
		process.stderr.write(`media-ladder: unknown command "${tmpParsed.Command}".\n\n${USAGE}`);
		process.exitCode = EXIT_USAGE;
		return;
	}
	let tmpMisplaced = Object.keys(tmpParsed.Flags).filter((pFlag) =>
		{
			return (tmpParsed.Command === 'push') ? (PUSH_FLAGS.indexOf(pFlag) < 0) : (PUSH_VALUE_FLAGS.indexOf(pFlag) >= 0);
		});
	if (tmpMisplaced.length > 0)
	{
		let tmpWhy = (tmpParsed.Command === 'push') ? 'is not a push flag' : 'is only for push';
		process.stderr.write(`media-ladder: ${tmpMisplaced[0]} ${tmpWhy}.\n\n${USAGE}`);
		process.exitCode = EXIT_USAGE;
		return;
	}
	if (!tmpParsed.Input || tmpParsed.Extra.length > 0)
	{
		let tmpWhat = (tmpParsed.Command === 'push') ? 'package directory' : 'input file';
		process.stderr.write(`media-ladder: ${tmpParsed.Command} needs exactly one ${tmpWhat}.\n\n${USAGE}`);
		process.exitCode = EXIT_USAGE;
		return;
	}

	if (tmpParsed.Command === 'push')
	{
		return runPush(tmpParsed);
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

/**
 * `media-ladder push`: verify, (probe the source,) register, upload, commit.
 *
 * @param {Object} pParsed - from parseArguments
 */
function runPush(pParsed)
{
	let tmpOptions;
	try
	{
		tmpOptions = pushOptions(pParsed.Flags);
	}
	catch (pUsageError)
	{
		process.stderr.write(`media-ladder: ${pUsageError.message}\n\n${USAGE}`);
		process.exitCode = EXIT_USAGE;
		return;
	}

	let tmpInteractive = !!process.stderr.isTTY;
	let tmpLine = { Open: false, Phase: null, Message: null, Decile: -1 };
	let fBreakLine = () =>
	{
		if (tmpLine.Open)
		{
			process.stderr.write('\n');
			tmpLine.Open = false;
		}
	};
	// Warnings (retries, chunk shrinking) start on a fresh line under a live progress line.
	let fLogLine = (pMessage) =>
	{
		fBreakLine();
		process.stderr.write(`${pMessage}\n`);
	};
	let fQuiet = () => {};
	let tmpVerbose = !!pParsed.Flags['--verbose'];
	let tmpLog = { trace: tmpVerbose ? fLogLine : fQuiet, debug: tmpVerbose ? fLogLine : fQuiet, info: tmpVerbose ? fLogLine : fQuiet, warn: fLogLine, error: fLogLine };

	let tmpServer = libPublisher.parseServerURL(tmpOptions.Server);
	if (tmpServer.Protocol === 'http:' && !/^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(tmpServer.Hostname))
	{
		process.stderr.write(`media-ladder: warning: ${tmpServer.Origin} is plain http; the token and the media travel unencrypted.\n`);
	}

	tmpOptions.onProgress = (pEvent) =>
	{
		if (pEvent.Phase === 'upload')
		{
			let tmpText = `upload ${pEvent.Percent.toFixed(1).padStart(5)}%  ${(pEvent.Done / MIB).toFixed(1)} / ${(pEvent.Total / MIB).toFixed(1)} MiB`;
			if (tmpInteractive)
			{
				process.stderr.write(`\r${tmpText}`);
				tmpLine.Open = true;
				tmpLine.Phase = 'upload';
				return;
			}
			let tmpDecile = Math.floor(pEvent.Percent / 10);
			if (tmpLine.Phase !== 'upload' || tmpDecile > tmpLine.Decile)
			{
				process.stderr.write(`upload ${Math.round(pEvent.Percent)}%\n`);
				tmpLine.Decile = tmpDecile;
			}
			tmpLine.Phase = 'upload';
			return;
		}
		fBreakLine();
		if (pEvent.Phase !== tmpLine.Phase || pEvent.Message !== tmpLine.Message)
		{
			process.stderr.write(`${pEvent.Phase}${pEvent.Message ? `: ${pEvent.Message}` : ''}\n`);
		}
		tmpLine.Phase = pEvent.Phase;
		tmpLine.Message = pEvent.Message;
		tmpLine.Decile = -1;
	};

	let tmpLadder = new libRetoldMediaLadder({ Verbose: tmpVerbose, Log: tmpLog });
	let tmpHandle = tmpLadder.push(pParsed.Input, tmpOptions, (pError, pResult) =>
		{
			process.removeListener('SIGINT', fInterrupt);
			process.removeListener('SIGTERM', fInterrupt);
			fBreakLine();
			if (pError)
			{
				return fail(pError, pError.Cancelled ? EXIT_CANCELLED : EXIT_FAILURE);
			}
			if (pParsed.Flags['--json'])
			{
				return writeJSON(pResult);
			}
			process.stdout.write(`${pResult.AssetGUID} ${pResult.PackageVersion}\n`);
		});

	// First signal: cancel (drop the in-flight chunk; the server keeps every
	// whole one, so the next push resumes) and exit 130.  Second: stop now.
	let tmpInterrupts = 0;
	let fInterrupt = () =>
	{
		tmpInterrupts++;
		fBreakLine();
		if (tmpInterrupts === 1)
		{
			process.stderr.write('media-ladder: cancelling... (interrupt again to stop at once)\n');
			tmpHandle.cancel();
			return;
		}
		process.stderr.write('media-ladder: stopping now.\n');
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

module.exports = { main: main, parseArguments: parseArguments, ladderOptions: ladderOptions, pushOptions: pushOptions };
