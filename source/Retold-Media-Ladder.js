/**
* Retold Media Ladder
*
* Turns a video file into a private, adaptive-bitrate HLS package on disk:
*
*   probe -> plan -> ffmpeg preflight (it runs, and has every encoder, filter
*   and hwaccel the plan uses) -> hash source -> PackageVersion -> (an
*   existing <out>/<PV>/ is verified and reused) -> lock + one-pass ffmpeg
*   encode (into <out>/<PV>.partial/) -> master reorder -> poster ->
*   download.mp4 -> sanitise gate -> package.json -> rename to <out>/<PV>/
*
* and pushes a finished package to a server (`push`, the Publisher service:
* verify -> register -> resumable chunked upload -> commit).
*
* Everything that can refuse an encode (a bad flag, an ffmpeg without
* libx264, say) does so before the source is hashed: a multi-GB source on a
* slow disk takes minutes to hash.
*
* A finished package is immutable: it is never re-encoded in place, because a
* re-encode with the same inputs (the same PackageVersion) does not reproduce
* the same bytes.  `Force` only rebuilds a package that fails verification.
*
* Each step is its own fable-serviceproviderbase service (MediaProbe,
* LadderPlanner, EncodeRunner, PosterBuilder, DownloadBuilder, Sanitiser,
* PackageWriter, Publisher); this service sequences them.  Every service also works
* without a Fable (pass an options object), which is how the `media-ladder`
* CLI runs.
*
* Usage:
*   const libRetoldMediaLadder = require('retold-media-ladder');
*   pFable.addAndInstantiateServiceType('RetoldMediaLadder', libRetoldMediaLadder);
*   pFable.RetoldMediaLadder.encode('/footage/DJI_0001.MP4', { OutputDirectory: '/packages' },
*       (pError, pResult) => { ... pResult.PackageDirectory, pResult.Package ... });
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libFS = require('node:fs');
const libPath = require('node:path');

const libTools = require('./Media-Ladder-Tools.js');
const libMediaProbe = require('./Media-Probe.js');
const libLadderPlanner = require('./Ladder-Planner.js');
const libEncodeRunner = require('./Encode-Runner.js');
const libPosterBuilder = require('./Poster-Builder.js');
const libDownloadBuilder = require('./Download-Builder.js');
const libSanitiser = require('./Sanitiser.js');
const libPackageWriter = require('./Package-Writer.js');
const libPublisher = require('./Publisher.js');

const _DefaultConfiguration =
{
	FFmpegPath: false,     // default: $RETOLD_MEDIA_LADDER_FFMPEG, then `ffmpeg` on PATH
	FFprobePath: false,    // default: $RETOLD_MEDIA_LADDER_FFPROBE, then `ffprobe` on PATH
	Verbose: false
};

class RetoldMediaLadder extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		// Mirror the base class's two calling conventions so defaults merge either way.
		let tmpHasFable = (typeof pFable === 'object') && pFable && pFable.isFable;
		if (tmpHasFable)
		{
			super(pFable, Object.assign({}, _DefaultConfiguration, (typeof pOptions === 'object') ? pOptions : {}), pServiceHash);
		}
		else
		{
			super(Object.assign({}, _DefaultConfiguration, (typeof pFable === 'object' && pFable) ? pFable : {}), pOptions, pServiceHash);
		}

		this.serviceType = 'RetoldMediaLadder';

		if (!this.log)
		{
			this.log = this.options.Log || libTools.createFallbackLog(this.options.Verbose);
		}
		this.binaries = libTools.resolveBinaries(this.options);
		// The host OS, for what only macOS has (VideoToolbox decode by default; --fast).
		// Overridable, so both sides can be tested on one machine.
		this.platform = process.platform;

		let tmpChildOptions = { FFmpegPath: this.binaries.FFmpeg, FFprobePath: this.binaries.FFprobe, Log: this.log, Verbose: this.options.Verbose };
		this.MediaProbe = this._createChild(libMediaProbe, tmpChildOptions);
		this.LadderPlanner = this._createChild(libLadderPlanner, tmpChildOptions);
		this.EncodeRunner = this._createChild(libEncodeRunner, tmpChildOptions);
		this.PosterBuilder = this._createChild(libPosterBuilder, tmpChildOptions);
		this.DownloadBuilder = this._createChild(libDownloadBuilder, tmpChildOptions);
		this.Sanitiser = this._createChild(libSanitiser, tmpChildOptions);
		this.PackageWriter = this._createChild(libPackageWriter, tmpChildOptions);
		this.Publisher = this._createChild(libPublisher, tmpChildOptions);
	}

	_createChild(pClass, pOptions)
	{
		if (this.fable)
		{
			return new pClass(this.fable, Object.assign({}, pOptions));
		}
		return new pClass(Object.assign({}, pOptions));
	}

	/**
	 * Normalise caller flags into planner options (absolute LUT path, the
	 * VideoToolbox decode default for macOS).
	 *
	 * @param {Object} pOptions
	 * @returns {Object}
	 */
	normalizeOptions(pOptions)
	{
		let tmpOptions = Object.assign({}, pOptions || {});
		if (typeof tmpOptions.Hwaccel !== 'boolean')
		{
			tmpOptions.Hwaccel = (this.platform === 'darwin');
		}
		if (tmpOptions.Lut)
		{
			tmpOptions.Lut = libPath.resolve(tmpOptions.Lut);
		}
		return tmpOptions;
	}

	/**
	 * The error for `Fast` on a host without VideoToolbox (anything but
	 * macOS), or null.  The entry points check it before probing or hashing
	 * anything, so a bad flag fails at once instead of after a long hash.
	 *
	 * @param {Object} pOptions - normalised options
	 * @returns {Error|null}
	 */
	_fastPlatformError(pOptions)
	{
		if (!pOptions || pOptions.Fast !== true)
		{
			return null;
		}
		let tmpReason = libLadderPlanner.fastUnavailableReason(this.platform);
		return tmpReason ? new Error(tmpReason) : null;
	}

	/**
	 * Probe a file.
	 *
	 * @param {string} pInputPath
	 * @param {function} fCallback - (pError, pSummary)
	 * @returns {Object} handle { cancel(pImmediate) }
	 */
	probe(pInputPath, fCallback)
	{
		let tmpInput = libPath.resolve(String(pInputPath || ''));
		if (!pInputPath || !libFS.existsSync(tmpInput) || !libFS.statSync(tmpInput).isFile())
		{
			// Always call back asynchronously, so a caller can keep the handle first.
			setImmediate(() => fCallback(new Error(`Input file not found: ${pInputPath}`)));
			return libTools.inertHandle();
		}
		return this.MediaProbe.probe(tmpInput, fCallback);
	}

	/**
	 * What the runs of an encode need from the ffmpeg build -- the ladder
	 * encode, the poster and (unless the plan skips it) the download remux --
	 * read from the argument lists they will run with.
	 *
	 * @param {Object} pPlan
	 * @param {string} pInputPath
	 * @returns {Object} { Encoders, Filters, Hwaccels } (see Tools.capabilityRequirements)
	 */
	ffmpegRequirements(pPlan, pInputPath)
	{
		let tmpInput = String(pInputPath || 'input');
		let tmpArgumentLists =
		[
			this.LadderPlanner.buildEncodeArguments(pPlan, tmpInput),
			libPosterBuilder.buildPosterArguments(pPlan, tmpInput, libPosterBuilder.POSTER_FILE)
		];
		if (pPlan.Download)
		{
			tmpArgumentLists.push(libDownloadBuilder.buildDownloadArguments(pPlan.Rungs[0].File, libDownloadBuilder.DOWNLOAD_FILE));
		}
		return libTools.capabilityRequirements(tmpArgumentLists);
	}

	/**
	 * Check, before anything slow, that this ffmpeg can run a plan: it runs
	 * (`ffmpeg -version`, whose first line also keys the PackageVersion), and
	 * it lists every encoder, filter and hwaccel ffmpegRequirements names
	 * (`-encoders`, `-filters`, `-hwaccels`, listed once per ffmpeg path per
	 * process).  A version below 7 is a warning, never a refusal.
	 *
	 * @param {Object} pPlan
	 * @param {string} pInputPath
	 * @param {function} fCallback - (pError, { FFmpeg, Version, Major, Runnable, Required, Missing, Message, Warnings });
	 *   pError only when ffmpeg cannot be run or listed (or the check was cancelled: `.Cancelled = true`),
	 *   with the report so far when the plan's requirements could be read (Runnable true once -version ran).
	 *   Missing is [{ Kind: 'encoder' | 'filter' | 'hwaccel', Name }] and Message the one sentence naming
	 *   them (null when nothing is missing); Warnings holds the older-version warning.
	 * @returns {Object} handle { cancel(pImmediate) }
	 */
	preflight(pPlan, pInputPath, fCallback)
	{
		let tmpFFmpeg = this.binaries.FFmpeg;
		let tmpReport = { FFmpeg: tmpFFmpeg, Version: null, Major: null, Runnable: false, Required: null, Missing: [], Message: null, Warnings: [] };
		let tmpState = { Current: null, Cancelled: false, Finished: false };
		let fFinish = (pError, pReport) =>
		{
			if (tmpState.Finished)
			{
				return;
			}
			tmpState.Finished = true;
			return fCallback(pError, pReport);
		};
		try
		{
			tmpReport.Required = this.ffmpegRequirements(pPlan, pInputPath);
		}
		catch (pRequirementsError)
		{
			setImmediate(() => fFinish(pRequirementsError));
			return libTools.inertHandle();
		}
		tmpState.Current = libTools.ffmpegVersion(tmpFFmpeg, (pVersionError, pVersionLine) =>
			{
				if (pVersionError || tmpState.Cancelled)
				{
					return fFinish(tmpState.Cancelled ? libTools.cancelledError() : pVersionError, tmpReport);
				}
				tmpReport.Version = pVersionLine;
				tmpReport.Major = libTools.parseFFmpegMajorVersion(pVersionLine);
				tmpReport.Runnable = true;
				let tmpOlder = libTools.olderFFmpegWarning(tmpFFmpeg, pVersionLine);
				if (tmpOlder)
				{
					tmpReport.Warnings.push(tmpOlder);
				}
				tmpState.Current = libTools.checkFFmpegCapabilities(tmpFFmpeg, tmpReport.Required, (pCheckError, pMissing) =>
					{
						if (pCheckError || tmpState.Cancelled)
						{
							return fFinish(tmpState.Cancelled ? libTools.cancelledError() : pCheckError, tmpReport);
						}
						tmpReport.Missing = pMissing;
						if (pMissing.length > 0)
						{
							tmpReport.Message = libTools.describeMissingCapabilities(tmpFFmpeg, pVersionLine, pMissing);
						}
						return fFinish(null, tmpReport);
					});
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
					if (tmpState.Current)
					{
						tmpState.Current.cancel(pImmediate);
					}
					return true;
				}
			});
	}

	/**
	 * Probe and plan (no encode).  Never fails over the ffmpeg build: what
	 * the preflight finds (a missing encoder, filter or hwaccel; an ffmpeg
	 * that does not run; one older than 7.x) is appended to Plan.Warnings and
	 * reported in Preflight, so a plan can be made on a box that cannot encode.
	 *
	 * @param {string} pInputPath
	 * @param {Object} pOptions - planner flags (see LadderPlanner.planLadder)
	 * @param {function} fCallback - (pError, { Probe, Plan, Arguments, CommandLine, Preflight })
	 *   Preflight: { FFmpeg, Version, Major, Runnable, Required, Missing, Message, Warnings } (see preflight);
	 *   Message is also the reason when ffmpeg does not run (Runnable false) or cannot list its
	 *   encoders, filters and hwaccels (Runnable true, Version set)
	 */
	plan(pInputPath, pOptions, fCallback)
	{
		let tmpOptions = this.normalizeOptions(pOptions);
		let tmpInput = libPath.resolve(String(pInputPath || ''));
		let tmpFastError = this._fastPlatformError(tmpOptions);
		if (tmpFastError)
		{
			setImmediate(() => fCallback(tmpFastError));
			return;
		}
		this.probe(pInputPath, (pError, pSummary) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				this._hashLut(tmpOptions, (pLutError) =>
					{
						if (pLutError)
						{
							return fCallback(pLutError);
						}
						let tmpPlan;
						try
						{
							tmpPlan = this.LadderPlanner.plan(pSummary, tmpOptions);
						}
						catch (pPlanError)
						{
							return fCallback(pPlanError);
						}
						let tmpArguments = this.LadderPlanner.buildEncodeArguments(tmpPlan, tmpInput);
						this.preflight(tmpPlan, tmpInput, (pPreflightError, pReport) =>
							{
								let tmpPreflight = pReport;
								if (pPreflightError)
								{
									// An ffmpeg that does not run, or cannot list what it has, cannot encode,
									// but the plan still stands; keep what the preflight did learn.
									tmpPreflight = pReport || { FFmpeg: this.binaries.FFmpeg, Version: null, Major: null, Runnable: false, Required: null, Missing: [], Message: null, Warnings: [] };
									tmpPreflight.Message = pPreflightError.message;
								}
								tmpPreflight.Warnings.forEach((pWarning) => { tmpPlan.Warnings.push(pWarning); });
								if (tmpPreflight.Message)
								{
									tmpPlan.Warnings.push(tmpPreflight.Message);
								}
								return fCallback(null,
									{
										Probe: pSummary,
										Plan: tmpPlan,
										Arguments: tmpArguments,
										CommandLine: libLadderPlanner.formatCommandLine(this.binaries.FFmpeg, tmpArguments),
										Preflight: tmpPreflight
									});
							});
					});
			});
	}

	_hashLut(pOptions, fCallback)
	{
		if (!pOptions.Lut)
		{
			setImmediate(() => fCallback(null));
			return libTools.inertHandle();
		}
		if (!libFS.existsSync(pOptions.Lut) || !libFS.statSync(pOptions.Lut).isFile())
		{
			setImmediate(() => fCallback(new Error(`LUT file not found: ${pOptions.Lut}`)));
			return libTools.inertHandle();
		}
		return libTools.sha256File(pOptions.Lut, (pError, pDigest) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				pOptions.LutSha256 = pDigest;
				return fCallback(null);
			});
	}

	/**
	 * Push a finished package to a server (see Publisher.publish and the
	 * README's "Push protocol").
	 *
	 * @param {string} pPackageDirectory - a committed <out>/<PackageVersion>/
	 * @param {Object} pOptions - { Server, Token, Prefix?, Source?, Title?, Description?, Sensitivity?, ChunkBytes?, Retries?, onProgress? }
	 * @param {function} fCallback - (pError, { AssetGUID, PackageVersion, State, UploadedFiles, UploadedBytes, TotalBytes, Source })
	 * @returns {Object} handle { cancel(), abort() }
	 */
	push(pPackageDirectory, pOptions, fCallback)
	{
		return this.Publisher.publish(pPackageDirectory, pOptions, fCallback);
	}

	/**
	 * Encode a file into a package.
	 *
	 * @param {string} pInputPath
	 * @param {Object} pOptions
	 *   - OutputDirectory {string}  REQUIRED: packages land at <OutputDirectory>/<PackageVersion>/
	 *   - Preset, Fast, Profile, SlowMotion, Lut, Download, Hwaccel, SegmentSeconds, CRF (planner flags;
	 *                               Fast is macOS only: elsewhere the encode fails before probing)
	 *   - Force {boolean}           rebuild an existing package that fails verification (an intact one is
	 *                               never replaced: delete it to re-encode)
	 *   - onProgress {function}     ({ Phase, Percent, Message }); phases probe, preflight, hash, plan, verify,
	 *                               encode, poster, download, sanitise, package, done
	 * @param {function} fCallback - (pError, { PackageVersion, PackageDirectory, Package, Plan, Warnings, Reused });
	 *   a cancel yields an Error with `.Cancelled = true`; another live encode of the same package, `.InProgress = true`;
	 *   an ffmpeg without an encoder, filter or hwaccel the plan uses, `.Capability = true` with `.Missing`
	 *   ([{ Kind, Name }]), `.FFmpeg` and `.FFmpegVersion` -- before the source is hashed or anything is written
	 *   (an ffmpeg older than 7.x only adds a warning to Warnings)
	 * @returns {Object} handle { cancel(), abort() } -- cancel() stops the running step (SIGTERM, then SIGKILL)
	 *   and cleans up asynchronously; abort() SIGKILLs it, removes the partial package and calls back at once
	 */
	encode(pInputPath, pOptions, fCallback)
	{
		let tmpOptions = this.normalizeOptions(pOptions);
		let tmpInput = libPath.resolve(String(pInputPath || ''));
		let tmpState = { Cancelled: false, Current: null, Finished: false, PackageVersion: null, PartialCreated: false };
		let tmpOutput = tmpOptions.OutputDirectory ? libPath.resolve(tmpOptions.OutputDirectory) : null;

		let fProgress = (pPhase, pPercent, pMessage) =>
		{
			// Nothing more is reported once a cancel or abort is asked for: no step is
			// finishing (ffmpeg's final block after SIGTERM is not 100%).
			if (tmpState.Cancelled)
			{
				return;
			}
			if (typeof tmpOptions.onProgress === 'function')
			{
				try
				{
					tmpOptions.onProgress({ Phase: pPhase, Percent: libTools.roundTo(pPercent || 0, 1), Message: pMessage || '' });
				}
				catch (pHandlerError)
				{
					this.log.warn(`RetoldMediaLadder progress handler threw: ${pHandlerError.message}`);
				}
			}
		};

		let fFinish = (pError, pResult) =>
		{
			if (tmpState.Finished)
			{
				return;
			}
			tmpState.Finished = true;
			if (pError && tmpState.PartialCreated)
			{
				try
				{
					this.EncodeRunner.discardPartial(tmpOutput, tmpState.PackageVersion);
				}
				catch (pCleanupError)
				{
					this.log.warn(`RetoldMediaLadder could not remove the partial package: ${pCleanupError.message}`);
				}
			}
			return fCallback(pError, pResult);
		};

		let fCancelledError = () =>
		{
			let tmpError = new Error('Encode cancelled.');
			tmpError.Cancelled = true;
			return tmpError;
		};

		let tmpHandle =
		{
			cancel: () =>
			{
				if (tmpState.Finished || tmpState.Cancelled)
				{
					return false;
				}
				tmpState.Cancelled = true;
				if (tmpState.Current && typeof tmpState.Current.cancel === 'function')
				{
					tmpState.Current.cancel();
				}
				return true;
			},
			abort: () =>
			{
				if (tmpState.Finished)
				{
					return false;
				}
				tmpState.Cancelled = true;
				if (tmpState.Current && typeof tmpState.Current.cancel === 'function')
				{
					tmpState.Current.cancel(true);
				}
				fFinish(fCancelledError());
				return true;
			}
		};

		if (!tmpOutput)
		{
			setImmediate(() => fFinish(new Error('encode requires an OutputDirectory.')));
			return tmpHandle;
		}
		let tmpFastError = this._fastPlatformError(tmpOptions);
		if (tmpFastError)
		{
			setImmediate(() => fFinish(tmpFastError));
			return tmpHandle;
		}

		let tmpContext = {};

		// A tiny sequential step runner; every step checks for cancellation.
		let tmpSteps =
		[
			// 1. Probe, and plan: a bad flag fails here, before any hashing.  (The
			//    plan needs no hash; the LUT's digest goes into it at step 4.)
			(fNext) =>
			{
				fProgress('probe', 0, 'Probing the source');
				tmpState.Current = this.probe(pInputPath, (pError, pSummary) =>
					{
						if (pError)
						{
							return fNext(pError);
						}
						tmpContext.Probe = pSummary;
						if (tmpOptions.Lut && !libFS.existsSync(tmpOptions.Lut))
						{
							return fNext(new Error(`LUT file not found: ${tmpOptions.Lut}`));
						}
						try
						{
							tmpContext.Plan = this.LadderPlanner.plan(pSummary, tmpOptions);
						}
						catch (pPlanError)
						{
							return fNext(pPlanError);
						}
						return fNext();
					});
			},
			// 2. Preflight: ffmpeg runs, and has every encoder, filter and hwaccel the
			//    plan will use -- found out now, not after hashing a multi-GB source.
			(fNext) =>
			{
				fProgress('preflight', 0, 'Checking ffmpeg');
				tmpState.Current = this.preflight(tmpContext.Plan, tmpInput, (pError, pReport) =>
					{
						if (pError)
						{
							return fNext(pError);
						}
						if (pReport.Missing.length > 0)
						{
							return fNext(libTools.capabilityError(pReport.FFmpeg, pReport.Version, pReport.Missing));
						}
						tmpContext.Preflight = pReport;
						// Warn now, before a long hash: the plan's own warnings (step 4's plan
						// has the same ones; the LUT digest changes none) and the preflight's.
						tmpContext.Plan.Warnings.concat(pReport.Warnings).forEach((pWarning) => { this.log.warn(`media-ladder: ${pWarning}`); });
						return fNext();
					});
			},
			// 3. Hash the source and any LUT (they key the PackageVersion).
			(fNext) =>
			{
				fProgress('hash', 0, 'Hashing the source');
				tmpState.Current = libTools.sha256File(tmpInput, (pError, pDigest) =>
					{
						tmpContext.SourceSha256 = pDigest;
						if (pError || tmpState.Cancelled)
						{
							return fNext(pError);
						}
						tmpState.Current = this._hashLut(tmpOptions, fNext);
					});
			},
			// 4. Plan again (now carrying the LUT's digest), PackageVersion: the plan,
			//    the preflight's `ffmpeg -version` line and the source digest, exactly
			//    as 1.0.0 computed it, so a re-run reuses a package made by 1.0.0.
			(fNext) =>
			{
				try
				{
					tmpContext.Plan = this.LadderPlanner.plan(tmpContext.Probe, tmpOptions);
				}
				catch (pPlanError)
				{
					return fNext(pPlanError);
				}
				// Warnings never reach the PackageVersion (PackageWriter.planFingerprint drops them);
				// step 2 has already logged them.
				tmpContext.Preflight.Warnings.forEach((pWarning) => { tmpContext.Plan.Warnings.push(pWarning); });
				tmpContext.FfmpegVersion = tmpContext.Preflight.Version;
				tmpContext.PackageVersion = this.PackageWriter.computePackageVersion(tmpContext.Plan, tmpContext.FfmpegVersion, tmpContext.SourceSha256);
				tmpState.PackageVersion = tmpContext.PackageVersion;
				tmpContext.Paths = this.EncodeRunner.packagePaths(tmpOutput, tmpContext.PackageVersion);
				fProgress('plan', 100, `PackageVersion ${tmpContext.PackageVersion}`);
				return fNext();
			},
			// 5. Reuse a finished package of this version once it verifies; never
			//    replace an intact one (its bytes cannot be reproduced).  Then
			//    claim <PV>.lock and create <PV>.partial/.
			(fNext) =>
			{
				let tmpPackageDirectory = tmpContext.Paths.PackageDirectory;
				let fVerify;
				let fClaim = () =>
				{
					try
					{
						this.EncodeRunner.preparePartial(tmpOutput, tmpContext.PackageVersion);
					}
					catch (pPrepareError)
					{
						return fNext(pPrepareError);
					}
					tmpState.PartialCreated = true;
					if (!tmpContext.ReplaceDamaged && libFS.existsSync(tmpPackageDirectory))
					{
						// Another encode finished this version between the check and the claim.
						this.EncodeRunner.discardPartial(tmpOutput, tmpContext.PackageVersion);
						tmpState.PartialCreated = false;
						return fVerify();
					}
					return fNext();
				};
				fVerify = () =>
				{
					if (!libFS.existsSync(tmpPackageDirectory))
					{
						return fClaim();
					}
					fProgress('verify', 0, 'Verifying the existing package');
					tmpState.Current = this.PackageWriter.verifyPackage(tmpPackageDirectory, tmpContext.PackageVersion, (pError, pReport) =>
						{
							tmpState.Current = null;
							if (pError || tmpState.Cancelled)
							{
								return fNext(pError);
							}
							if (pReport.Intact && !tmpOptions.Force)
							{
								tmpContext.Reused = true;
								tmpContext.Package = pReport.Document;
								return fNext('done');
							}
							if (pReport.Intact)
							{
								let tmpImmutable = new Error(`Package ${tmpPackageDirectory} already exists and verifies intact, so --force will not replace it. A finished package is immutable: its media is served and cached as immutable and a push is keyed by its PackageVersion, but a re-encode with the same inputs does not reproduce the same bytes. Delete the directory yourself to re-encode it (copies already served or pushed will no longer match).`);
								tmpImmutable.PackageExists = true;
								return fNext(tmpImmutable);
							}
							if (!tmpOptions.Force)
							{
								return fNext(new Error(`Package ${tmpPackageDirectory} is damaged (${pReport.Problems.join('; ')}); use --force to rebuild it.`));
							}
							this.log.warn(`media-ladder: rebuilding damaged package ${tmpPackageDirectory} (${pReport.Problems.join('; ')}).`);
							tmpContext.ReplaceDamaged = true;
							return fClaim();
						});
				};
				return fVerify();
			},
			// 6. The single-pass ladder encode.
			(fNext) =>
			{
				fProgress('encode', 0, 'Encoding the ladder');
				let tmpArguments = this.LadderPlanner.buildEncodeArguments(tmpContext.Plan, tmpInput);
				tmpState.Current = this.EncodeRunner.run(tmpArguments,
					{
						Cwd: tmpContext.Paths.PartialDirectory,
						DurationSeconds: tmpContext.Plan.DurationSeconds,
						onProgress: (pPercent) => { fProgress('encode', pPercent); }
					},
					(pError) =>
					{
						tmpState.Current = null;
						return fNext(pError);
					});
			},
			// 7. Master reorder (540p first).
			(fNext) =>
			{
				try
				{
					tmpContext.Variants = this.PackageWriter.reorderMasterFile(tmpContext.Paths.PartialDirectory, tmpContext.Plan);
				}
				catch (pReorderError)
				{
					return fNext(pReorderError);
				}
				return fNext();
			},
			// 8. Poster.
			(fNext) =>
			{
				fProgress('poster', 0, 'Rendering the poster');
				tmpState.Current = this.PosterBuilder.build(tmpContext.Plan, tmpInput, libPath.join(tmpContext.Paths.PartialDirectory, libPosterBuilder.POSTER_FILE), (pError) => fNext(pError));
			},
			// 9. download.mp4.
			(fNext) =>
			{
				if (!tmpContext.Plan.Download)
				{
					return fNext();
				}
				fProgress('download', 0, 'Remuxing download.mp4');
				let tmpTopMedia = libPath.join(tmpContext.Paths.PartialDirectory, tmpContext.Plan.Rungs[0].File);
				tmpState.Current = this.DownloadBuilder.build(tmpTopMedia, libPath.join(tmpContext.Paths.PartialDirectory, libDownloadBuilder.DOWNLOAD_FILE), (pError) => fNext(pError));
			},
			// 10. Sanitise gate, over exactly the files that will be packaged: the
			//     plan's list (a stray .DS_Store or Thumbs.db is never packaged).
			(fNext) =>
			{
				fProgress('sanitise', 0, 'Checking outputs for metadata');
				try
				{
					tmpContext.FilePaths = this.PackageWriter.selectPackageFiles(tmpContext.Paths.PartialDirectory, tmpContext.Plan);
				}
				catch (pFilesError)
				{
					return fNext(pFilesError);
				}
				tmpState.Current = this.Sanitiser.checkFiles(tmpContext.Paths.PartialDirectory, tmpContext.FilePaths, (pError, pReport) =>
					{
						if (pError)
						{
							return fNext(pError);
						}
						tmpContext.Sanitise = pReport;
						if (!pReport.Passed)
						{
							let tmpGateError = new Error(`Sanitise gate failed: ${libSanitiser.describeViolations(pReport.Violations)}`);
							tmpGateError.Violations = pReport.Violations;
							return fNext(tmpGateError);
						}
						return fNext();
					});
			},
			// 11. package.json.
			(fNext) =>
			{
				fProgress('package', 0, 'Writing package.json');
				tmpState.Current = this.PackageWriter.write(tmpContext.Paths.PartialDirectory, { Plan: tmpContext.Plan, PackageVersion: tmpContext.PackageVersion, Variants: tmpContext.Variants, FilePaths: tmpContext.FilePaths }, (pError, pDocument) =>
					{
						tmpContext.Package = pDocument;
						return fNext(pError);
					});
			},
			// 12. Rename into place.
			(fNext) =>
			{
				try
				{
					this.EncodeRunner.commitPartial(tmpOutput, tmpContext.PackageVersion, !!tmpContext.ReplaceDamaged);
					tmpState.PartialCreated = false;
				}
				catch (pCommitError)
				{
					return fNext(pCommitError);
				}
				fProgress('done', 100, 'Package complete');
				return fNext();
			}
		];

		let fRun = (pIndex) =>
		{
			if (tmpState.Cancelled)
			{
				return fFinish(fCancelledError());
			}
			if (pIndex >= tmpSteps.length)
			{
				return fFinish(null,
					{
						PackageVersion: tmpContext.PackageVersion,
						PackageDirectory: tmpContext.Paths.PackageDirectory,
						Package: tmpContext.Package,
						Plan: tmpContext.Plan,
						Warnings: tmpContext.Plan ? tmpContext.Plan.Warnings : [],
						Sanitise: tmpContext.Sanitise || null,
						Reused: !!tmpContext.Reused
					});
			}
			tmpSteps[pIndex]((pError) =>
				{
					tmpState.Current = null;
					if (pError === 'done')
					{
						return fRun(tmpSteps.length);
					}
					if (pError)
					{
						return fFinish(tmpState.Cancelled ? fCancelledError() : pError);
					}
					return fRun(pIndex + 1);
				});
		};
		setImmediate(() => fRun(0));

		return tmpHandle;
	}
}

module.exports = RetoldMediaLadder;
module.exports.MediaProbe = libMediaProbe;
module.exports.LadderPlanner = libLadderPlanner;
module.exports.EncodeRunner = libEncodeRunner;
module.exports.PosterBuilder = libPosterBuilder;
module.exports.DownloadBuilder = libDownloadBuilder;
module.exports.Sanitiser = libSanitiser;
module.exports.PackageWriter = libPackageWriter;
module.exports.Publisher = libPublisher;
module.exports.Tools = libTools;
