/**
* Integration tests: real encodes of tiny synthesized sources.
*
* Sources are made with ffmpeg lavfi (testsrc2 + sine) in a temp directory:
* landscape with audio, native portrait, rotation-tagged portrait, no audio,
* 10-bit HLG (libx265), 100 fps, a clip carrying location / creation_time /
* Apple tags, a 0.3 s clip (ffmpeg writes no master variants for it), and
* 1 s of video in a 30 s container (the poster's seek point has no frame, so
* the package has no poster and still pushes).
* Every package goes through the on-disk contract check:
* package.json files exist with matching Bytes/Sha256, the master starts on
* the <=540 rung, every rung is a single_file fMP4 byte-range playlist with
* EXT-X-MAP -> media.mp4 (no index.m4s anywhere), and ffprobe of every output
* passes the sanitise gate.  The lifecycle tests cover package immutability
* (--force never replaces an intact package), the `<PV>.lock` claim against a
* concurrent encode, cancel / abort in every phase (a cancelled encode never
* reports 100%), and stray OS files (.DS_Store, Thumbs.db) in the partial
* package, which are never packaged, so the package still pushes.
*
* When ffmpeg/ffprobe are not on PATH the suite SKIPS LOUDLY.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libChildProcess = require('node:child_process');
const libCrypto = require('node:crypto');
const libFS = require('node:fs');
const libOS = require('node:os');
const libPath = require('node:path');

const libRetoldMediaLadder = require('../source/Retold-Media-Ladder.js');
const libPackageWriter = require('../source/Package-Writer.js');
const libTools = require('../source/Media-Ladder-Tools.js');
const libStandInFFmpeg = require('./support/Stand-In-FFmpeg.js');

const TOOLS_AVAILABLE = (() =>
{
	try
	{
		return libChildProcess.spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0
			&& libChildProcess.spawnSync('ffprobe', ['-hide_banner', '-version']).status === 0;
	}
	catch (pError)
	{
		return false;
	}
})();

const FAST = { Preset: 'ultrafast' };

function ffmpegSync(pArguments)
{
	let tmpResult = libChildProcess.spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'].concat(pArguments), { encoding: 'utf8' });
	if (tmpResult.status !== 0)
	{
		throw new Error(`ffmpeg failed building a test source: ${tmpResult.stderr}`);
	}
}

function ffprobeSync(pPath)
{
	let tmpResult = libChildProcess.spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', pPath], { encoding: 'utf8' });
	if (tmpResult.status !== 0)
	{
		throw new Error(`ffprobe failed on ${pPath}: ${tmpResult.stderr}`);
	}
	return JSON.parse(tmpResult.stdout);
}

function sha256Of(pPath)
{
	return libCrypto.createHash('sha256').update(libFS.readFileSync(pPath)).digest('hex');
}

function walkFiles(pDirectory, pPrefix)
{
	let tmpFiles = [];
	libFS.readdirSync(pDirectory, { withFileTypes: true }).forEach((pEntry) =>
		{
			let tmpRelative = pPrefix ? `${pPrefix}/${pEntry.name}` : pEntry.name;
			if (pEntry.isDirectory())
			{
				tmpFiles = tmpFiles.concat(walkFiles(libPath.join(pDirectory, pEntry.name), tmpRelative));
			}
			else
			{
				tmpFiles.push(tmpRelative);
			}
		});
	return tmpFiles.sort();
}

/** { relative path: sha256 } for every file in a package directory. */
function snapshotPackage(pDirectory)
{
	let tmpSnapshot = {};
	walkFiles(pDirectory, '').forEach((pPath) => { tmpSnapshot[pPath] = sha256Of(libPath.join(pDirectory, pPath)); });
	return tmpSnapshot;
}

/** The init section of a rung's media.mp4, per its playlist's EXT-X-MAP. */
function readInit(pPackageDirectory, pRendition)
{
	let tmpPlaylist = libPackageWriter.parseMediaPlaylist(libFS.readFileSync(libPath.join(pPackageDirectory, pRendition.Playlist), 'utf8'));
	let tmpRange = libPackageWriter.parseByteRange(tmpPlaylist.Map.ByteRange);
	return libFS.readFileSync(libPath.join(pPackageDirectory, pRendition.File)).subarray(tmpRange.Offset || 0, (tmpRange.Offset || 0) + tmpRange.Length);
}

function topLevelBoxes(pPath)
{
	let tmpBuffer = libFS.readFileSync(pPath);
	let tmpBoxes = [];
	let tmpOffset = 0;
	while (tmpOffset + 8 <= tmpBuffer.length)
	{
		let tmpSize = tmpBuffer.readUInt32BE(tmpOffset);
		let tmpType = tmpBuffer.slice(tmpOffset + 4, tmpOffset + 8).toString('latin1');
		if (tmpSize === 1)
		{
			tmpSize = Number(tmpBuffer.readBigUInt64BE(tmpOffset + 8));
		}
		if (tmpSize < 8)
		{
			break;
		}
		tmpBoxes.push(tmpType);
		tmpOffset += tmpSize;
	}
	return tmpBoxes;
}

/**
 * The on-disk contract (contracts.md section 1), checked from the files alone.
 */
function assertPackageContract(pLadder, pResult, pSourcePath, fDone)
{
	let tmpDirectory = pResult.PackageDirectory;
	let tmpVersion = pResult.PackageVersion;
	Expect(tmpVersion).to.match(/^[0-9a-f]{8}$/);
	Expect(libPath.basename(tmpDirectory)).to.equal(tmpVersion);
	Expect(libFS.existsSync(`${tmpDirectory}.partial`), 'no partial directory left behind').to.equal(false);
	Expect(libFS.existsSync(`${tmpDirectory}.lock`), 'no lock left behind').to.equal(false);

	let tmpPackageText = libFS.readFileSync(libPath.join(tmpDirectory, 'package.json'), 'utf8');
	let tmpPackage = JSON.parse(tmpPackageText);
	Expect(tmpPackage).to.deep.equal(pResult.Package);
	Expect(tmpPackage.Version).to.equal(1);
	Expect(tmpPackage.Kind).to.equal('video');
	Expect(tmpPackage.PackageVersion).to.equal(tmpVersion);
	Expect(tmpPackage.Manifest).to.equal('master.m3u8');
	Expect(tmpPackage.Audio).to.equal(null);
	Expect(tmpPackage.DurationMS).to.be.above(0);

	// No source name, capture date or location anywhere in the package document.
	Expect(tmpPackageText).to.not.contain(libPath.basename(pSourcePath, libPath.extname(pSourcePath)));
	Expect(tmpPackageText).to.not.match(/location|creation_time|2024-05-01/i);

	// Files[]: every file except package.json, each with matching Bytes + Sha256.
	let tmpOnDisk = walkFiles(tmpDirectory, '').filter((pPath) => pPath !== 'package.json');
	Expect(tmpPackage.Files.map((pFile) => pFile.Path).sort()).to.deep.equal(tmpOnDisk);
	tmpPackage.Files.forEach((pFile) =>
		{
			let tmpAbsolute = libPath.join(tmpDirectory, pFile.Path);
			Expect(libFS.statSync(tmpAbsolute).size, pFile.Path).to.equal(pFile.Bytes);
			Expect(sha256Of(tmpAbsolute), pFile.Path).to.equal(pFile.Sha256);
		});
	let tmpFilesByPath = {};
	tmpPackage.Files.forEach((pFile) => { tmpFilesByPath[pFile.Path] = pFile; });

	// No .m4s at all -- in particular no index.m4s.
	Expect(tmpOnDisk.filter((pPath) => /\.m4s$/.test(pPath))).to.deep.equal([]);
	Expect(tmpOnDisk.filter((pPath) => /index\.m4s/.test(pPath))).to.deep.equal([]);

	// Renditions: top first, v<i>, displayed dims, Bytes/Sha256 of media.mp4.
	Expect(tmpPackage.Renditions.length).to.be.above(0);
	tmpPackage.Renditions.forEach((pRendition, pIndex) =>
		{
			Expect(pRendition.Playlist).to.equal(`v${pIndex}/index.m3u8`);
			Expect(pRendition.File).to.equal(`v${pIndex}/media.mp4`);
			Expect(pRendition.ShortSide).to.equal(Math.min(pRendition.Width, pRendition.Height));
			Expect(pRendition.Name).to.equal(`${pRendition.ShortSide}p`);
			Expect(pRendition.Bytes).to.equal(tmpFilesByPath[pRendition.File].Bytes);
			Expect(pRendition.Sha256).to.equal(tmpFilesByPath[pRendition.File].Sha256);
			Expect(pRendition.Bandwidth).to.be.above(0);
			Expect(pRendition.Codecs).to.match(/^avc1\./);
			if (pIndex > 0)
			{
				Expect(pRendition.ShortSide).to.be.below(tmpPackage.Renditions[pIndex - 1].ShortSide);
			}

			// Each rung: fMP4 single_file, byte ranges, EXT-X-MAP -> media.mp4.
			let tmpPlaylistText = libFS.readFileSync(libPath.join(tmpDirectory, pRendition.Playlist), 'utf8');
			let tmpPlaylist = libPackageWriter.parseMediaPlaylist(tmpPlaylistText);
			Expect(tmpPlaylistText).to.match(/#EXT-X-MAP:URI="media\.mp4",BYTERANGE="\d+@0"/);
			Expect(tmpPlaylist.Map.URI).to.equal('media.mp4');
			Expect(tmpPlaylist.PlaylistType).to.equal('VOD');
			Expect(tmpPlaylist.EndList).to.equal(true);
			Expect(tmpPlaylist.IndependentSegments).to.equal(true);
			Expect(tmpPlaylist.Segments.length).to.be.above(0);
			tmpPlaylist.Segments.forEach((pSegment) =>
				{
					Expect(pSegment.URI).to.equal('media.mp4');
					Expect(pSegment.ByteRange).to.match(/^\d+@\d+$/);
				});
		});
	Expect(tmpPackage.Width).to.equal(tmpPackage.Renditions[0].Width);
	Expect(tmpPackage.Height).to.equal(tmpPackage.Renditions[0].Height);

	// Master: the 540p rung (or the closest <= 540) is FIRST.
	let tmpMaster = libPackageWriter.parseMasterPlaylist(libFS.readFileSync(libPath.join(tmpDirectory, 'master.m3u8'), 'utf8'));
	Expect(tmpMaster.Variants.length).to.equal(tmpPackage.Renditions.length);
	let tmpAtOrBelow = tmpPackage.Renditions.filter((pRendition) => pRendition.ShortSide <= 540);
	let tmpExpectedFirst = tmpAtOrBelow.length > 0 ? tmpAtOrBelow[0] : tmpPackage.Renditions[tmpPackage.Renditions.length - 1];
	Expect(tmpMaster.Variants[0].URI).to.equal(tmpExpectedFirst.Playlist);

	// Poster: JFIF, no EXIF.
	if (tmpPackage.Poster)
	{
		let tmpPoster = libFS.readFileSync(libPath.join(tmpDirectory, tmpPackage.Poster));
		Expect(tmpPoster[0]).to.equal(0xFF);
		Expect(tmpPoster[1]).to.equal(0xD8);
		Expect(tmpPoster.indexOf(Buffer.from('Exif'))).to.equal(-1);
	}

	// download.mp4: moov before mdat (+faststart).
	if (tmpPackage.Download)
	{
		let tmpBoxes = topLevelBoxes(libPath.join(tmpDirectory, tmpPackage.Download));
		Expect(tmpBoxes.indexOf('moov')).to.be.above(-1);
		Expect(tmpBoxes.indexOf('moov')).to.be.below(tmpBoxes.indexOf('mdat'));
	}

	// Direct ffprobe of every media output: no identifying tags, no data streams.
	tmpOnDisk.filter((pPath) => /\.(mp4|jpg)$/.test(pPath)).forEach((pPath) =>
		{
			let tmpProbe = ffprobeSync(libPath.join(tmpDirectory, pPath));
			let tmpTagKeys = Object.keys((tmpProbe.format && tmpProbe.format.tags) || {});
			(tmpProbe.streams || []).forEach((pStream) =>
				{
					Expect(pStream.codec_type, pPath).to.not.equal('data');
					tmpTagKeys = tmpTagKeys.concat(Object.keys(pStream.tags || {}));
				});
			Expect(tmpTagKeys.filter((pKey) => /location|creation_time|com\.apple\.quicktime|title|date/i.test(pKey)), pPath).to.deep.equal([]);
		});

	// And the module's own sanitise gate agrees.
	pLadder.Sanitiser.checkFiles(tmpDirectory, tmpOnDisk, (pError, pReport) =>
		{
			if (pError)
			{
				return fDone(pError);
			}
			try
			{
				Expect(pReport.Violations).to.deep.equal([]);
				Expect(pReport.Passed).to.equal(true);
			}
			catch (pAssertError)
			{
				return fDone(pAssertError);
			}
			return fDone(null, tmpPackage);
		});
}

suite
(
	'Retold Media Ladder -- integration encodes',
	function ()
	{
		let tmpWorkDirectory = false;
		let tmpSources = {};
		let tmpLadder = new libRetoldMediaLadder({});

		function encodeAndCheck(pSource, pOptions, fCheck)
		{
			let tmpOptions = Object.assign({ OutputDirectory: libPath.join(tmpWorkDirectory, 'out') }, FAST, pOptions || {});
			tmpLadder.encode(pSource, tmpOptions, (pError, pResult) =>
				{
					if (pError)
					{
						return fCheck(pError);
					}
					assertPackageContract(tmpLadder, pResult, pSource, (pContractError, pPackage) =>
						{
							if (pContractError)
							{
								return fCheck(pContractError);
							}
							return fCheck(null, pResult, pPackage);
						});
				});
		}

		function guard(fDone, fBody)
		{
			return (pError, pResult, pPackage) =>
			{
				if (pError)
				{
					return fDone(pError);
				}
				try
				{
					fBody(pResult, pPackage);
				}
				catch (pAssertError)
				{
					return fDone(pAssertError);
				}
				return fDone();
			};
		}

		suiteSetup
		(
			function ()
			{
				if (!TOOLS_AVAILABLE)
				{
					// eslint-disable-next-line no-console
					console.warn('\n  !!! retold-media-ladder integration tests SKIPPED: ffmpeg/ffprobe not found on PATH !!!\n');
					this.skip();
					return;
				}
				tmpWorkDirectory = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'retold-media-ladder-test-'));
				let fSource = (pName) => libPath.join(tmpWorkDirectory, pName);
				let tmpTestSource = (pSize, pRate, pSeconds) => ['-f', 'lavfi', '-i', `testsrc2=size=${pSize}:rate=${pRate}:duration=${pSeconds}`];
				let tmpSine = (pSeconds) => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${pSeconds}`];
				let tmpX264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

				tmpSources.Landscape = fSource('landscape clip.mp4');
				ffmpegSync([].concat(tmpTestSource('1280x720', 30, 3), tmpSine(3), tmpX264, ['-c:a', 'aac', '-shortest', tmpSources.Landscape]));

				tmpSources.Portrait = fSource('portrait.mp4');
				ffmpegSync([].concat(tmpTestSource('720x1280', 30, 2), tmpSine(2), tmpX264, ['-c:a', 'aac', '-shortest', tmpSources.Portrait]));

				tmpSources.Rotated = fSource('rotated.mp4');
				ffmpegSync(['-display_rotation', '90', '-i', tmpSources.Portrait.replace('portrait.mp4', 'landscape clip.mp4'), '-c', 'copy', tmpSources.Rotated]);

				tmpSources.NoAudio = fSource('drone-no-audio.mp4');
				ffmpegSync([].concat(tmpTestSource('1280x720', 30, 2), tmpX264, [tmpSources.NoAudio]));

				tmpSources.HLG = fSource('hlg-10bit.mp4');
				ffmpegSync([].concat(tmpTestSource('1280x720', 30, 2), tmpSine(2),
					['-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast',
						'-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
						'-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1',
						'-c:a', 'aac', '-shortest', tmpSources.HLG]));

				tmpSources.Fps100 = fSource('fps100.mp4');
				ffmpegSync([].concat(tmpTestSource('1280x720', 100, 2), tmpSine(2), tmpX264, ['-c:a', 'aac', '-shortest', tmpSources.Fps100]));

				tmpSources.Short = fSource('short.mp4');
				ffmpegSync([].concat(tmpTestSource('1280x720', 30, 0.3), tmpSine(0.3), tmpX264, ['-c:a', 'aac', '-shortest', tmpSources.Short]));

				tmpSources.Tagged = fSource('DJI_20240501100000_0001_D.mp4');
				ffmpegSync([].concat(tmpTestSource('1280x720', 30, 2), tmpSine(2), tmpX264,
					['-c:a', 'aac', '-shortest',
						'-movflags', 'use_metadata_tags',
						'-metadata', 'location=+37.7749-122.4194/',
						'-metadata', 'com.apple.quicktime.location.ISO6709=+37.7749-122.4194+010.000/',
						'-metadata', 'com.apple.quicktime.make=DJI',
						'-metadata', 'com.apple.quicktime.model=Mini 4 Pro',
						'-metadata', 'creation_time=2024-05-01T10:00:00Z',
						'-metadata', 'title=DJI_20240501100000_0001_D',
						'-metadata:s:v:0', 'handler_name=DJI.AVC',
						'-metadata:s:v:0', 'creation_time=2024-05-01T10:00:00Z',
						tmpSources.Tagged]));
			}
		);

		suiteTeardown
		(
			() =>
			{
				if (tmpWorkDirectory)
				{
					libFS.rmSync(tmpWorkDirectory, { recursive: true, force: true });
				}
			}
		);

		test
		(
			'landscape 1280x720 with audio: 720/540/360, 540p first, poster, faststart download',
			(fDone) =>
			{
				encodeAndCheck(tmpSources.Landscape, {}, guard(fDone, (pResult, pPackage) =>
					{
						Expect(pResult.Reused).to.equal(false);
						Expect(pPackage.Renditions.map((pRendition) => `${pRendition.Width}x${pRendition.Height}`)).to.deep.equal(['1280x720', '960x540', '640x360']);
						Expect(pPackage.HasAudio).to.equal(true);
						Expect(pPackage.Renditions[0].Codecs).to.contain('mp4a.40.2');
						Expect(pPackage.Poster).to.equal('poster.jpg');
						Expect(pPackage.Download).to.equal('download.mp4');
						Expect(pPackage.SegmentSeconds).to.equal(6);
						Expect(pPackage.DurationMS).to.be.within(2900, 3100);
						Expect(pPackage.Renditions[0].FrameRate).to.equal(30);

						let tmpPoster = ffprobeSync(libPath.join(pResult.PackageDirectory, 'poster.jpg')).streams[0];
						Expect(`${tmpPoster.width}x${tmpPoster.height}`).to.equal('1280x720');
						let tmpDownload = ffprobeSync(libPath.join(pResult.PackageDirectory, 'download.mp4'));
						Expect(tmpDownload.streams.map((pStream) => pStream.codec_type).sort()).to.deep.equal(['audio', 'video']);

						// The short-clip master rebuild derives CODECS and BANDWIDTH the way ffmpeg does.
						pPackage.Renditions.forEach((pRendition) =>
							{
								Expect(libPackageWriter.codecsFromInit(readInit(pResult.PackageDirectory, pRendition))).to.equal(pRendition.Codecs);
								let tmpMeasured = libPackageWriter.measureBandwidth(libPackageWriter.parseMediaPlaylist(libFS.readFileSync(libPath.join(pResult.PackageDirectory, pRendition.Playlist), 'utf8')));
								Expect(tmpMeasured.Bandwidth).to.be.closeTo(pRendition.Bandwidth, pRendition.Bandwidth * 0.001);
							});
					}));
			}
		);

		test
		(
			'an identical re-run reuses the verified package; --force will not replace an intact (immutable) one',
			(fDone) =>
			{
				let tmpOutput = libPath.join(tmpWorkDirectory, 'out');
				let tmpOptions = Object.assign({ OutputDirectory: tmpOutput }, FAST);
				let tmpPhases = [];
				tmpLadder.encode(tmpSources.Landscape, Object.assign({ onProgress: (pEvent) => { tmpPhases.push(pEvent.Phase); } }, tmpOptions), (pError, pReused) =>
					{
						if (pError)
						{
							return fDone(pError);
						}
						let tmpBefore;
						try
						{
							Expect(pReused.Reused).to.equal(true);
							Expect(tmpPhases).to.include('verify');
							Expect(tmpPhases).to.not.include('encode');
							tmpBefore = snapshotPackage(pReused.PackageDirectory);
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						// x264 VBV with threads (and VideoToolbox) do not reproduce their bytes, so a
						// re-encode under the same PackageVersion would break the immutable contract.
						tmpLadder.encode(tmpSources.Landscape, Object.assign({ Force: true }, tmpOptions), (pForceError) =>
							{
								try
								{
									Expect(pForceError).to.be.an('error');
									Expect(pForceError.PackageExists).to.equal(true);
									Expect(pForceError.message).to.contain('verifies intact').and.to.contain('immutable').and.to.contain(pReused.PackageVersion);
									Expect(snapshotPackage(pReused.PackageDirectory)).to.deep.equal(tmpBefore);
									Expect(libFS.readdirSync(tmpOutput).filter((pName) => /retired|partial|lock/.test(pName))).to.deep.equal([]);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								return fDone();
							});
					});
			}
		);

		test
		(
			'a damaged package is refused without --force and rebuilt with --force',
			(fDone) =>
			{
				let tmpOptions = Object.assign({ OutputDirectory: libPath.join(tmpWorkDirectory, 'damaged'), Download: false }, FAST);
				tmpLadder.encode(tmpSources.NoAudio, tmpOptions, (pError, pFirst) =>
					{
						if (pError)
						{
							return fDone(pError);
						}
						// Same size, different bytes.
						let tmpPosterPath = libPath.join(pFirst.PackageDirectory, 'poster.jpg');
						let tmpPoster = libFS.readFileSync(tmpPosterPath);
						tmpPoster[tmpPoster.length - 3] ^= 0xFF;
						libFS.writeFileSync(tmpPosterPath, tmpPoster);
						tmpLadder.encode(tmpSources.NoAudio, tmpOptions, (pDamagedError) =>
							{
								try
								{
									Expect(pDamagedError).to.be.an('error');
									Expect(pDamagedError.message).to.contain('is damaged').and.to.contain('poster.jpg does not match its Sha256').and.to.contain('--force');
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								encodeAndCheck(tmpSources.NoAudio, { OutputDirectory: tmpOptions.OutputDirectory, Download: false, Force: true }, guard(fDone, (pRebuilt) =>
									{
										Expect(pRebuilt.Reused).to.equal(false);
										Expect(pRebuilt.PackageVersion).to.equal(pFirst.PackageVersion);
										Expect(libFS.readdirSync(tmpOptions.OutputDirectory)).to.deep.equal([pFirst.PackageVersion]);
									}));
							});
					});
			}
		);

		test
		(
			'two concurrent encodes of one package: the second fails fast, the first finishes untouched',
			(fDone) =>
			{
				let tmpConcurrent = libPath.join(tmpWorkDirectory, 'concurrent.mp4');
				ffmpegSync(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', tmpConcurrent]);
				let tmpOptions = { OutputDirectory: libPath.join(tmpWorkDirectory, 'concurrent'), Preset: 'medium', Download: false };
				let tmpResults = { First: null, Second: null };
				let tmpSecondStarted = false;
				let fSettle = () =>
				{
					if (!tmpResults.First || !tmpResults.Second)
					{
						return;
					}
					try
					{
						Expect(tmpResults.Second.Error).to.be.an('error');
						Expect(tmpResults.Second.Error.InProgress).to.equal(true);
						Expect(tmpResults.Second.Error.message).to.contain('already being encoded');
					}
					catch (pAssertError)
					{
						return fDone(pAssertError);
					}
					if (tmpResults.First.Error)
					{
						return fDone(tmpResults.First.Error);
					}
					assertPackageContract(tmpLadder, tmpResults.First.Result, tmpConcurrent, (pContractError) => fDone(pContractError || undefined));
				};
				tmpLadder.encode(tmpConcurrent, Object.assign(
					{
						onProgress: (pEvent) =>
						{
							if (pEvent.Phase !== 'encode' || tmpSecondStarted)
							{
								return;
							}
							// The first encode holds the lock and is writing its partial: start an identical one.
							tmpSecondStarted = true;
							new libRetoldMediaLadder({}).encode(tmpConcurrent, tmpOptions, (pError, pResult) =>
								{
									tmpResults.Second = { Error: pError, Result: pResult };
									fSettle();
								});
						}
					}, tmpOptions), (pError, pResult) =>
					{
						tmpResults.First = { Error: pError, Result: pResult };
						fSettle();
					});
			}
		);

		test
		(
			'a 0.3 s clip packages: ffmpeg writes a master with no variants, so it is rebuilt from the rungs',
			(fDone) =>
			{
				encodeAndCheck(tmpSources.Short, {}, guard(fDone, (pResult, pPackage) =>
					{
						Expect(pPackage.Renditions.map((pRendition) => pRendition.Name)).to.deep.equal(['720p', '540p', '360p']);
						Expect(pPackage.DurationMS).to.be.within(250, 400);
						pPackage.Renditions.forEach((pRendition) =>
							{
								Expect(pRendition.Codecs).to.match(/^avc1\.[0-9a-f]{6},mp4a\.40\.2$/);
								Expect(libPackageWriter.codecsFromInit(readInit(pResult.PackageDirectory, pRendition))).to.equal(pRendition.Codecs);
								let tmpPlaylist = libPackageWriter.parseMediaPlaylist(libFS.readFileSync(libPath.join(pResult.PackageDirectory, pRendition.Playlist), 'utf8'));
								Expect(tmpPlaylist.TargetDuration).to.be.at.least(1);
							});
					}));
			}
		);

		test
		(
			'native portrait 720x1280: the top rung is the short side wide',
			(fDone) =>
			{
				encodeAndCheck(tmpSources.Portrait, {}, guard(fDone, (pResult, pPackage) =>
					{
						Expect(pResult.Plan.Orientation).to.equal('portrait');
						Expect(pPackage.Renditions.map((pRendition) => `${pRendition.Width}x${pRendition.Height}`)).to.deep.equal(['720x1280', '540x960', '360x640']);
						Expect(pPackage.Width).to.equal(720);
						Expect(pPackage.Height).to.equal(1280);
					}));
			}
		);

		test
		(
			'rotation-tagged portrait (1280x720 stored, rotated 90): autorotated, top rung 720 wide',
			(fDone) =>
			{
				tmpLadder.probe(tmpSources.Rotated, (pProbeError, pSummary) =>
					{
						if (pProbeError)
						{
							return fDone(pProbeError);
						}
						try
						{
							Expect(pSummary.Video.Width).to.equal(1280);
							Expect(pSummary.Video.Rotation).to.equal(90);
							Expect(pSummary.Video.DisplayWidth).to.equal(720);
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						encodeAndCheck(tmpSources.Rotated, {}, guard(fDone, (pResult, pPackage) =>
							{
								Expect(pPackage.Renditions[0].Width).to.equal(720);
								Expect(pPackage.Renditions[0].Height).to.equal(1280);
								let tmpTop = ffprobeSync(libPath.join(pResult.PackageDirectory, 'v0', 'media.mp4')).streams.filter((pStream) => pStream.codec_type === 'video')[0];
								Expect(tmpTop.width).to.equal(720);
								Expect(tmpTop.height).to.equal(1280);
								// The rotation was applied to the pixels, not carried as a display matrix.
								Expect(JSON.stringify(tmpTop.side_data_list || [])).to.not.contain('Display Matrix');
							}));
					});
			}
		);

		test
		(
			'no audio: video-only variants and download',
			(fDone) =>
			{
				encodeAndCheck(tmpSources.NoAudio, {}, guard(fDone, (pResult, pPackage) =>
					{
						Expect(pPackage.HasAudio).to.equal(false);
						pPackage.Renditions.forEach((pRendition) => { Expect(pRendition.Codecs).to.not.contain('mp4a'); });
						let tmpTop = ffprobeSync(libPath.join(pResult.PackageDirectory, 'v0', 'media.mp4'));
						Expect(tmpTop.streams.map((pStream) => pStream.codec_type)).to.deep.equal(['video']);
						let tmpDownload = ffprobeSync(libPath.join(pResult.PackageDirectory, 'download.mp4'));
						Expect(tmpDownload.streams.map((pStream) => pStream.codec_type)).to.deep.equal(['video']);
					}));
			}
		);

		test
		(
			'HLG 10-bit HEVC: tone-mapped to 8-bit BT.709 on every rung; the poster is an 8-bit JPEG',
			(fDone) =>
			{
				encodeAndCheck(tmpSources.HLG, {}, guard(fDone, (pResult, pPackage) =>
					{
						Expect(pResult.Plan.Colour.Mode).to.equal('hlg-hable');
						pPackage.Renditions.forEach((pRendition) =>
							{
								let tmpVideo = ffprobeSync(libPath.join(pResult.PackageDirectory, pRendition.File)).streams.filter((pStream) => pStream.codec_type === 'video')[0];
								Expect(tmpVideo.codec_name).to.equal('h264');
								Expect(tmpVideo.pix_fmt).to.equal('yuv420p');
								Expect(tmpVideo.color_transfer).to.equal('bt709');
								Expect(tmpVideo.color_primaries).to.equal('bt709');
								Expect(tmpVideo.color_space).to.equal('bt709');
							});
						Expect(pPackage.Renditions.map((pRendition) => pRendition.Name)).to.deep.equal(['720p', '540p', '360p']);
						let tmpPoster = ffprobeSync(libPath.join(pResult.PackageDirectory, 'poster.jpg')).streams[0];
						Expect(tmpPoster.codec_name).to.equal('mjpeg');
						Expect(tmpPoster.pix_fmt).to.equal('yuvj420p');
					}));
			}
		);

		test
		(
			'100 fps conforms to 50 fps (software decode)',
			(fDone) =>
			{
				encodeAndCheck(tmpSources.Fps100, { Hwaccel: false }, guard(fDone, (pResult, pPackage) =>
					{
						Expect(pResult.Plan.FrameRate.Output).to.equal('50/1');
						Expect(pResult.Plan.Decode.Hwaccel).to.equal(null);
						Expect(pPackage.Renditions[0].FrameRate).to.equal(50);
						let tmpVideo = ffprobeSync(libPath.join(pResult.PackageDirectory, 'v0', 'media.mp4')).streams.filter((pStream) => pStream.codec_type === 'video')[0];
						Expect(tmpVideo.avg_frame_rate).to.equal('50/1');
					}));
			}
		);

		test
		(
			'--slowmo stretches 100 fps to 30 fps (every frame kept) and drops the audio',
			(fDone) =>
			{
				encodeAndCheck(tmpSources.Fps100, { SlowMotion: true, Download: false }, guard(fDone, (pResult, pPackage) =>
					{
						Expect(pResult.Plan.FrameRate.SlowMotionFactor).to.equal('10/3');
						Expect(pPackage.HasAudio).to.equal(false);
						Expect(pPackage.Renditions[0].FrameRate).to.equal(30);
						// 2 s of 100 fps = 200 frames, shown at 30 fps = ~6.67 s.
						Expect(pPackage.DurationMS).to.be.within(6500, 6800);
						let tmpTop = ffprobeSync(libPath.join(pResult.PackageDirectory, 'v0', 'media.mp4'));
						Expect(tmpTop.streams.map((pStream) => pStream.codec_type)).to.deep.equal(['video']);
						Expect(tmpTop.streams[0].avg_frame_rate).to.equal('30/1');
					}));
			}
		);

		test
		(
			'a source carrying location / creation_time / Apple tags comes out clean',
			(fDone) =>
			{
				// The gate itself sees the source's tags...
				let tmpSourceDirectory = libPath.dirname(tmpSources.Tagged);
				tmpLadder.Sanitiser.checkFiles(tmpSourceDirectory, [libPath.basename(tmpSources.Tagged)], (pError, pReport) =>
					{
						if (pError)
						{
							return fDone(pError);
						}
						try
						{
							Expect(pReport.Passed).to.equal(false);
							let tmpKeys = pReport.Violations.map((pViolation) => pViolation.Key);
							Expect(tmpKeys).to.include('creation_time');
							Expect(tmpKeys.filter((pKey) => /location/.test(pKey)).length).to.be.above(0);
							Expect(tmpKeys).to.include('com.apple.quicktime.make');
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						// ...and none of them reach the package (asserted by the contract check).
						encodeAndCheck(tmpSources.Tagged, {}, guard(fDone, (pResult) =>
							{
								Expect(pResult.Sanitise.Passed).to.equal(true);
								Expect(pResult.Sanitise.Checked).to.include('poster.jpg');
								Expect(pResult.Sanitise.Checked).to.include('download.mp4');
							}));
					});
			}
		);

		test
		(
			'--no-download and a --lut at an awkward path (space, comma, colon, brackets)',
			(fDone) =>
			{
				let tmpLutDirectory = libPath.join(tmpWorkDirectory, 'LUTs, odd:dir');
				libFS.mkdirSync(tmpLutDirectory, { recursive: true });
				let tmpLines = ['TITLE "identity"', 'LUT_3D_SIZE 2'];
				[0, 1].forEach((pB) => [0, 1].forEach((pG) => [0, 1].forEach((pR) => tmpLines.push(`${pR}.0 ${pG}.0 ${pB}.0`))));
				let tmpLutPath = libPath.join(tmpLutDirectory, 'identity [v1].cube');
				libFS.writeFileSync(tmpLutPath, tmpLines.join('\n') + '\n');

				encodeAndCheck(tmpSources.NoAudio, { Download: false, Lut: tmpLutPath }, guard(fDone, (pResult, pPackage) =>
					{
						Expect(pResult.Plan.Colour.Mode).to.equal('lut');
						Expect(pPackage.Download).to.equal(null);
						Expect(pPackage.Files.map((pFile) => pFile.Path)).to.not.include('download.mp4');
						Expect(JSON.stringify(pPackage)).to.not.contain('identity');
					}));
			}
		);

		test
		(
			'a sanitise failure fails the encode and leaves nothing behind',
			(fDone) =>
			{
				let tmpLeakyLadder = new libRetoldMediaLadder({});
				// Simulate a remux that leaked the source's tags into download.mp4.
				tmpLeakyLadder.DownloadBuilder.build = (pTopMediaPath, pOutputPath, fCallback) =>
				{
					libFS.copyFileSync(tmpSources.Tagged, pOutputPath);
					return fCallback(null, pOutputPath);
				};
				let tmpOutput = libPath.join(tmpWorkDirectory, 'leaky');
				tmpLeakyLadder.encode(tmpSources.Landscape, Object.assign({ OutputDirectory: tmpOutput }, FAST), (pError) =>
					{
						try
						{
							Expect(pError).to.be.an('error');
							Expect(pError.message).to.contain('Sanitise gate failed');
							Expect(pError.Violations.map((pViolation) => pViolation.File)).to.include('download.mp4');
							Expect(libFS.readdirSync(tmpOutput)).to.deep.equal([]);
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						return fDone();
					});
			}
		);

		test
		(
			'strays (.DS_Store, Thumbs.db) in <PV>.partial/ are never sanitised, listed, hashed or pushed; the package pushes',
			(fDone) =>
			{
				let libFakeServer = require('./support/Fake-Media-Ingest-Server.js');
				let tmpToken = 'test-token-0123456789abcdef';
				let tmpWarnings = [];
				let fQuiet = () => {};
				let fRecord = (pMessage) => { tmpWarnings.push(String(pMessage)); };
				let tmpStrayLadder = new libRetoldMediaLadder({ Log: { trace: fQuiet, debug: fQuiet, info: fQuiet, warn: fRecord, error: fRecord } });
				// Record what the sanitise gate is asked to check.
				let tmpSanitised = null;
				let tmpRealCheckFiles = tmpStrayLadder.Sanitiser.checkFiles.bind(tmpStrayLadder.Sanitiser);
				tmpStrayLadder.Sanitiser.checkFiles = (pDirectory, pRelativePaths, fCallback) =>
				{
					tmpSanitised = pRelativePaths.slice();
					return tmpRealCheckFiles(pDirectory, pRelativePaths, fCallback);
				};
				let tmpStrayBytes = { '.DS_Store': Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]), 'Thumbs.db': Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) };
				let tmpStrays = ['.DS_Store', 'Thumbs.db', 'v0/.DS_Store', 'v0/Thumbs.db'];
				let tmpOutput = libPath.join(tmpWorkDirectory, 'strays');
				tmpStrayLadder.encode(tmpSources.NoAudio, Object.assign(
					{
						OutputDirectory: tmpOutput,
						onProgress: (pEvent) =>
						{
							if (pEvent.Phase !== 'sanitise')
							{
								return;
							}
							// Finder / Explorer writing into <PV>.partial/ while someone looks in, just before the package is listed.
							let tmpPartial = libFS.readdirSync(tmpOutput).filter((pName) => /\.partial$/.test(pName))[0];
							tmpStrays.forEach((pPath) => { libFS.writeFileSync(libPath.join(tmpOutput, tmpPartial, pPath), tmpStrayBytes[libPath.basename(pPath)]); });
						}
					}, FAST), (pError, pResult) =>
					{
						if (pError)
						{
							return fDone(pError);
						}
						let tmpPlanned;
						try
						{
							tmpPlanned = libPackageWriter.plannedPackageFiles(pResult.Plan);
							Expect(tmpPlanned).to.include('poster.jpg').and.to.include('download.mp4');
							let tmpDocument = JSON.parse(libFS.readFileSync(libPath.join(pResult.PackageDirectory, 'package.json'), 'utf8'));
							Expect(tmpDocument.Files.map((pFile) => pFile.Path)).to.deep.equal(tmpPlanned);
							// The gate checked exactly what was packaged, and never saw a stray.
							Expect(tmpSanitised).to.deep.equal(tmpPlanned);
							Expect(pResult.Sanitise.Passed).to.equal(true);
							// The strays are left alone on disk; one warning names them.
							tmpStrays.forEach((pPath) => { Expect(libFS.existsSync(libPath.join(pResult.PackageDirectory, pPath)), pPath).to.equal(true); });
							let tmpStrayWarnings = tmpWarnings.filter((pLine) => pLine.indexOf('.DS_Store') >= 0);
							Expect(tmpStrayWarnings.length, tmpWarnings.join('\n')).to.equal(1);
							tmpStrays.forEach((pPath) => { Expect(tmpStrayWarnings[0]).to.contain(`"${pPath}"`); });
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						tmpStrayLadder.PackageWriter.verifyPackage(pResult.PackageDirectory, pResult.PackageVersion, (pVerifyError, pReport) =>
							{
								try
								{
									Expect(pVerifyError).to.equal(null);
									Expect(pReport.Intact, pReport.Problems.join('; ')).to.equal(true);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								let tmpServer = new libFakeServer({ Root: libFS.mkdtempSync(libPath.join(tmpWorkDirectory, 'strays-server-')), Token: tmpToken });
								tmpServer.start(() =>
									{
										tmpStrayLadder.push(pResult.PackageDirectory, { Server: tmpServer.BaseURL, Token: tmpToken }, (pPushError, pPushed) =>
											{
												tmpServer.stop(() =>
													{
														try
														{
															Expect(pPushError).to.equal(null);
															Expect(pPushed.State).to.equal('ready');
															Expect(pPushed.UploadedFiles).to.equal(tmpPlanned.length);
															let tmpLive = tmpServer.liveDirectory(pPushed.AssetGUID, pResult.PackageVersion);
															Expect(walkFiles(tmpLive, '').filter((pPath) => pPath !== 'package.json' && pPath !== '.ready')).to.deep.equal(tmpPlanned);
														}
														catch (pAssertError)
														{
															return fDone(pAssertError);
														}
														return fDone();
													});
											});
									});
							});
					});
			}
		);

		test
		(
			'a video stream that ends before the poster\'s seek point: no poster.jpg, Poster null, and the package still pushes',
			(fDone) =>
			{
				// 1 s of video in a 30 s container: the poster seeks to 3 s, where there is no frame, so ffmpeg
				// exits 0 having written nothing.  The package is complete without a poster.
				let tmpSource = libPath.join(tmpWorkDirectory, 'short-video-long-audio.mp4');
				ffmpegSync(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=30',
					'-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', tmpSource]);
				let tmpToken = 'test-token-0123456789abcdef';
				encodeAndCheck(tmpSource, {}, (pError, pResult, pPackage) =>
					{
						if (pError)
						{
							return fDone(pError);
						}
						let tmpExpected;
						try
						{
							tmpExpected = libPackageWriter.plannedPackageFiles(pResult.Plan).filter((pPath) => pPath !== 'poster.jpg');
							Expect(pPackage.Poster).to.equal(null);
							Expect(pPackage.Download).to.equal('download.mp4');
							Expect(pPackage.Files.map((pFile) => pFile.Path)).to.deep.equal(tmpExpected);
							Expect(libFS.existsSync(libPath.join(pResult.PackageDirectory, 'poster.jpg'))).to.equal(false);
							Expect(pResult.Sanitise.Checked).to.not.include('poster.jpg');
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						let libFakeServer = require('./support/Fake-Media-Ingest-Server.js');
						let tmpServer = new libFakeServer({ Root: libFS.mkdtempSync(libPath.join(tmpWorkDirectory, 'no-poster-server-')), Token: tmpToken });
						tmpServer.start(() =>
							{
								tmpLadder.push(pResult.PackageDirectory, { Server: tmpServer.BaseURL, Token: tmpToken }, (pPushError, pPushed) =>
									{
										tmpServer.stop(() =>
											{
												try
												{
													Expect(pPushError).to.equal(null);
													Expect(pPushed.State).to.equal('ready');
													Expect(pPushed.UploadedFiles).to.equal(tmpExpected.length);
													let tmpLive = tmpServer.liveDirectory(pPushed.AssetGUID, pResult.PackageVersion);
													Expect(walkFiles(tmpLive, '').filter((pPath) => pPath !== 'package.json' && pPath !== '.ready')).to.deep.equal(tmpExpected);
												}
												catch (pAssertError)
												{
													return fDone(pAssertError);
												}
												return fDone();
											});
									});
							});
					});
			}
		);

		test
		(
			'cancel: SIGTERM stops ffmpeg, the error is marked Cancelled, the partial is removed',
			(fDone) =>
			{
				let tmpLong = libPath.join(tmpWorkDirectory, 'long.mp4');
				ffmpegSync(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', tmpLong]);
				let tmpOutput = libPath.join(tmpWorkDirectory, 'cancelled');
				let tmpProgressSeen = false;
				let tmpHandle = tmpLadder.encode(tmpLong,
					{
						OutputDirectory: tmpOutput,
						Preset: 'slow',
						onProgress: (pEvent) =>
						{
							if (pEvent.Phase === 'encode' && !tmpProgressSeen)
							{
								tmpProgressSeen = true;
								tmpHandle.cancel();
							}
						}
					},
					(pError) =>
					{
						try
						{
							Expect(tmpProgressSeen).to.equal(true);
							Expect(pError).to.be.an('error');
							Expect(pError.Cancelled).to.equal(true);
							Expect(libFS.readdirSync(tmpOutput)).to.deep.equal([]);
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						return fDone();
					});
			}
		);

		test
		(
			'a cancelled encode never reports 100%: nothing reaches onProgress after the cancel, though ffmpeg flushes progress=end',
			(fDone) =>
			{
				// A stand-in ffmpeg: answers -version and the preflight's listings, reports progress, and (as ffmpeg
				// does) answers SIGTERM by flushing a final block marked progress=end before it exits.
				let tmpStub = libPath.join(tmpWorkDirectory, 'flushing-ffmpeg.js');
				let tmpFlushed = libPath.join(tmpWorkDirectory, 'flushing-ffmpeg.flushed');
				libStandInFFmpeg.writeStandInFFmpeg(tmpStub,
					{
						VersionLine: 'ffmpeg version stub-flush-for-tests',
						Body:
						[
							'let tmpUs = 0;',
							"let tmpTimer = setInterval(() => { tmpUs += 100000; process.stdout.write('out_time_us=' + tmpUs + '\\nprogress=continue\\n'); }, 50);",
							`process.on('SIGTERM', () => { clearInterval(tmpTimer); require('fs').writeFileSync(${JSON.stringify(tmpFlushed)}, 'end'); process.stdout.write('out_time_us=' + tmpUs + '\\nprogress=end\\n', () => process.exit(255)); });`
						]
					});
				let tmpOutput = libPath.join(tmpWorkDirectory, 'cancel-flush');
				let tmpState = { Cancelled: false, Before: [], After: [] };
				let tmpHandle = new libRetoldMediaLadder({ FFmpegPath: tmpStub }).encode(tmpSources.NoAudio,
					{
						OutputDirectory: tmpOutput,
						onProgress: (pEvent) =>
						{
							if (tmpState.Cancelled)
							{
								tmpState.After.push(pEvent);
								return;
							}
							tmpState.Before.push(pEvent);
							if (pEvent.Phase === 'encode' && pEvent.Percent > 0)
							{
								tmpState.Cancelled = true;
								tmpHandle.cancel();
							}
						}
					},
					(pError) =>
					{
						try
						{
							Expect(pError).to.be.an('error');
							Expect(pError.Cancelled).to.equal(true);
							Expect(tmpState.Cancelled).to.equal(true);
							Expect(libFS.existsSync(tmpFlushed), 'the stand-in flushed its progress=end block').to.equal(true);
							Expect(tmpState.After, JSON.stringify(tmpState.After)).to.deep.equal([]);
							Expect(tmpState.Before.filter((pEvent) => pEvent.Phase === 'encode' && pEvent.Percent >= 100)).to.deep.equal([]);
							Expect(libFS.readdirSync(tmpOutput)).to.deep.equal([]);
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						return fDone();
					});
			}
		);

		test
		(
			'the ladder passes nothing on after a cancel, even from a step that keeps reporting',
			(fDone) =>
			{
				// A runner that is slow to stop: after cancel() it still reports 100% before it calls back
				// cancelled.  The ladder, not only EncodeRunner, keeps that from reaching onProgress.
				let tmpGuardLadder = new libRetoldMediaLadder({});
				tmpGuardLadder.EncodeRunner.run = (pArguments, pRunOptions, fCallback) =>
				{
					setImmediate(() => pRunOptions.onProgress(10));
					return (
						{
							Process: null,
							cancel: () =>
							{
								setImmediate(() =>
									{
										pRunOptions.onProgress(100);
										fCallback(libTools.cancelledError());
									});
								return true;
							}
						});
				};
				let tmpOutput = libPath.join(tmpWorkDirectory, 'cancel-guard');
				let tmpState = { Cancelled: false, Before: [], After: [] };
				let tmpHandle = tmpGuardLadder.encode(tmpSources.NoAudio,
					{
						OutputDirectory: tmpOutput,
						onProgress: (pEvent) =>
						{
							if (tmpState.Cancelled)
							{
								tmpState.After.push(pEvent);
								return;
							}
							tmpState.Before.push(pEvent);
							if (pEvent.Phase === 'encode' && pEvent.Percent > 0)
							{
								tmpState.Cancelled = true;
								tmpHandle.cancel();
							}
						}
					},
					(pError) =>
					{
						try
						{
							Expect(pError).to.be.an('error');
							Expect(pError.Cancelled).to.equal(true);
							Expect(tmpState.Cancelled).to.equal(true);
							Expect(tmpState.Before[tmpState.Before.length - 1]).to.deep.equal({ Phase: 'encode', Percent: 10, Message: '' });
							Expect(tmpState.After, JSON.stringify(tmpState.After)).to.deep.equal([]);
							Expect(libFS.readdirSync(tmpOutput)).to.deep.equal([]);
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						return fDone();
					});
			}
		);

		test
		(
			'EncodeRunner reports a rising percentage and cancels a running ffmpeg',
			(fDone) =>
			{
				let tmpPercents = [];
				let tmpHandle = tmpLadder.EncodeRunner.run(
					['-hide_banner', '-nostdin', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=30', '-f', 'null', '-'],
					{
						DurationSeconds: 30,
						// ffmpeg 7.1 under -re only notices SIGTERM at end of input, so keep the SIGKILL grace short here.
						KillTimeoutMS: 500,
						onProgress: (pPercent) =>
						{
							tmpPercents.push(pPercent);
							if (tmpPercents.length === 3)
							{
								tmpHandle.cancel();
							}
						}
					},
					(pError) =>
					{
						try
						{
							Expect(pError.Cancelled).to.equal(true);
							Expect(tmpPercents.length).to.be.at.least(3);
							Expect(tmpPercents[2]).to.be.above(tmpPercents[0]);
							Expect(tmpPercents[2]).to.be.below(100);
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						return fDone();
					});
			}
		);

		test
		(
			'EncodeRunner escalates to SIGKILL when SIGTERM is ignored',
			(fDone) =>
			{
				// A stand-in "ffmpeg" that reports progress and ignores SIGTERM.
				let tmpStubbornPath = libPath.join(tmpWorkDirectory, 'stubborn-ffmpeg.js');
				libFS.writeFileSync(tmpStubbornPath,
					`#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nlet tmpUs = 0;\nsetInterval(() => { tmpUs += 100000; process.stdout.write('out_time_us=' + tmpUs + '\\nprogress=continue\\n'); }, 50);\n`);
				libFS.chmodSync(tmpStubbornPath, 0o755);
				let tmpRunner = new libRetoldMediaLadder.EncodeRunner({ FFmpegPath: tmpStubbornPath });
				let tmpSignalled = false;
				let tmpHandle = tmpRunner.run([], { DurationSeconds: 10, KillTimeoutMS: 300,
					onProgress: () =>
					{
						if (!tmpSignalled)
						{
							tmpSignalled = true;
							tmpHandle.cancel();
						}
					} },
					(pError) =>
					{
						try
						{
							Expect(pError.Cancelled).to.equal(true);
							Expect(pError.Signal).to.equal('SIGKILL');
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						return fDone();
					});
			}
		);

		test
		(
			'cancel while hashing the source stops the hash (a slow disk never finishes on its own)',
			function (fDone)
			{
				this.timeout(15000);
				// Stand in for a multi-GB source on a slow USB disk: the hash only ends when cancelled.
				let tmpRealSha256File = libTools.sha256File;
				let tmpHashCancelled = false;
				libTools.sha256File = (pPath, fCallback) =>
				{
					return (
						{
							cancel: () =>
							{
								tmpHashCancelled = true;
								setImmediate(() => fCallback(libTools.cancelledError('Hashing cancelled.')));
								return true;
							}
						});
				};
				let tmpOutput = libPath.join(tmpWorkDirectory, 'cancel-hash');
				let tmpHandle = tmpLadder.encode(tmpSources.NoAudio,
					{
						OutputDirectory: tmpOutput,
						onProgress: (pEvent) =>
						{
							if (pEvent.Phase === 'hash')
							{
								setTimeout(() => tmpHandle.cancel(), 50);
							}
						}
					},
					(pError) =>
					{
						libTools.sha256File = tmpRealSha256File;
						try
						{
							Expect(pError).to.be.an('error');
							Expect(pError.Cancelled).to.equal(true);
							Expect(tmpHashCancelled).to.equal(true);
							Expect(libFS.existsSync(tmpOutput) ? libFS.readdirSync(tmpOutput) : []).to.deep.equal([]);
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						return fDone();
					});
			}
		);

		test
		(
			'abort() during the poster stops it at once and removes the partial package',
			(fDone) =>
			{
				let tmpLadderWithSlowPoster = new libRetoldMediaLadder({});
				// A poster step that ignores SIGTERM: only abort's SIGKILL ends it quickly.
				let tmpStub = libPath.join(tmpWorkDirectory, 'hung-poster-ffmpeg.js');
				libFS.writeFileSync(tmpStub, `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => {}, 30000);\n`);
				libFS.chmodSync(tmpStub, 0o755);
				tmpLadderWithSlowPoster.PosterBuilder.binaries.FFmpeg = tmpStub;
				let tmpOutput = libPath.join(tmpWorkDirectory, 'abort-poster');
				let tmpState = { Scheduled: false, AbortedAt: 0, Results: [] };
				let tmpHandle = tmpLadderWithSlowPoster.encode(tmpSources.NoAudio, Object.assign(
					{
						OutputDirectory: tmpOutput,
						onProgress: (pEvent) =>
						{
							if (pEvent.Phase === 'poster' && !tmpState.Scheduled)
							{
								tmpState.Scheduled = true;
								setTimeout(() =>
									{
										// cancel() alone would wait out the 2 s SIGTERM grace; abort() does not.
										tmpState.Results.push(tmpHandle.cancel());
										tmpState.AbortedAt = Date.now();
										tmpState.Results.push(tmpHandle.abort());
										tmpState.Results.push(tmpHandle.abort());
									}, 100);
							}
						}
					}, FAST),
					(pError) =>
					{
						let tmpCalledBackAt = Date.now();
						// abort() calls back synchronously, from inside the timer above.
						setImmediate(() =>
							{
								try
								{
									Expect(pError).to.be.an('error');
									Expect(pError.Cancelled).to.equal(true);
									Expect(tmpState.Results).to.deep.equal([true, true, false]);
									Expect(tmpCalledBackAt - tmpState.AbortedAt).to.be.below(100);
									Expect(libFS.readdirSync(tmpOutput)).to.deep.equal([]);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								return fDone();
							});
					});
			}
		);

		test
		(
			'the CLI: a first interrupt cancels; a second stops at once (SIGKILL), cleans up and exits 130',
			function (fDone)
			{
				this.timeout(20000);
				// A stand-in ffmpeg: answers -version and the preflight's listings, then "encodes" forever and
				// ignores SIGTERM / SIGINT.
				let tmpStub = libPath.join(tmpWorkDirectory, 'stubborn-cli-ffmpeg.js');
				let tmpPidFile = libPath.join(tmpWorkDirectory, 'stubborn-cli-ffmpeg.pid');
				libStandInFFmpeg.writeStandInFFmpeg(tmpStub,
					{
						VersionLine: 'ffmpeg version stub-for-tests',
						Body:
						[
							`require('fs').writeFileSync(${JSON.stringify(tmpPidFile)}, String(process.pid));`,
							"process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});",
							"let tmpUs = 0; setInterval(() => { tmpUs += 100000; process.stdout.write('out_time_us=' + tmpUs + '\\nprogress=continue\\n'); }, 50);"
						]
					});
				let tmpOutput = libPath.join(tmpWorkDirectory, 'cli-interrupt');
				let tmpBin = libPath.join(__dirname, '..', 'bin', 'media-ladder.js');
				let tmpChild = libChildProcess.spawn(process.execPath, [tmpBin, 'encode', tmpSources.NoAudio, '--out', tmpOutput, '--no-hwaccel'],
					{ env: Object.assign({}, process.env, { RETOLD_MEDIA_LADDER_FFMPEG: tmpStub }), stdio: ['ignore', 'pipe', 'pipe'] });
				let tmpStderr = '';
				let tmpSignals = 0;
				let tmpSecondAt = 0;
				tmpChild.stderr.on('data', (pChunk) =>
					{
						tmpStderr += pChunk.toString('utf8');
						if (tmpSignals === 0 && /encode [1-9]\d*%/.test(tmpStderr))
						{
							tmpSignals = 1;
							tmpChild.kill('SIGINT');
						}
						else if (tmpSignals === 1 && tmpStderr.indexOf('cancelling') >= 0)
						{
							tmpSignals = 2;
							setTimeout(() =>
								{
									tmpSecondAt = Date.now();
									tmpChild.kill('SIGINT');
								}, 200);
						}
					});
				tmpChild.on('close', (pCode) =>
					{
						let tmpElapsed = Date.now() - tmpSecondAt;
						let tmpStubPid = libFS.existsSync(tmpPidFile) ? Number(libFS.readFileSync(tmpPidFile, 'utf8')) : 0;
						let fStubGone = () =>
						{
							try
							{
								process.kill(tmpStubPid, 0);
								return false;
							}
							catch (pError)
							{
								return pError.code === 'ESRCH';
							}
						};
						let tmpDeadline = Date.now() + 2000;
						let fCheck = () =>
						{
							if (tmpStubPid > 0 && !fStubGone() && Date.now() < tmpDeadline)
							{
								return setTimeout(fCheck, 50);
							}
							try
							{
								Expect(tmpSignals, tmpStderr).to.equal(2);
								Expect(pCode, tmpStderr).to.equal(130);
								// Without the second-interrupt path this waits out the 5 s SIGTERM grace.
								Expect(tmpElapsed).to.be.below(2500);
								Expect(tmpStderr).to.contain('stopping now');
								Expect(tmpStubPid).to.be.above(0);
								Expect(fStubGone(), 'the stand-in ffmpeg was killed').to.equal(true);
								Expect(libFS.readdirSync(tmpOutput)).to.deep.equal([]);
							}
							catch (pAssertError)
							{
								return fDone(pAssertError);
							}
							return fDone();
						};
						fCheck();
					});
			}
		);

		test
		(
			'the CLI encodes, prints the package path and exits 0; bad usage exits 2',
			(fDone) =>
			{
				let tmpBin = libPath.join(__dirname, '..', 'bin', 'media-ladder.js');
				let tmpOutput = libPath.join(tmpWorkDirectory, 'cli');
				libChildProcess.execFile(process.execPath, [tmpBin, 'encode', tmpSources.NoAudio, '--out', tmpOutput, '--preset', 'ultrafast', '--no-hwaccel', '--segment-seconds', '2'], (pError, pStdout, pStderr) =>
					{
						try
						{
							Expect(pError).to.equal(null);
							let tmpPath = pStdout.trim();
							Expect(libPath.dirname(tmpPath)).to.equal(tmpOutput);
							let tmpPackage = JSON.parse(libFS.readFileSync(libPath.join(tmpPath, 'package.json'), 'utf8'));
							Expect(tmpPackage.SegmentSeconds).to.equal(2);
							Expect(pStderr).to.contain('encode');
						}
						catch (pAssertError)
						{
							return fDone(pAssertError);
						}
						libChildProcess.execFile(process.execPath, [tmpBin, 'encode', tmpSources.NoAudio], (pUsageError) =>
							{
								try
								{
									Expect(pUsageError.code).to.equal(2);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								libChildProcess.execFile(process.execPath, [tmpBin, 'probe', libPath.join(tmpWorkDirectory, 'missing.mp4')], (pMissingError) =>
									{
										try
										{
											Expect(pMissingError.code).to.equal(1);
										}
										catch (pAssertError)
										{
											return fDone(pAssertError);
										}
										return fDone();
									});
							});
					});
			}
		);
	}
);
