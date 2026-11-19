/**
* A fake media-ingest server for the Publisher tests: the server side of the
* push protocol (README "Push protocol"; the media-ingest routes under /1.0/MediaIngest)
* on a plain Node http server, with injectable faults.
*
*   POST <prefix>                          register (dedup on Source.Sha256, else PackageVersion); a re-push
*                                          that asks for another Title/Description/Sensitivity gets
*                                          {Ignored, Current}, as a real server might
*   HEAD <prefix>/<GUID>/<PV>/File/<path>  Upload-Offset = staged size, Upload-Length = expected
*   PUT  <prefix>/<GUID>/<PV>/File/<path>  append one chunk at Upload-Offset (409 on a mismatch,
*                                          with the server's Upload-Offset); whole chunks only
*   POST <prefix>/<GUID>/<PV>/Commit       hash every file: 409 {Missing} / {Mismatched} (the
*                                          mismatched ones truncated to 0), else rename into place
*   GET  <prefix>/<GUID>                   { Asset: { AssetGUID, State, PackageVersion, UploadPackageVersion,
*                                          TotalBytes } } (the media-ingest status route); off
*                                          (404) with StatusRoute: false
*
* Faults (`addFault`) are consumed by the first matching request(s):
*   { Kind: 'register'|'head'|'put'|'commit'|'status', Path?, Skip?, Times?, Action, ... , onStart?(pEntry) }
*   register/commit/status: Action 'status' { Status, Body? | BodyText? } (BodyText: JSON text sent as it is,
*           for an answer JSON.stringify cannot make, such as nesting deeper than the stack);
*           register: 'cutoff' (a 200 whose body is cut off)
*   head:   'status' { Status }, 'offset' { Offset } (report a wrong offset once)
*   put:    'status' { Status, Body? } (answer at once, body unread), 'drop' { AfterBytes } (read that much,
*           then reset the connection; nothing stored), 'stored-lost' (store the chunk, then reset
*           the connection without answering), 'corrupt' (store the chunk with its first byte
*           flipped), 'delay' { DelayMS } (store, then answer late), 'hang' (read, never answer)
*   commit: 'unstage' { File } (delete a staged file first, so the real check reports it Missing)
*
* `commitNow(pGUID, pPV)` runs the commit check in-process (no request), as another push of the
* same version would: tests use it to close a version under a running push.
*
* A PUT holds its file's lock while it runs; another PUT to the file meanwhile is answered 409
* 'An upload to this file is already in progress.' (its log entry gets `Busy: true`) while HEAD
* reports the size without that chunk, as orator-file-service does.  `StaleLockMS` (default 0)
* models a server that has not noticed a dead connection (a half-open socket: orator-file-service
* keeps the lock until Node's requestTimeout ends the request): a PUT whose connection closes before
* its chunk is whole keeps the lock that much longer (its log entry gets `StaleLockMS`, and
* `LockReleasedAt` once it lets go).  Set it on `options` at any time.
*
* @license MIT
*/

const libCrypto = require('node:crypto');
const libFS = require('node:fs');
const libHTTP = require('node:http');
const libPath = require('node:path');

const PV_PATTERN = /^[0-9a-f]{8}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UPLOAD_PATH_PATTERN = /^(v[0-9]\/)?[a-z0-9_-]+\.(m3u8|mp4|m4a|jpg|json)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REGISTER_BYTES = 2 * 1048576;

function sha256OfFile(pPath)
{
	return libCrypto.createHash('sha256').update(libFS.readFileSync(pPath)).digest('hex');
}

function fileSize(pPath)
{
	try
	{
		return libFS.statSync(pPath).size;
	}
	catch (pError)
	{
		return 0;
	}
}

function validatePackage(pDocument)
{
	let tmpErrors = [];
	if (!pDocument || typeof pDocument !== 'object')
	{
		return ['Package must be an object.'];
	}
	if (pDocument.Version !== 1)
	{
		tmpErrors.push('Version must be 1.');
	}
	if (pDocument.Kind !== 'video')
	{
		tmpErrors.push('Kind must be video.');
	}
	if (!PV_PATTERN.test(String(pDocument.PackageVersion)))
	{
		tmpErrors.push('PackageVersion must be 8 hex digits.');
	}
	if (!Array.isArray(pDocument.Files) || pDocument.Files.length < 1)
	{
		tmpErrors.push('Files must be a non-empty array.');
		return tmpErrors;
	}
	let tmpSeen = {};
	pDocument.Files.forEach((pFile) =>
		{
			if (!pFile || !UPLOAD_PATH_PATTERN.test(String(pFile.Path)) || pFile.Path === 'package.json' || tmpSeen[pFile.Path])
			{
				tmpErrors.push(`Bad file path ${JSON.stringify(pFile && pFile.Path)}.`);
				return;
			}
			tmpSeen[pFile.Path] = true;
			if (!Number.isSafeInteger(pFile.Bytes) || pFile.Bytes < 0)
			{
				tmpErrors.push(`Bad Bytes for ${pFile.Path}.`);
			}
			if (!SHA256_PATTERN.test(String(pFile.Sha256)))
			{
				tmpErrors.push(`Bad Sha256 for ${pFile.Path}.`);
			}
		});
	return tmpErrors;
}

class FakeMediaIngestServer
{
	/**
	 * @param {Object} pOptions - { Root (directory), Token, Prefix='/1.0/MediaIngest', MaxChunkBytes=32 MiB,
	 *   CommitAlreadyLive: 'idempotent' (200) | 'conflict' (409 'This package version is not being uploaded.'),
	 *   StatusRoute: true (GET <prefix>/<GUID>) | false (404),
	 *   StaleLockMS: 0 (how long a PUT cut off mid-chunk keeps its file's lock) }
	 */
	constructor(pOptions)
	{
		this.options = Object.assign({ Prefix: '/1.0/MediaIngest', MaxChunkBytes: 33554432, CommitAlreadyLive: 'idempotent', StatusRoute: true, StaleLockMS: 0 }, pOptions || {});
		this.Root = this.options.Root;
		this.Assets = {};
		this.Faults = [];
		this.Log = [];
		this.Registrations = [];
		this.AuthorizationHeaders = [];
		this.Locks = {};
		this.StaleLockTimers = [];
		this.Hanging = [];
		this.server = null;
		this.Port = 0;
		this.BaseURL = null;
	}

	start(fCallback)
	{
		this.server = libHTTP.createServer((pRequest, pResponse) => this._handle(pRequest, pResponse));
		this.server.listen(0, '127.0.0.1', () =>
			{
				this.Port = this.server.address().port;
				this.BaseURL = `http://127.0.0.1:${this.Port}`;
				return fCallback();
			});
	}

	stop(fCallback)
	{
		this.Hanging.forEach((pResponse) =>
			{
				try
				{
					pResponse.destroy();
				}
				catch (pError)
				{
					// gone
				}
			});
		this.Hanging = [];
		this.StaleLockTimers.forEach((pTimer) => clearTimeout(pTimer));
		this.StaleLockTimers = [];
		if (!this.server)
		{
			return fCallback();
		}
		this.server.closeAllConnections();
		this.server.close(() => fCallback());
	}

	addFault(pFault)
	{
		this.Faults.push(Object.assign({ Times: 1, Skip: 0 }, pFault));
		return this;
	}

	clearFaults()
	{
		this.Faults = [];
		return this;
	}

	/** Log entries of one kind (and file path). */
	entries(pKind, pPath)
	{
		return this.Log.filter((pEntry) => pEntry.Kind === pKind && (!pPath || pEntry.Path === pPath));
	}

	stagingDirectory(pGUID, pPackageVersion)
	{
		return libPath.join(this.Root, pGUID, '.staging', pPackageVersion);
	}

	liveDirectory(pGUID, pPackageVersion)
	{
		return libPath.join(this.Root, pGUID, pPackageVersion);
	}

	_takeFault(pKind, pPath)
	{
		for (let i = 0; i < this.Faults.length; i++)
		{
			let tmpFault = this.Faults[i];
			if (tmpFault.Kind !== pKind || (tmpFault.Path && tmpFault.Path !== pPath) || tmpFault.Times < 1)
			{
				continue;
			}
			if (tmpFault.Skip > 0)
			{
				tmpFault.Skip--;
				return null;
			}
			tmpFault.Times--;
			return tmpFault;
		}
		return null;
	}

	_send(pResponse, pEntry, pStatus, pBody, pHeaders)
	{
		pEntry.Status = pStatus;
		let tmpHeaders = Object.assign({ 'Cache-Control': 'no-store' }, pHeaders || {});
		if (pBody === null || typeof pBody === 'undefined')
		{
			pResponse.writeHead(pStatus, tmpHeaders);
			pResponse.end();
			return;
		}
		let tmpText = (pBody && typeof pBody.BodyText === 'string') ? pBody.BodyText : JSON.stringify(pBody);
		tmpHeaders['Content-Type'] = 'application/json';
		tmpHeaders['Content-Length'] = Buffer.byteLength(tmpText);
		pResponse.writeHead(pStatus, tmpHeaders);
		pResponse.end(tmpText);
	}

	_handle(pRequest, pResponse)
	{
		let tmpPath = String(pRequest.url).split('?')[0];
		let tmpEntry = { Method: pRequest.method, Kind: 'other', Path: null, Offset: null, ContentLength: null, Status: null, Fault: null, At: Date.now() };
		this.Log.push(tmpEntry);
		this.AuthorizationHeaders.push(pRequest.headers.authorization || '');

		if (pRequest.headers.authorization !== `Bearer ${this.options.Token}`)
		{
			pRequest.resume();
			return this._send(pResponse, tmpEntry, 401, { Error: 'Not signed in.' });
		}
		let tmpPrefix = this.options.Prefix;
		if (tmpPath === tmpPrefix && pRequest.method === 'POST')
		{
			tmpEntry.Kind = 'register';
			return this._register(pRequest, pResponse, tmpEntry);
		}
		if (tmpPath.indexOf(`${tmpPrefix}/`) !== 0)
		{
			pRequest.resume();
			return this._send(pResponse, tmpEntry, 404, { Error: 'Not found.' });
		}
		let tmpRest = tmpPath.slice(tmpPrefix.length + 1);
		let tmpStatus = /^([^/]+)$/.exec(tmpRest);
		if (tmpStatus && pRequest.method === 'GET' && this.options.StatusRoute !== false)
		{
			tmpEntry.Kind = 'status';
			pRequest.resume();
			return this._status(decodeURIComponent(tmpStatus[1]), pResponse, tmpEntry);
		}
		let tmpCommit = /^([^/]+)\/([^/]+)\/Commit$/.exec(tmpRest);
		if (tmpCommit && pRequest.method === 'POST')
		{
			tmpEntry.Kind = 'commit';
			pRequest.resume();
			return this._commit(decodeURIComponent(tmpCommit[1]), decodeURIComponent(tmpCommit[2]), pResponse, tmpEntry);
		}
		let tmpFile = /^([^/]+)\/([^/]+)\/File\/(.+)$/.exec(tmpRest);
		if (tmpFile && (pRequest.method === 'HEAD' || pRequest.method === 'PUT'))
		{
			tmpEntry.Kind = (pRequest.method === 'HEAD') ? 'head' : 'put';
			let tmpSubPath;
			try
			{
				// restify hands the splat over percent-decoded; so does this.
				tmpSubPath = decodeURIComponent(tmpFile[3]);
			}
			catch (pError)
			{
				pRequest.resume();
				return this._send(pResponse, tmpEntry, 400, { Error: 'Bad path.' });
			}
			tmpEntry.Path = tmpSubPath;
			return this._file(decodeURIComponent(tmpFile[1]), decodeURIComponent(tmpFile[2]), tmpSubPath, pRequest, pResponse, tmpEntry);
		}
		pRequest.resume();
		return this._send(pResponse, tmpEntry, 404, { Error: 'Not found.' });
	}

	_register(pRequest, pResponse, pEntry)
	{
		let tmpChunks = [];
		let tmpBytes = 0;
		let tmpTooLarge = false;
		pRequest.on('data', (pChunk) =>
			{
				tmpBytes += pChunk.length;
				if (tmpBytes > MAX_REGISTER_BYTES)
				{
					tmpTooLarge = true;
					return;
				}
				tmpChunks.push(pChunk);
			});
		pRequest.on('end', () =>
			{
				let tmpFault = this._takeFault('register', null);
				if (tmpFault)
				{
					pEntry.Fault = tmpFault.Action;
					if (typeof tmpFault.onStart === 'function')
					{
						tmpFault.onStart(pEntry);
					}
					if (tmpFault.Action === 'cutoff')
					{
						pEntry.Status = 'cutoff';
						pResponse.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
						pResponse.write('{"AssetGUID":');
						return setTimeout(() => pRequest.socket.destroy(), 20);
					}
					return this._send(pResponse, pEntry, tmpFault.Status, ((typeof tmpFault.BodyText === 'string') ? { BodyText: tmpFault.BodyText } : (tmpFault.Body || { Error: `Injected ${tmpFault.Status}.` })));
				}
				if (tmpTooLarge)
				{
					return this._send(pResponse, pEntry, 413, { Error: 'Payload too large.' });
				}
				let tmpBody;
				try
				{
					tmpBody = JSON.parse(Buffer.concat(tmpChunks).toString('utf8'));
				}
				catch (pError)
				{
					return this._send(pResponse, pEntry, 400, { Error: 'Body is not JSON.' });
				}
				this.Registrations.push(tmpBody);
				let tmpErrors = validatePackage(tmpBody.Package);
				if (tmpErrors.length > 0)
				{
					return this._send(pResponse, pEntry, 400, { Error: 'The package document is not valid.', Errors: tmpErrors });
				}
				let tmpDocument = tmpBody.Package;
				let tmpPackageVersion = tmpDocument.PackageVersion;
				let tmpSourceSha = (tmpBody.Source && typeof tmpBody.Source.Sha256 === 'string') ? tmpBody.Source.Sha256 : '';
				let tmpAsset = Object.keys(this.Assets).map((pKey) => this.Assets[pKey]).filter((pAsset) =>
					{
						return tmpSourceSha
							? (pAsset.SourceSha256 === tmpSourceSha)
							: (pAsset.PackageVersion === tmpPackageVersion || pAsset.UploadPackageVersion === tmpPackageVersion);
					})[0];
				if (!tmpAsset)
				{
					tmpAsset =
					{
						GUID: libCrypto.randomUUID(),
						State: 'uploading',
						PackageVersion: '',
						PreviousPackageVersion: '',
						UploadPackageVersion: '',
						UploadPackage: null,
						SourceSha256: tmpSourceSha,
						Title: (typeof tmpBody.Title === 'string' && tmpBody.Title.trim()) ? tmpBody.Title.trim() : 'Untitled',
						Description: (typeof tmpBody.Description === 'string') ? tmpBody.Description : '',
						Sensitivity: (typeof tmpBody.Sensitivity === 'string' && tmpBody.Sensitivity) ? tmpBody.Sensitivity : 'normal',
						ConsentState: 'unknown',
						Created: true
					};
					this.Assets[tmpAsset.GUID] = tmpAsset;
				}
				// As a real server might: never apply Title/Description/Sensitivity on a re-push, and say which it kept.
				let tmpIgnored = [];
				if (!tmpAsset.Created)
				{
					if (typeof tmpBody.Title === 'string' && tmpBody.Title.trim() && tmpBody.Title.trim() !== tmpAsset.Title) { tmpIgnored.push('Title'); }
					if (typeof tmpBody.Description === 'string' && tmpBody.Description !== tmpAsset.Description) { tmpIgnored.push('Description'); }
					if (typeof tmpBody.Sensitivity === 'string' && tmpBody.Sensitivity && tmpBody.Sensitivity !== tmpAsset.Sensitivity) { tmpIgnored.push('Sensitivity'); }
				}
				tmpAsset.Created = false;
				let tmpMissing = [];
				if (!(tmpAsset.PackageVersion === tmpPackageVersion && tmpAsset.State === 'ready'))
				{
					if (tmpAsset.UploadPackageVersion && tmpAsset.UploadPackageVersion !== tmpPackageVersion)
					{
						libFS.rmSync(this.stagingDirectory(tmpAsset.GUID, tmpAsset.UploadPackageVersion), { recursive: true, force: true });
					}
					tmpAsset.UploadPackageVersion = tmpPackageVersion;
					tmpAsset.UploadPackage = tmpDocument;
					tmpDocument.Files.forEach((pFile) =>
						{
							let tmpReceived = fileSize(libPath.join(this.stagingDirectory(tmpAsset.GUID, tmpPackageVersion), pFile.Path));
							if (tmpReceived !== pFile.Bytes)
							{
								tmpMissing.push({ Path: pFile.Path, Bytes: pFile.Bytes, ReceivedBytes: tmpReceived });
							}
						});
				}
				let tmpAnswer = { AssetGUID: tmpAsset.GUID, PackageVersion: tmpPackageVersion, State: tmpAsset.State, Missing: tmpMissing };
				if (tmpIgnored.length > 0)
				{
					tmpAnswer.Ignored = tmpIgnored;
					tmpAnswer.Current = { Title: tmpAsset.Title, Sensitivity: tmpAsset.Sensitivity, ConsentState: tmpAsset.ConsentState };
				}
				return this._send(pResponse, pEntry, 200, tmpAnswer);
			});
	}

	_file(pGUID, pPackageVersion, pSubPath, pRequest, pResponse, pEntry)
	{
		let fEarly = (pStatus, pBody, pHeaders) =>
		{
			// Answer without reading the body: Node drains it on a keep-alive socket.
			return this._send(pResponse, pEntry, pStatus, (pRequest.method === 'HEAD') ? null : pBody, pHeaders);
		};
		if (!UUID_PATTERN.test(pGUID) || !PV_PATTERN.test(pPackageVersion) || !UPLOAD_PATH_PATTERN.test(pSubPath))
		{
			return fEarly(404, { Error: 'Not found.' });
		}
		let tmpAsset = this.Assets[pGUID];
		if (!tmpAsset)
		{
			return fEarly(404, { Error: 'Not found.' });
		}
		if (tmpAsset.PackageVersion === pPackageVersion && tmpAsset.State === 'ready')
		{
			return fEarly(409, { Error: 'Already committed.' });
		}
		if (tmpAsset.UploadPackageVersion !== pPackageVersion)
		{
			return fEarly(409, { Error: 'This package version is not being uploaded.' });
		}
		let tmpFile = tmpAsset.UploadPackage.Files.filter((pCandidate) => pCandidate.Path === pSubPath)[0];
		if (!tmpFile)
		{
			return fEarly(404, { Error: 'Not found.' });
		}
		let tmpTarget = libPath.join(this.stagingDirectory(pGUID, pPackageVersion), pSubPath);
		let tmpSize = fileSize(tmpTarget);

		if (pRequest.method === 'HEAD')
		{
			let tmpFault = this._takeFault('head', pSubPath);
			let tmpReported = tmpSize;
			if (tmpFault)
			{
				pEntry.Fault = tmpFault.Action;
				if (tmpFault.Action === 'status')
				{
					return fEarly(tmpFault.Status, null);
				}
				if (tmpFault.Action === 'offset')
				{
					tmpReported = tmpFault.Offset;
				}
			}
			pEntry.Offset = tmpReported;
			return this._send(pResponse, pEntry, 200, null, { 'Upload-Offset': String(tmpReported), 'Upload-Length': String(tmpFile.Bytes) });
		}

		// PUT
		let tmpOffsetHeader = pRequest.headers['upload-offset'];
		if (typeof tmpOffsetHeader !== 'string' || !/^\d+$/.test(tmpOffsetHeader))
		{
			return fEarly(400, { Error: 'Upload-Offset is required.' });
		}
		let tmpOffset = Number(tmpOffsetHeader);
		let tmpLength = (typeof pRequest.headers['content-length'] === 'string') ? Number(pRequest.headers['content-length']) : null;
		pEntry.Offset = tmpOffset;
		pEntry.ContentLength = tmpLength;
		let tmpFault = this._takeFault('put', pSubPath);
		if (tmpFault)
		{
			pEntry.Fault = tmpFault.Action;
			if (typeof tmpFault.onStart === 'function')
			{
				tmpFault.onStart(pEntry);
			}
			if (tmpFault.Action === 'status')
			{
				return fEarly(tmpFault.Status, ((typeof tmpFault.BodyText === 'string') ? { BodyText: tmpFault.BodyText } : (tmpFault.Body || { Error: `Injected ${tmpFault.Status}.` })));
			}
		}
		if (tmpLength !== null && tmpLength > this.options.MaxChunkBytes)
		{
			return fEarly(413, { Error: 'Payload too large.' });
		}
		if (tmpLength !== null && tmpOffset + tmpLength > tmpFile.Bytes)
		{
			return fEarly(413, { Error: 'Payload too large.' });
		}
		if (this.Locks[tmpTarget])
		{
			pEntry.Busy = true;
			return fEarly(409, { Error: 'An upload to this file is already in progress.' });
		}
		if (tmpOffset !== tmpSize)
		{
			return fEarly(409, { Error: 'Upload-Offset does not match.' }, { 'Upload-Offset': String(tmpSize) });
		}

		let tmpLock = { Entry: pEntry };
		this.Locks[tmpTarget] = tmpLock;
		let tmpChunks = [];
		let tmpReceived = 0;
		let tmpSettled = false;
		// pCutOff: the connection closed before the chunk was whole; with StaleLockMS the lock
		// outlives it, as on a server that has not noticed the connection is gone.
		let fRelease = (pCutOff) =>
		{
			if (tmpSettled)
			{
				return false;
			}
			tmpSettled = true;
			let fUnlock = () =>
			{
				if (this.Locks[tmpTarget] === tmpLock)
				{
					delete this.Locks[tmpTarget];
				}
				pEntry.LockReleasedAt = Date.now();
			};
			let tmpHoldMS = pCutOff ? (Number(this.options.StaleLockMS) || 0) : 0;
			if (tmpHoldMS > 0)
			{
				pEntry.StaleLockMS = tmpHoldMS;
				this.StaleLockTimers.push(setTimeout(fUnlock, tmpHoldMS));
				return true;
			}
			fUnlock();
			return true;
		};
		let fStore = () =>
		{
			let tmpData = Buffer.concat(tmpChunks);
			if (tmpFault && tmpFault.Action === 'corrupt' && tmpData.length > 0)
			{
				tmpData[0] = tmpData[0] ^ 0xFF;
			}
			libFS.mkdirSync(libPath.dirname(tmpTarget), { recursive: true });
			libFS.appendFileSync(tmpTarget, tmpData);
			pEntry.Stored = tmpData.length;
			return tmpOffset + tmpData.length;
		};
		pRequest.on('data', (pChunk) =>
			{
				if (tmpSettled)
				{
					return;
				}
				tmpChunks.push(pChunk);
				tmpReceived += pChunk.length;
				if (tmpFault && tmpFault.Action === 'drop' && tmpReceived >= tmpFault.AfterBytes)
				{
					// Mid-chunk connection loss: nothing of this chunk is kept.
					fRelease(true);
					pEntry.Status = 'dropped';
					pRequest.socket.destroy();
				}
			});
		pRequest.on('error', () => { fRelease(true); });
		pRequest.on('close', () =>
			{
				if (!pRequest.complete && fRelease(true))
				{
					// Client gave up mid-chunk (cancel, timeout): atomic chunks keep nothing.
					pEntry.Status = pEntry.Status || 'aborted';
				}
			});
		pRequest.on('end', () =>
			{
				if (tmpSettled)
				{
					return;
				}
				if (tmpFault && tmpFault.Action === 'hang')
				{
					// Read the body; never answer (and keep nothing).
					fRelease();
					pEntry.Status = 'hung';
					this.Hanging.push(pResponse);
					return;
				}
				let tmpNewOffset = fStore();
				fRelease();
				let fAnswer = () =>
				{
					this._send(pResponse, pEntry, 200, { Success: true, Offset: tmpNewOffset, ExpectedBytes: tmpFile.Bytes, Complete: tmpNewOffset === tmpFile.Bytes }, { 'Upload-Offset': String(tmpNewOffset) });
				};
				if (tmpFault && tmpFault.Action === 'stored-lost')
				{
					pEntry.Status = 'stored-lost';
					pRequest.socket.destroy();
					return;
				}
				if (tmpFault && tmpFault.Action === 'delay')
				{
					return setTimeout(fAnswer, tmpFault.DelayMS);
				}
				return fAnswer();
			});
	}

	_status(pGUID, pResponse, pEntry)
	{
		let tmpAsset = UUID_PATTERN.test(pGUID) ? this.Assets[pGUID] : null;
		if (!tmpAsset)
		{
			return this._send(pResponse, pEntry, 404, { Error: 'Not found.' });
		}
		let tmpFault = this._takeFault('status', null);
		if (tmpFault && tmpFault.Action === 'status')
		{
			pEntry.Fault = tmpFault.Action;
			return this._send(pResponse, pEntry, tmpFault.Status, ((typeof tmpFault.BodyText === 'string') ? { BodyText: tmpFault.BodyText } : (tmpFault.Body || { Error: `Injected ${tmpFault.Status}.` })));
		}
		return this._send(pResponse, pEntry, 200,
			{
				Asset:
				{
					AssetGUID: tmpAsset.GUID,
					State: tmpAsset.State,
					PackageVersion: tmpAsset.PackageVersion,
					UploadPackageVersion: tmpAsset.UploadPackageVersion,
					TotalBytes: (typeof tmpAsset.TotalBytes === 'number') ? tmpAsset.TotalBytes : 0
				}
			});
	}

	_commit(pGUID, pPackageVersion, pResponse, pEntry)
	{
		let tmpAsset = UUID_PATTERN.test(pGUID) ? this.Assets[pGUID] : null;
		if (!tmpAsset || !PV_PATTERN.test(pPackageVersion))
		{
			return this._send(pResponse, pEntry, 404, { Error: 'Not found.' });
		}
		let tmpFault = this._takeFault('commit', null);
		if (tmpFault)
		{
			pEntry.Fault = tmpFault.Action;
			if (tmpFault.Action === 'status')
			{
				return this._send(pResponse, pEntry, tmpFault.Status, ((typeof tmpFault.BodyText === 'string') ? { BodyText: tmpFault.BodyText } : (tmpFault.Body || { Error: `Injected ${tmpFault.Status}.` })));
			}
			if (tmpFault.Action === 'unstage')
			{
				libFS.rmSync(libPath.join(this.stagingDirectory(pGUID, pPackageVersion), tmpFault.File), { force: true });
			}
		}
		let tmpResult = this.commitNow(pGUID, pPackageVersion);
		return this._send(pResponse, pEntry, tmpResult.Status, tmpResult.Body);
	}

	/**
	 * The commit check, in-process: { Status, Body }.
	 */
	commitNow(pGUID, pPackageVersion)
	{
		let tmpAsset = UUID_PATTERN.test(pGUID) ? this.Assets[pGUID] : null;
		if (!tmpAsset || !PV_PATTERN.test(pPackageVersion))
		{
			return this._answer(404, { Error: 'Not found.' });
		}
		if (tmpAsset.PackageVersion === pPackageVersion && tmpAsset.State === 'ready')
		{
			if (this.options.CommitAlreadyLive === 'conflict')
			{
				return this._answer(409, { Error: 'This package version is not being uploaded.' });
			}
			return this._answer(200, { AssetGUID: pGUID, PackageVersion: pPackageVersion, State: 'ready', TotalBytes: tmpAsset.TotalBytes });
		}
		if (tmpAsset.UploadPackageVersion !== pPackageVersion)
		{
			return this._answer(409, { Error: 'This package version is not being uploaded.' });
		}
		let tmpStaging = this.stagingDirectory(pGUID, pPackageVersion);
		let tmpDocument = tmpAsset.UploadPackage;
		let tmpMissing = [];
		tmpDocument.Files.forEach((pFile) =>
			{
				let tmpReceived = fileSize(libPath.join(tmpStaging, pFile.Path));
				if (!libFS.existsSync(libPath.join(tmpStaging, pFile.Path)) || tmpReceived < pFile.Bytes)
				{
					tmpMissing.push({ Path: pFile.Path, Bytes: pFile.Bytes, ReceivedBytes: tmpReceived });
				}
			});
		if (tmpMissing.length > 0)
		{
			return this._answer(409, { Error: 'Some files have not been uploaded.', Missing: tmpMissing });
		}
		let tmpMismatched = [];
		tmpDocument.Files.forEach((pFile) =>
			{
				let tmpStaged = libPath.join(tmpStaging, pFile.Path);
				if (fileSize(tmpStaged) !== pFile.Bytes || sha256OfFile(tmpStaged) !== pFile.Sha256)
				{
					libFS.truncateSync(tmpStaged, 0);
					tmpMismatched.push(pFile.Path);
				}
			});
		if (tmpMismatched.length > 0)
		{
			return this._answer(409, { Error: 'Some files did not match their Sha256.', Mismatched: tmpMismatched });
		}
		libFS.writeFileSync(libPath.join(tmpStaging, 'package.json'), JSON.stringify(tmpDocument, null, '\t') + '\n');
		let tmpLive = this.liveDirectory(pGUID, pPackageVersion);
		libFS.rmSync(tmpLive, { recursive: true, force: true });
		libFS.renameSync(tmpStaging, tmpLive);
		libFS.writeFileSync(libPath.join(tmpLive, '.ready'), '');
		if (tmpAsset.PackageVersion && tmpAsset.PackageVersion !== pPackageVersion)
		{
			tmpAsset.PreviousPackageVersion = tmpAsset.PackageVersion;
		}
		tmpAsset.State = 'ready';
		tmpAsset.PackageVersion = pPackageVersion;
		tmpAsset.UploadPackageVersion = '';
		tmpAsset.UploadPackage = null;
		tmpAsset.TotalBytes = tmpDocument.Files.reduce((pSum, pFile) => pSum + pFile.Bytes, 0);
		return this._answer(200, { AssetGUID: pGUID, PackageVersion: pPackageVersion, State: 'ready', TotalBytes: tmpAsset.TotalBytes });
	}

	_answer(pStatus, pBody)
	{
		return { Status: pStatus, Body: pBody };
	}
}

module.exports = FakeMediaIngestServer;
