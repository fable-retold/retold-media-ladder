/**
* Retold Media Ladder -- EncodeRunner
*
* Runs ffmpeg asynchronously (never execSync: a long encode must not block the
* event loop), turns `-progress pipe:1` output into a percentage, and cancels
* with SIGTERM then SIGKILL.
*
* It also owns the package directory's lifecycle: a package is built in
* `<out>/<PackageVersion>.partial/` and renamed to `<out>/<PackageVersion>/`
* only when complete, so a reader never sees a half-written package (and there
* is no rmSync race with a reader of the live directory).  `<out>/<PV>.lock`
* (pid, host, start time) makes the partial directory exclusive: a second
* encode of the same source into the same output fails fast instead of
* deleting the first one's work, and a lock left by a dead process is taken
* over.  A finished `<PV>/` is never replaced unless it was verified damaged.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libChildProcess = require('node:child_process');
const libCrypto = require('node:crypto');
const libFS = require('node:fs');
const libOS = require('node:os');
const libPath = require('node:path');

const libTools = require('./Media-Ladder-Tools.js');

const DEFAULT_KILL_TIMEOUT_MS = 5000;
const PARTIAL_SUFFIX = '.partial';
const LOCK_SUFFIX = '.lock';
const UNREADABLE_LOCK_GRACE_MS = 30000;
const PACKAGE_VERSION_PATTERN = /^[0-9a-f]{8}$/;

/**
 * Parse a chunk of `-progress` key=value output, carrying a partial line.
 * Pure (returns the new carry).
 *
 * @param {string} pCarry - unfinished text from the previous chunk
 * @param {string} pChunk
 * @param {function} fOnBlock - called with each completed block's fields object (at each `progress=` line)
 * @param {Object} pBlock - the block being accumulated (mutated)
 * @returns {string} the new carry
 */
function parseProgressChunk(pCarry, pChunk, fOnBlock, pBlock)
{
	let tmpText = pCarry + pChunk;
	let tmpLines = tmpText.split(/\r?\n/);
	let tmpCarry = tmpLines.pop();
	for (let i = 0; i < tmpLines.length; i++)
	{
		let tmpLine = tmpLines[i];
		let tmpEquals = tmpLine.indexOf('=');
		if (tmpEquals < 1)
		{
			continue;
		}
		let tmpKey = tmpLine.slice(0, tmpEquals).trim();
		let tmpValue = tmpLine.slice(tmpEquals + 1).trim();
		pBlock[tmpKey] = tmpValue;
		if (tmpKey === 'progress')
		{
			fOnBlock(Object.assign({}, pBlock));
		}
	}
	return tmpCarry;
}

/**
 * Seconds of output written, from a progress block. ffmpeg's `out_time_ms` is
 * really microseconds too, so prefer `out_time_us`.
 *
 * @param {Object} pBlock
 * @returns {number}
 */
function progressSeconds(pBlock)
{
	let tmpMicroseconds = Number(pBlock.out_time_us);
	if (!(tmpMicroseconds >= 0))
	{
		tmpMicroseconds = Number(pBlock.out_time_ms);
	}
	return (tmpMicroseconds >= 0) ? (tmpMicroseconds / 1000000) : 0;
}

/**
 * @param {number} pSeconds
 * @param {number} pDurationSeconds
 * @returns {number} 0..100
 */
function progressPercent(pSeconds, pDurationSeconds)
{
	if (!(pDurationSeconds > 0))
	{
		return 0;
	}
	return Math.max(0, Math.min(100, (pSeconds / pDurationSeconds) * 100));
}

/**
 * Read a lock file's owner record, or null when it is missing or unreadable.
 *
 * @param {string} pLockFile
 * @returns {Object|null} { Pid, Hostname, Started, Token, MTimeMS } (an unparseable lock has only MTimeMS)
 */
function readLockOwner(pLockFile)
{
	let tmpStat;
	let tmpText;
	try
	{
		tmpStat = libFS.statSync(pLockFile);
		tmpText = libFS.readFileSync(pLockFile, 'utf8');
	}
	catch (pError)
	{
		return null;
	}
	let tmpOwner;
	try
	{
		tmpOwner = JSON.parse(tmpText);
	}
	catch (pParseError)
	{
		tmpOwner = {};
	}
	if (!tmpOwner || typeof tmpOwner !== 'object')
	{
		tmpOwner = {};
	}
	tmpOwner.MTimeMS = tmpStat.mtimeMs;
	return tmpOwner;
}

/**
 * Is a lock's owner still running?  A process on another host cannot be
 * checked, so it counts as live; an unreadable lock counts as live only
 * while it is younger than UNREADABLE_LOCK_GRACE_MS (a claimant may be
 * mid-write).
 *
 * @param {Object|null} pOwner
 * @returns {boolean}
 */
function lockOwnerIsLive(pOwner)
{
	if (!pOwner)
	{
		return false;
	}
	if (!(Number(pOwner.Pid) > 0))
	{
		return (Date.now() - (pOwner.MTimeMS || 0)) < UNREADABLE_LOCK_GRACE_MS;
	}
	if (pOwner.Hostname && pOwner.Hostname !== libOS.hostname())
	{
		return true;
	}
	try
	{
		process.kill(Number(pOwner.Pid), 0);
		return true;
	}
	catch (pError)
	{
		return (pError.code === 'EPERM');
	}
}

class EncodeRunner extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'EncodeRunner';

		if (!this.log)
		{
			this.log = this.options.Log || libTools.createFallbackLog(this.options.Verbose);
		}
		this.binaries = libTools.resolveBinaries(this.options);
		// Lock file -> the token this instance wrote into it.
		this._lockTokens = {};
	}

	/**
	 * Run ffmpeg with progress reporting.
	 *
	 * @param {Array<string>} pArguments - ffmpeg arguments (without progress flags)
	 * @param {Object} [pRunOptions]
	 *   - Cwd {string}               working directory (relative outputs land here)
	 *   - DurationSeconds {number}   expected OUTPUT duration, for the percentage
	 *   - onProgress {function}      (pPercent, pBlock) at each progress report
	 *   - KillTimeoutMS {number}     SIGTERM -> SIGKILL grace (default 5000)
	 * @param {function} fCallback - (pError, { Code, Stderr }); a cancel yields an Error with `.Cancelled = true`
	 * @returns {Object} handle { cancel(pImmediate), Process }
	 */
	run(pArguments, pRunOptions, fCallback)
	{
		let tmpRunOptions = pRunOptions || {};
		let tmpKillTimeout = (typeof tmpRunOptions.KillTimeoutMS === 'number') ? tmpRunOptions.KillTimeoutMS : DEFAULT_KILL_TIMEOUT_MS;
		let tmpArguments = ['-progress', 'pipe:1', '-nostats', '-stats_period', '0.5'].concat(pArguments);

		let tmpState = { Finished: false, Cancelled: false, KillTimer: null, Carry: '', Block: {}, Stderr: '' };

		let fFinish = (pError, pResult) =>
		{
			if (tmpState.Finished)
			{
				return;
			}
			tmpState.Finished = true;
			if (tmpState.KillTimer)
			{
				clearTimeout(tmpState.KillTimer);
				tmpState.KillTimer = null;
			}
			return fCallback(pError, pResult);
		};

		let tmpChild;
		try
		{
			tmpChild = libChildProcess.spawn(this.binaries.FFmpeg, tmpArguments, { cwd: tmpRunOptions.Cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] });
		}
		catch (pSpawnError)
		{
			setImmediate(() => fFinish(pSpawnError));
			return libTools.inertHandle();
		}

		tmpChild.stdout.setEncoding('utf8');
		tmpChild.stdout.on('data', (pChunk) =>
			{
				tmpState.Carry = parseProgressChunk(tmpState.Carry, pChunk, (pBlock) =>
					{
						if (typeof tmpRunOptions.onProgress !== 'function')
						{
							return;
						}
						let tmpPercent = (pBlock.progress === 'end') ? 100 : progressPercent(progressSeconds(pBlock), tmpRunOptions.DurationSeconds);
						try
						{
							tmpRunOptions.onProgress(tmpPercent, pBlock);
						}
						catch (pHandlerError)
						{
							this.log.warn(`EncodeRunner progress handler threw: ${pHandlerError.message}`);
						}
					}, tmpState.Block);
			});
		tmpChild.stderr.on('data', (pChunk) =>
			{
				tmpState.Stderr += pChunk.toString('utf8');
				if (tmpState.Stderr.length > 16384)
				{
					tmpState.Stderr = tmpState.Stderr.slice(tmpState.Stderr.length - 16384);
				}
			});
		tmpChild.on('error', (pError) =>
			{
				return fFinish(new Error(`ffmpeg is not runnable (${this.binaries.FFmpeg}): ${pError.message}`));
			});
		tmpChild.on('close', (pCode, pSignal) =>
			{
				if (tmpState.Cancelled)
				{
					let tmpCancelError = new Error('Encode cancelled.');
					tmpCancelError.Cancelled = true;
					tmpCancelError.Signal = pSignal;
					return fFinish(tmpCancelError);
				}
				if (pCode !== 0)
				{
					let tmpError = new Error(`ffmpeg exited with ${(pCode === null) ? `signal ${pSignal}` : `code ${pCode}`}: ${libTools.stderrTail(tmpState.Stderr)}`);
					tmpError.Code = pCode;
					tmpError.Stderr = tmpState.Stderr;
					return fFinish(tmpError);
				}
				return fFinish(null, { Code: pCode, Stderr: tmpState.Stderr });
			});

		return (
			{
				Process: tmpChild,
				// cancel() = SIGTERM then SIGKILL after the grace; cancel(true) = SIGKILL now.
				cancel: (pImmediate) => libTools.killChild(tmpChild, tmpState, tmpKillTimeout, pImmediate)
			});
	}

	/**
	 * Paths for a package being built.
	 *
	 * @param {string} pOutputDirectory
	 * @param {string} pPackageVersion
	 * @returns {Object} { PackageDirectory, PartialDirectory, LockFile }
	 */
	packagePaths(pOutputDirectory, pPackageVersion)
	{
		if (!PACKAGE_VERSION_PATTERN.test(String(pPackageVersion)))
		{
			throw new Error(`Invalid PackageVersion "${pPackageVersion}".`);
		}
		let tmpOutput = libPath.resolve(pOutputDirectory);
		return (
			{
				PackageDirectory: libPath.join(tmpOutput, pPackageVersion),
				PartialDirectory: libPath.join(tmpOutput, `${pPackageVersion}${PARTIAL_SUFFIX}`),
				LockFile: libPath.join(tmpOutput, `${pPackageVersion}${LOCK_SUFFIX}`)
			});
	}

	/**
	 * Claim `<out>/<PV>.lock` exclusively, so two encodes of the same source
	 * into the same output directory never share (or delete) one partial
	 * directory.  A lock whose owner process is gone (a crash, a SIGKILL) is
	 * stale and is taken over; a live owner -- this process included -- makes
	 * the claim fail with an Error marked `.InProgress = true`.
	 *
	 * @param {string} pOutputDirectory
	 * @param {string} pPackageVersion
	 * @returns {string} the lock file
	 */
	claimLock(pOutputDirectory, pPackageVersion)
	{
		let tmpPaths = this.packagePaths(pOutputDirectory, pPackageVersion);
		libFS.mkdirSync(libPath.dirname(tmpPaths.LockFile), { recursive: true });
		let tmpOwner = { Pid: process.pid, Hostname: libOS.hostname(), Started: new Date().toISOString(), Token: libCrypto.randomBytes(8).toString('hex') };
		for (let tmpAttempt = 0; tmpAttempt < 2; tmpAttempt++)
		{
			try
			{
				libFS.writeFileSync(tmpPaths.LockFile, JSON.stringify(tmpOwner), { flag: 'wx' });
				this._lockTokens[tmpPaths.LockFile] = tmpOwner.Token;
				return tmpPaths.LockFile;
			}
			catch (pError)
			{
				if (pError.code !== 'EEXIST')
				{
					throw pError;
				}
			}
			let tmpHolder = readLockOwner(tmpPaths.LockFile);
			if (lockOwnerIsLive(tmpHolder))
			{
				let tmpDescription = (tmpHolder && tmpHolder.Pid) ? `process ${tmpHolder.Pid}${(tmpHolder.Hostname && tmpHolder.Hostname !== libOS.hostname()) ? ` on ${tmpHolder.Hostname}` : ''} since ${tmpHolder.Started}` : 'another process';
				let tmpBusy = new Error(`Package ${pPackageVersion} is already being encoded into ${libPath.dirname(tmpPaths.LockFile)} by ${tmpDescription}. If no encode is running, delete ${tmpPaths.LockFile}.`);
				tmpBusy.InProgress = true;
				throw tmpBusy;
			}
			// Stale: the owner is gone. Take it over.
			this.log.warn(`EncodeRunner: removing a stale lock ${tmpPaths.LockFile} (owner ${(tmpHolder && tmpHolder.Pid) || 'unknown'} is gone).`);
			libFS.rmSync(tmpPaths.LockFile, { force: true });
		}
		let tmpRace = new Error(`Package ${pPackageVersion} is already being encoded into ${libPath.dirname(tmpPaths.LockFile)} (the lock was re-taken while clearing a stale one).`);
		tmpRace.InProgress = true;
		throw tmpRace;
	}

	/**
	 * Release a lock this instance claimed (another owner's lock is left alone).
	 *
	 * @param {string} pOutputDirectory
	 * @param {string} pPackageVersion
	 * @returns {boolean} true when the lock was removed
	 */
	releaseLock(pOutputDirectory, pPackageVersion)
	{
		let tmpPaths = this.packagePaths(pOutputDirectory, pPackageVersion);
		let tmpToken = this._lockTokens[tmpPaths.LockFile];
		if (!tmpToken)
		{
			return false;
		}
		delete this._lockTokens[tmpPaths.LockFile];
		let tmpHolder = readLockOwner(tmpPaths.LockFile);
		if (!tmpHolder || tmpHolder.Token !== tmpToken)
		{
			return false;
		}
		libFS.rmSync(tmpPaths.LockFile, { force: true });
		return true;
	}

	/**
	 * Claim the lock, then create a clean `<out>/<PV>.partial/` (removing a
	 * stale one left by a crashed or cancelled run -- never a live one: the
	 * claim fails first).
	 *
	 * @param {string} pOutputDirectory
	 * @param {string} pPackageVersion
	 * @returns {string} the partial directory
	 */
	preparePartial(pOutputDirectory, pPackageVersion)
	{
		let tmpPaths = this.packagePaths(pOutputDirectory, pPackageVersion);
		this.claimLock(pOutputDirectory, pPackageVersion);
		try
		{
			libFS.rmSync(tmpPaths.PartialDirectory, { recursive: true, force: true });
			libFS.mkdirSync(tmpPaths.PartialDirectory);
		}
		catch (pError)
		{
			this.releaseLock(pOutputDirectory, pPackageVersion);
			throw pError;
		}
		return tmpPaths.PartialDirectory;
	}

	/**
	 * Rename `<PV>.partial/` into place and release the lock.
	 *
	 * A finished package is immutable: its media is served `immutable` and a
	 * push is keyed by PackageVersion, while a re-encode does not reproduce the
	 * same bytes (x264 VBV with threads, VideoToolbox).  So an existing
	 * `<PV>/` is only replaced when the caller has verified it is DAMAGED
	 * (pReplaceDamaged); it is moved aside first and removed after the swap.
	 *
	 * @param {string} pOutputDirectory
	 * @param {string} pPackageVersion
	 * @param {boolean} pReplaceDamaged
	 * @returns {string} the package directory
	 */
	commitPartial(pOutputDirectory, pPackageVersion, pReplaceDamaged)
	{
		let tmpPaths = this.packagePaths(pOutputDirectory, pPackageVersion);
		let tmpRetired = false;
		if (libFS.existsSync(tmpPaths.PackageDirectory))
		{
			if (!pReplaceDamaged)
			{
				throw new Error(`Package ${tmpPaths.PackageDirectory} already exists; a finished package is never replaced.`);
			}
			tmpRetired = `${tmpPaths.PackageDirectory}.retired-${process.pid}-${Date.now()}`;
			libFS.renameSync(tmpPaths.PackageDirectory, tmpRetired);
		}
		libFS.renameSync(tmpPaths.PartialDirectory, tmpPaths.PackageDirectory);
		try
		{
			this.releaseLock(pOutputDirectory, pPackageVersion);
		}
		catch (pReleaseError)
		{
			// The package is in place; a lock left behind is stale (this pid) once the process exits.
			this.log.warn(`EncodeRunner: could not remove ${tmpPaths.LockFile}: ${pReleaseError.message}`);
		}
		if (tmpRetired)
		{
			libFS.rmSync(tmpRetired, { recursive: true, force: true });
		}
		return tmpPaths.PackageDirectory;
	}

	/**
	 * Remove a partial directory (after a failure or cancel) and release the
	 * lock, even when the removal fails (the next claim clears what is left).
	 *
	 * @param {string} pOutputDirectory
	 * @param {string} pPackageVersion
	 */
	discardPartial(pOutputDirectory, pPackageVersion)
	{
		let tmpPaths = this.packagePaths(pOutputDirectory, pPackageVersion);
		try
		{
			libFS.rmSync(tmpPaths.PartialDirectory, { recursive: true, force: true });
		}
		finally
		{
			this.releaseLock(pOutputDirectory, pPackageVersion);
		}
	}
}

module.exports = EncodeRunner;
module.exports.parseProgressChunk = parseProgressChunk;
module.exports.progressSeconds = progressSeconds;
module.exports.progressPercent = progressPercent;
module.exports.readLockOwner = readLockOwner;
module.exports.lockOwnerIsLive = lockOwnerIsLive;
module.exports.PARTIAL_SUFFIX = PARTIAL_SUFFIX;
module.exports.LOCK_SUFFIX = LOCK_SUFFIX;
module.exports.PACKAGE_VERSION_PATTERN = PACKAGE_VERSION_PATTERN;
