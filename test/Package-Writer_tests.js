/**
* Unit tests for the pure parts of PackageWriter, Sanitiser, EncodeRunner's
* progress parsing and the shared tools; plus the package lifecycle pieces
* that need only a temp directory and a stand-in process (no ffmpeg): the
* `<PV>.lock` claim, package verification, the master rebuild for sub-0.5 s
* clips, the cancel handles (and no progress after a cancel), and the plan's
* file list (a stray .DS_Store or Thumbs.db is never packaged).  The ffmpeg
* preflight runs against a stand-in ffmpeg (test/support/Stand-In-FFmpeg.js):
* a build without libx264 / zscale / VideoToolbox is refused before any
* hashing, plan() only warns, the listings are kept per path, and the
* PackageVersion stays 1.0.0's.  The Windows commit (renames retried while
* antivirus holds a file, the damaged package moved back when the swap
* fails) runs on any OS through the runner's platform and fileSystem.
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

const libTools = require('../source/Media-Ladder-Tools.js');
const libMediaProbe = require('../source/Media-Probe.js');
const libLadderPlanner = require('../source/Ladder-Planner.js');
const libPackageWriter = require('../source/Package-Writer.js');
const libSanitiser = require('../source/Sanitiser.js');
const libEncodeRunner = require('../source/Encode-Runner.js');
const libRetoldMediaLadder = require('../source/Retold-Media-Ladder.js');
const libStandInFFmpeg = require('./support/Stand-In-FFmpeg.js');

const MASTER_FROM_FFMPEG =
[
	'#EXTM3U',
	'#EXT-X-VERSION:7',
	'#EXT-X-STREAM-INF:BANDWIDTH=6234000,AVERAGE-BANDWIDTH=5100000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
	'v0/index.m3u8',
	'',
	'#EXT-X-STREAM-INF:BANDWIDTH=3300000,AVERAGE-BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
	'v1/index.m3u8',
	'',
	'#EXT-X-STREAM-INF:BANDWIDTH=2200000,AVERAGE-BANDWIDTH=1900000,RESOLUTION=960x540,CODECS="avc1.64001f,mp4a.40.2"',
	'v2/index.m3u8',
	'',
	'#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"',
	'v3/index.m3u8',
	''
].join('\n');

const RUNG_PLAYLIST =
[
	'#EXTM3U',
	'#EXT-X-VERSION:7',
	'#EXT-X-TARGETDURATION:6',
	'#EXT-X-MEDIA-SEQUENCE:0',
	'#EXT-X-PLAYLIST-TYPE:VOD',
	'#EXT-X-INDEPENDENT-SEGMENTS',
	'#EXT-X-MAP:URI="media.mp4",BYTERANGE="1353@0"',
	'#EXTINF:6.000000,',
	'#EXT-X-BYTERANGE:1557339@1353',
	'media.mp4',
	'#EXTINF:2.500000,',
	'#EXT-X-BYTERANGE:600000@1558692',
	'media.mp4',
	'#EXT-X-ENDLIST',
	''
].join('\n');

const QUIET_LOG = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * A minimal fMP4 init section: enough boxes for codecsFromInit (an avcC with
 * profile 0x64, compatibility 0x00, level 0x28, optionally an mp4a entry).
 */
function fakeInit(pWithAudio)
{
	let tmpParts = [Buffer.from([0, 0, 0, 8]), Buffer.from('moov', 'latin1'), Buffer.from([0, 0, 0, 16]), Buffer.from('avcC', 'latin1'), Buffer.from([1, 0x64, 0x00, 0x28, 0xFF, 0xE1, 0, 0])];
	if (pWithAudio)
	{
		tmpParts.push(Buffer.from([0, 0, 0, 8]), Buffer.from('mp4a', 'latin1'));
	}
	return Buffer.concat(tmpParts);
}

function sha256Of(pBuffer)
{
	return libCrypto.createHash('sha256').update(pBuffer).digest('hex');
}

/** The pid of a process that has already exited. */
function deadPid()
{
	return libChildProcess.spawnSync(process.execPath, ['-e', '']).pid;
}

function hlgPlan()
{
	return libLadderPlanner.planLadder(libMediaProbe.summarize(require(libPath.join(__dirname, 'fixtures', 'dji-4k-hlg-100fps-audio.json'))), {});
}

suite
(
	'Retold Media Ladder -- package, sanitiser and tools (pure)',
	() =>
	{
		suite
		(
			'PackageWriter',
			() =>
			{
				test
				(
					'parses ffmpeg\'s master playlist variants and attributes',
					() =>
					{
						let tmpParsed = libPackageWriter.parseMasterPlaylist(MASTER_FROM_FFMPEG);
						Expect(tmpParsed.Header).to.deep.equal(['#EXTM3U', '#EXT-X-VERSION:7']);
						Expect(tmpParsed.Variants.length).to.equal(4);
						Expect(tmpParsed.Variants[0].URI).to.equal('v0/index.m3u8');
						Expect(tmpParsed.Variants[0].Bandwidth).to.equal(6234000);
						Expect(tmpParsed.Variants[0].Codecs).to.equal('avc1.640028,mp4a.40.2');
						Expect(tmpParsed.Variants[0].Width).to.equal(1920);
						Expect(tmpParsed.Variants[3].Height).to.equal(360);
					}
				);
				test
				(
					'reorders the master so the 540p variant is first, the rest in order',
					() =>
					{
						let tmpReordered = libPackageWriter.reorderMaster(MASTER_FROM_FFMPEG, 'v2/index.m3u8');
						let tmpParsed = libPackageWriter.parseMasterPlaylist(tmpReordered);
						Expect(tmpParsed.Variants.map((pVariant) => pVariant.URI)).to.deep.equal(['v2/index.m3u8', 'v0/index.m3u8', 'v1/index.m3u8', 'v3/index.m3u8']);
						Expect(tmpReordered.indexOf('#EXTM3U')).to.equal(0);
						Expect(tmpParsed.Variants[0].InfLine).to.contain('RESOLUTION=960x540');
						Expect(() => libPackageWriter.reorderMaster(MASTER_FROM_FFMPEG, 'v9/index.m3u8')).to.throw('no variant');
					}
				);
				test
				(
					'parses a single_file fMP4 rung playlist',
					() =>
					{
						let tmpParsed = libPackageWriter.parseMediaPlaylist(RUNG_PLAYLIST);
						Expect(tmpParsed.Map).to.deep.equal({ URI: 'media.mp4', ByteRange: '1353@0' });
						Expect(tmpParsed.Segments.length).to.equal(2);
						Expect(tmpParsed.Segments[1].ByteRange).to.equal('600000@1558692');
						Expect(tmpParsed.DurationSeconds).to.equal(8.5);
						Expect(tmpParsed.PlaylistType).to.equal('VOD');
						Expect(tmpParsed.IndependentSegments).to.equal(true);
						Expect(tmpParsed.EndList).to.equal(true);
					}
				);
				test
				(
					'PackageVersion is 8 hex, deterministic, and keyed on plan, ffmpeg and source',
					() =>
					{
						let tmpPlan = hlgPlan();
						let tmpVersion = libPackageWriter.computePackageVersion(tmpPlan, 'ffmpeg version 7.1', 'aa');
						Expect(tmpVersion).to.match(/^[0-9a-f]{8}$/);
						Expect(libPackageWriter.computePackageVersion(hlgPlan(), 'ffmpeg version 7.1', 'aa')).to.equal(tmpVersion);
						Expect(libPackageWriter.computePackageVersion(tmpPlan, 'ffmpeg version 7.2', 'aa')).to.not.equal(tmpVersion);
						Expect(libPackageWriter.computePackageVersion(tmpPlan, 'ffmpeg version 7.1', 'ab')).to.not.equal(tmpVersion);

						// Key order and warnings do not matter; a real plan change does.
						let tmpReordered = JSON.parse(JSON.stringify(tmpPlan));
						tmpReordered.Warnings = ['a different warning'];
						let tmpKeys = Object.keys(tmpReordered).reverse();
						let tmpShuffled = {};
						tmpKeys.forEach((pKey) => { tmpShuffled[pKey] = tmpReordered[pKey]; });
						Expect(libPackageWriter.computePackageVersion(tmpShuffled, 'ffmpeg version 7.1', 'aa')).to.equal(tmpVersion);
						tmpShuffled.Rungs[0].MaxRate = 7800;
						Expect(libPackageWriter.computePackageVersion(tmpShuffled, 'ffmpeg version 7.1', 'aa')).to.not.equal(tmpVersion);
					}
				);
				test
				(
					'a LUT is fingerprinted by digest, not path',
					() =>
					{
						let tmpSummary = libMediaProbe.summarize(require(libPath.join(__dirname, 'fixtures', 'dlog-10bit-sdr.json')));
						let tmpOne = libLadderPlanner.planLadder(tmpSummary, { Lut: '/a/dji.cube', LutSha256: 'ff' });
						let tmpMoved = libLadderPlanner.planLadder(tmpSummary, { Lut: '/b/renamed.cube', LutSha256: 'ff' });
						let tmpOther = libLadderPlanner.planLadder(tmpSummary, { Lut: '/a/dji.cube', LutSha256: 'ee' });
						let tmpVersion = libPackageWriter.computePackageVersion(tmpOne, 'v', 's');
						Expect(libPackageWriter.computePackageVersion(tmpMoved, 'v', 's')).to.equal(tmpVersion);
						Expect(libPackageWriter.computePackageVersion(tmpOther, 'v', 's')).to.not.equal(tmpVersion);
					}
				);
				test
				(
					'buildPackageDocument follows the contract shape',
					() =>
					{
						let tmpPlan = hlgPlan();
						let tmpFiles = ['download.mp4', 'master.m3u8', 'poster.jpg', 'v0/index.m3u8', 'v0/media.mp4', 'v1/index.m3u8', 'v1/media.mp4', 'v2/index.m3u8', 'v2/media.mp4', 'v3/index.m3u8', 'v3/media.mp4']
							.map((pPath, pIndex) => ({ Path: pPath, Bytes: 100 + pIndex, Sha256: libTools.sha256Hex(pPath) }));
						let tmpDocument = libPackageWriter.buildPackageDocument(
							{
								PackageVersion: '1a2b3c4d',
								Plan: tmpPlan,
								Variants: libPackageWriter.parseMasterPlaylist(MASTER_FROM_FFMPEG).Variants,
								DurationSeconds: 12.5,
								Files: tmpFiles,
								HasPoster: true,
								HasDownload: true
							});
						Expect(Object.keys(tmpDocument)).to.deep.equal(['Version', 'Kind', 'PackageVersion', 'DurationMS', 'Width', 'Height', 'SegmentSeconds', 'HasAudio', 'Manifest', 'Poster', 'Download', 'Renditions', 'Audio', 'Files']);
						Expect(tmpDocument.Version).to.equal(1);
						Expect(tmpDocument.Kind).to.equal('video');
						Expect(tmpDocument.DurationMS).to.equal(12500);
						Expect(tmpDocument.Width).to.equal(1920);
						Expect(tmpDocument.Height).to.equal(1080);
						Expect(tmpDocument.HasAudio).to.equal(true);
						Expect(tmpDocument.Poster).to.equal('poster.jpg');
						Expect(tmpDocument.Download).to.equal('download.mp4');
						Expect(tmpDocument.Audio).to.equal(null);
						Expect(tmpDocument.Renditions.length).to.equal(4);
						let tmpTop = tmpDocument.Renditions[0];
						Expect(Object.keys(tmpTop)).to.deep.equal(['Name', 'ShortSide', 'Width', 'Height', 'FrameRate', 'Bandwidth', 'Codecs', 'Playlist', 'File', 'Bytes', 'Sha256']);
						Expect(tmpTop.Name).to.equal('1080p');
						Expect(tmpTop.FrameRate).to.equal(50);
						Expect(tmpTop.Bandwidth).to.equal(6234000);
						Expect(tmpTop.Codecs).to.equal('avc1.640028,mp4a.40.2');
						Expect(tmpTop.Bytes).to.equal(104);
						Expect(tmpTop.Sha256).to.equal(libTools.sha256Hex('v0/media.mp4'));
						Expect(tmpDocument.Renditions[3].Playlist).to.equal('v3/index.m3u8');
						Expect(tmpDocument.Files.length).to.equal(11);

						let tmpNoExtras = libPackageWriter.buildPackageDocument(
							{
								PackageVersion: '1a2b3c4d', Plan: tmpPlan,
								Variants: libPackageWriter.parseMasterPlaylist(MASTER_FROM_FFMPEG).Variants,
								DurationSeconds: 1, Files: tmpFiles, HasPoster: false, HasDownload: false
							});
						Expect(tmpNoExtras.Poster).to.equal(null);
						Expect(tmpNoExtras.Download).to.equal(null);
					}
				);
			}
		);

		suite
		(
			'Sanitiser',
			() =>
			{
				test
				(
					'a clean ffmpeg fMP4 probe passes',
					() =>
					{
						let tmpRaw =
						{
							format: { tags: { major_brand: 'iso5', minor_version: '512', compatible_brands: 'iso5iso6mp41', encoder: 'Lavf61.7.100' } },
							streams:
							[
								{ index: 0, codec_type: 'video', tags: { language: 'und', handler_name: 'VideoHandler', vendor_id: '[0][0][0][0]', encoder: 'Lavc libx264' }, disposition: { attached_pic: 0 } },
								{ index: 1, codec_type: 'audio', tags: { language: 'und', handler_name: 'SoundHandler', vendor_id: '[0][0][0][0]' }, disposition: { attached_pic: 0 } }
							],
							chapters: []
						};
						Expect(libSanitiser.inspectProbe(tmpRaw, 'v0/media.mp4')).to.deep.equal([]);
					}
				);
				test
				(
					'location, creation_time, com.apple.quicktime.*, device tags and data streams all fail',
					() =>
					{
						let tmpRaw = require(libPath.join(__dirname, 'fixtures', 'dji-4k-hlg-100fps-audio.json'));
						let tmpViolations = libSanitiser.inspectProbe(tmpRaw, 'in.mp4');
						let tmpReasons = tmpViolations.map((pViolation) => `${pViolation.Key}:${pViolation.Reason}`);
						Expect(tmpReasons).to.include('location:location tag');
						Expect(tmpReasons).to.include('creation_time:capture-date tag');
						Expect(tmpReasons).to.include('com.apple.quicktime.make:com.apple.quicktime.* tag');
						Expect(tmpReasons).to.include('encoder:encoder tag is not ffmpeg\'s own');
						Expect(tmpReasons).to.include('codec_type:data stream');
						Expect(tmpReasons).to.include('handler_name:non-generic handler name');
						Expect(libSanitiser.describeViolations(tmpViolations)).to.contain('in.mp4 format: location=');
					}
				);
				test
				(
					'unexpected tags, chapters, subtitles and attached pictures fail',
					() =>
					{
						let tmpRaw =
						{
							format: { tags: { title: 'DJI_0001' } },
							streams:
							[
								{ index: 0, codec_type: 'video', disposition: { attached_pic: 1 } },
								{ index: 1, codec_type: 'subtitle' }
							],
							chapters: [{ id: 0 }]
						};
						let tmpReasons = libSanitiser.inspectProbe(tmpRaw, 'x').map((pViolation) => pViolation.Reason);
						Expect(tmpReasons).to.include('unexpected metadata tag');
						Expect(tmpReasons).to.include('attached picture');
						Expect(tmpReasons).to.include('subtitle stream');
						Expect(tmpReasons).to.include('chapters present');
					}
				);
				test
				(
					'JPEG: JFIF passes; EXIF (APP1) and comments fail',
					() =>
					{
						let tmpJFIF = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDA, 0x00, 0x02]);
						Expect(libSanitiser.inspectJpeg(tmpJFIF, 'poster.jpg')).to.deep.equal([]);

						let tmpExif = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x0C]), Buffer.from('Exif\u0000\u0000MM\u0000*', 'latin1'), Buffer.from([0xFF, 0xFE, 0x00, 0x05, 0x61, 0x62, 0x63, 0xFF, 0xDA, 0x00, 0x02])]);
						let tmpReasons = libSanitiser.inspectJpeg(tmpExif, 'poster.jpg').map((pViolation) => pViolation.Key);
						Expect(tmpReasons).to.include('APP1');
						Expect(tmpReasons).to.include('COM');
						Expect(libSanitiser.inspectJpeg(Buffer.from('nope'), 'x')[0].Reason).to.equal('not a JPEG');
					}
				);
				test
				(
					'playlists may not carry date tags',
					() =>
					{
						Expect(libSanitiser.inspectPlaylist(RUNG_PLAYLIST, 'v0/index.m3u8')).to.deep.equal([]);
						Expect(libSanitiser.inspectPlaylist('#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-11-01T12:00:00Z\n', 'v0/index.m3u8').length).to.equal(1);
					}
				);
			}
		);

		suite
		(
			'EncodeRunner progress and shared tools',
			() =>
			{
				test
				(
					'parses -progress blocks across chunk boundaries into a percentage',
					() =>
					{
						let tmpBlocks = [];
						let tmpBlock = {};
						let tmpCarry = libEncodeRunner.parseProgressChunk('', 'frame=10\nout_time_us=2500', (pBlock) => tmpBlocks.push(pBlock), tmpBlock);
						tmpCarry = libEncodeRunner.parseProgressChunk(tmpCarry, '000\nprogress=continue\nout_time_us=10000000\nprogress=end\n', (pBlock) => tmpBlocks.push(pBlock), tmpBlock);
						Expect(tmpCarry).to.equal('');
						Expect(tmpBlocks.length).to.equal(2);
						Expect(libEncodeRunner.progressSeconds(tmpBlocks[0])).to.equal(2.5);
						Expect(libEncodeRunner.progressPercent(2.5, 10)).to.equal(25);
						Expect(libEncodeRunner.progressPercent(12, 10)).to.equal(100);
						Expect(libEncodeRunner.progressPercent(1, 0)).to.equal(0);
						Expect(tmpBlocks[1].progress).to.equal('end');
					}
				);
				test
				(
					'stable stringify sorts keys at every depth',
					() =>
					{
						Expect(libTools.stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).to.equal('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
						Expect(libTools.stableStringify({ a: undefined, b: 'x' })).to.equal('{"b":"x"}');
					}
				);
				test
				(
					'rationals parse, reduce and reject junk',
					() =>
					{
						Expect(libTools.parseRational('30000/1001')).to.deep.include({ Num: 30000, Den: 1001 });
						Expect(libTools.parseRational('100/2')).to.deep.include({ Num: 50, Den: 1 });
						Expect(libTools.parseRational('25')).to.deep.include({ Num: 25, Den: 1 });
						Expect(libTools.parseRational('0/0')).to.equal(null);
						Expect(libTools.parseRational(undefined)).to.equal(null);
						Expect(libTools.formatRational(libTools.makeRational(120, 2))).to.equal('60/1');
					}
				);
				test
				(
					'EncodeRunner package paths validate the PackageVersion',
					() =>
					{
						let tmpRunner = new libEncodeRunner({});
						let tmpPaths = tmpRunner.packagePaths('/out', '1a2b3c4d');
						Expect(tmpPaths.PackageDirectory).to.equal(libPath.resolve('/out/1a2b3c4d'));
						Expect(tmpPaths.PartialDirectory).to.equal(libPath.resolve('/out/1a2b3c4d.partial'));
						Expect(() => tmpRunner.packagePaths('/out', '../etc')).to.throw('Invalid PackageVersion');
					}
				);
				test
				(
					'the ladder registers with a Fable and shares it (and its options) with every child service',
					() =>
					{
						let libFable = require('fable');
						let libRetoldMediaLadder = require('../source/Retold-Media-Ladder.js');
						let tmpFable = new libFable();
						tmpFable.addAndInstantiateServiceType('RetoldMediaLadder', libRetoldMediaLadder);
						let tmpLadder = tmpFable.RetoldMediaLadder;
						Expect(tmpLadder.serviceType).to.equal('RetoldMediaLadder');
						['MediaProbe', 'LadderPlanner', 'EncodeRunner', 'PosterBuilder', 'DownloadBuilder', 'Sanitiser', 'PackageWriter'].forEach((pName) =>
							{
								Expect(tmpLadder[pName].serviceType).to.equal(pName);
								Expect(tmpLadder[pName].fable).to.equal(tmpFable);
								Expect(libRetoldMediaLadder[pName]).to.be.a('function');
							});

						let tmpStandalone = new libRetoldMediaLadder({ FFmpegPath: '/opt/ffmpeg/bin/ffmpeg' });
						Expect(tmpStandalone.fable).to.equal(false);
						Expect(tmpStandalone.EncodeRunner.binaries.FFmpeg).to.equal('/opt/ffmpeg/bin/ffmpeg');
						Expect(tmpStandalone.log.warn).to.be.a('function');
					}
				);
			}
		);

		suite
		(
			'Package lifecycle: master rebuild, verification, locks and cancel handles',
			() =>
			{
				let tmpScratch = false;

				suiteSetup
				(
					() =>
					{
						tmpScratch = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'retold-media-ladder-unit-'));
					}
				);

				suiteTeardown
				(
					() =>
					{
						if (tmpScratch)
						{
							libFS.rmSync(tmpScratch, { recursive: true, force: true });
						}
					}
				);

				test
				(
					'byte ranges, measured bandwidth (ffmpeg\'s bytes*8/seconds), RFC 6381 codecs from an init section',
					() =>
					{
						Expect(libPackageWriter.parseByteRange('1557339@1353')).to.deep.equal({ Length: 1557339, Offset: 1353 });
						Expect(libPackageWriter.parseByteRange('1353')).to.deep.equal({ Length: 1353, Offset: null });
						Expect(libPackageWriter.parseByteRange('x@1')).to.equal(null);

						let tmpMeasured = libPackageWriter.measureBandwidth(libPackageWriter.parseMediaPlaylist(RUNG_PLAYLIST));
						Expect(tmpMeasured.Bandwidth).to.equal(Math.floor((8 * 1557339) / 6));
						Expect(tmpMeasured.AverageBandwidth).to.equal(Math.floor((8 * (1557339 + 600000)) / 8.5));
						// A lone 0.3 s segment still counts (ffmpeg leaves it out and writes no variant at all).
						let tmpShort = libPackageWriter.parseMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="media.mp4",BYTERANGE="24@0"\n#EXTINF:0.300000,\n#EXT-X-BYTERANGE:180814@24\nmedia.mp4\n#EXT-X-ENDLIST\n');
						Expect(libPackageWriter.measureBandwidth(tmpShort).Bandwidth).to.equal(Math.floor((8 * 180814) / 0.3));

						Expect(libPackageWriter.codecsFromInit(fakeInit(true))).to.equal('avc1.640028,mp4a.40.2');
						Expect(libPackageWriter.codecsFromInit(fakeInit(false))).to.equal('avc1.640028');
						Expect(libPackageWriter.codecsFromInit(Buffer.from('no boxes here'))).to.equal(null);
					}
				);

				test
				(
					'a master with no variants (ffmpeg 7.1 on a clip of 0.5 s or less) is rebuilt from the rungs, then reordered',
					() =>
					{
						let tmpDirectory = libPath.join(tmpScratch, 'short-master');
						let tmpPlan = { FirstVariantIndex: 1, Rungs: [] };
						[['v0', 1280, 720, 180814], ['v1', 960, 540, 130254]].forEach((pRung) =>
							{
								libFS.mkdirSync(libPath.join(tmpDirectory, pRung[0]), { recursive: true });
								let tmpInit = fakeInit(true);
								libFS.writeFileSync(libPath.join(tmpDirectory, pRung[0], 'media.mp4'), Buffer.concat([tmpInit, Buffer.alloc(pRung[3])]));
								libFS.writeFileSync(libPath.join(tmpDirectory, pRung[0], 'index.m3u8'),
									['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:0', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS',
										`#EXT-X-MAP:URI="media.mp4",BYTERANGE="${tmpInit.length}@0"`, '#EXTINF:0.300000,', `#EXT-X-BYTERANGE:${pRung[3]}@${tmpInit.length}`, 'media.mp4', '#EXT-X-ENDLIST', ''].join('\n'));
								tmpPlan.Rungs.push({ Playlist: `${pRung[0]}/index.m3u8`, File: `${pRung[0]}/media.mp4`, Width: pRung[1], Height: pRung[2] });
							});
						// Exactly what ffmpeg 7.1 writes after "Bandwidth info not available".
						libFS.writeFileSync(libPath.join(tmpDirectory, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:7\n');

						let tmpWriter = new libPackageWriter({ Log: QUIET_LOG });
						let tmpVariants = tmpWriter.reorderMasterFile(tmpDirectory, tmpPlan);
						Expect(tmpVariants.map((pVariant) => pVariant.URI)).to.deep.equal(['v0/index.m3u8', 'v1/index.m3u8']);
						Expect(tmpVariants[0].Bandwidth).to.equal(Math.floor((8 * 180814) / 0.3));
						Expect(tmpVariants[0].Codecs).to.equal('avc1.640028,mp4a.40.2');
						Expect(tmpVariants[1].Width).to.equal(960);

						let tmpMaster = libPackageWriter.parseMasterPlaylist(libFS.readFileSync(libPath.join(tmpDirectory, 'master.m3u8'), 'utf8'));
						Expect(tmpMaster.Header).to.deep.equal(['#EXTM3U', '#EXT-X-VERSION:7']);
						Expect(tmpMaster.Variants.map((pVariant) => pVariant.URI)).to.deep.equal(['v1/index.m3u8', 'v0/index.m3u8']);
						Expect(tmpMaster.Variants[0].Attributes['AVERAGE-BANDWIDTH']).to.equal(String(Math.floor((8 * 130254) / 0.3)));
						Expect(libFS.readFileSync(libPath.join(tmpDirectory, 'v0', 'index.m3u8'), 'utf8')).to.contain('#EXT-X-TARGETDURATION:1\n');

						// A complete master from ffmpeg is only reordered, never rebuilt.
						libFS.writeFileSync(libPath.join(tmpDirectory, 'master.m3u8'), MASTER_FROM_FFMPEG);
						let tmpFullPlan = { FirstVariantIndex: 2, Rungs: [0, 1, 2, 3].map((pIndex) => ({ Playlist: `v${pIndex}/index.m3u8` })) };
						Expect(tmpWriter.reorderMasterFile(tmpDirectory, tmpFullPlan)[0].Bandwidth).to.equal(6234000);
					}
				);

				test
				(
					'verifyPackage: intact only when every Files[] entry matches its Bytes and Sha256',
					(fDone) =>
					{
						let tmpDirectory = libPath.join(tmpScratch, '1a2b3c4d');
						libFS.mkdirSync(libPath.join(tmpDirectory, 'v0'), { recursive: true });
						let tmpMaster = Buffer.from('#EXTM3U\n');
						let tmpMedia = Buffer.from('media bytes 0123456789');
						libFS.writeFileSync(libPath.join(tmpDirectory, 'master.m3u8'), tmpMaster);
						libFS.writeFileSync(libPath.join(tmpDirectory, 'v0', 'media.mp4'), tmpMedia);
						libFS.writeFileSync(libPath.join(tmpDirectory, 'package.json'), JSON.stringify(
							{
								Version: 1, PackageVersion: '1a2b3c4d',
								Files: [{ Path: 'master.m3u8', Bytes: tmpMaster.length, Sha256: sha256Of(tmpMaster) }, { Path: 'v0/media.mp4', Bytes: tmpMedia.length, Sha256: sha256Of(tmpMedia) }]
							}));
						let tmpWriter = new libPackageWriter({ Log: QUIET_LOG });

						let fCheck = (pPackageVersion, fAssert, fNext) =>
						{
							tmpWriter.verifyPackage(tmpDirectory, pPackageVersion, (pError, pReport) =>
								{
									try
									{
										if (pError)
										{
											throw pError;
										}
										fAssert(pReport);
									}
									catch (pAssertError)
									{
										return fDone(pAssertError);
									}
									return fNext();
								});
						};

						fCheck('1a2b3c4d', (pReport) =>
							{
								Expect(pReport.Intact).to.equal(true);
								Expect(pReport.Problems).to.deep.equal([]);
								Expect(pReport.Document.PackageVersion).to.equal('1a2b3c4d');
							}, () => fCheck('ffffffff', (pReport) =>
							{
								Expect(pReport.Intact).to.equal(false);
								Expect(pReport.Problems[0]).to.contain('names PackageVersion 1a2b3c4d');
							}, () =>
							{
								// Same size, different bytes: only the hash can tell.
								libFS.writeFileSync(libPath.join(tmpDirectory, 'v0', 'media.mp4'), Buffer.from('media bytes 9876543210'));
								fCheck('1a2b3c4d', (pReport) =>
									{
										Expect(pReport.Intact).to.equal(false);
										Expect(pReport.Problems).to.deep.equal(['v0/media.mp4 does not match its Sha256']);
									}, () =>
									{
										libFS.rmSync(libPath.join(tmpDirectory, 'master.m3u8'));
										libFS.appendFileSync(libPath.join(tmpDirectory, 'v0', 'media.mp4'), 'x');
										fCheck('1a2b3c4d', (pReport) =>
											{
												Expect(pReport.Intact).to.equal(false);
												Expect(pReport.Problems).to.deep.equal(['master.m3u8 is missing', `v0/media.mp4 is ${tmpMedia.length + 1} bytes, not ${tmpMedia.length}`]);
											}, () =>
											{
												libFS.rmSync(libPath.join(tmpDirectory, 'package.json'));
												fCheck('1a2b3c4d', (pReport) =>
													{
														Expect(pReport.Intact).to.equal(false);
														Expect(pReport.Problems).to.deep.equal(['no package.json']);
													}, fDone);
											});
									});
							}));
					}
				);

				test
				(
					'<PV>.lock: one live owner at a time (this process included); a dead owner\'s lock and partial are taken over',
					() =>
					{
						let tmpOutput = libPath.join(tmpScratch, 'locks');
						let tmpRunner = new libEncodeRunner({ Log: QUIET_LOG });
						let tmpOther = new libEncodeRunner({ Log: QUIET_LOG });
						let tmpPaths = tmpRunner.packagePaths(tmpOutput, '1a2b3c4d');
						Expect(tmpPaths.LockFile).to.equal(libPath.join(libPath.resolve(tmpOutput), '1a2b3c4d.lock'));

						Expect(tmpRunner.preparePartial(tmpOutput, '1a2b3c4d')).to.equal(tmpPaths.PartialDirectory);
						libFS.writeFileSync(libPath.join(tmpPaths.PartialDirectory, 'in-flight.mp4'), 'x');
						let tmpOwner = JSON.parse(libFS.readFileSync(tmpPaths.LockFile, 'utf8'));
						Expect(tmpOwner.Pid).to.equal(process.pid);
						Expect(tmpOwner.Hostname).to.equal(libOS.hostname());

						// A second claim -- same instance or another -- fails fast and leaves the first one's work alone.
						let tmpBusy = null;
						try
						{
							tmpOther.preparePartial(tmpOutput, '1a2b3c4d');
						}
						catch (pError)
						{
							tmpBusy = pError;
						}
						Expect(tmpBusy).to.be.an('error');
						Expect(tmpBusy.InProgress).to.equal(true);
						Expect(tmpBusy.message).to.contain('already being encoded').and.to.contain(`process ${process.pid}`);
						Expect(() => tmpRunner.preparePartial(tmpOutput, '1a2b3c4d')).to.throw('already being encoded');
						Expect(libFS.readdirSync(tmpPaths.PartialDirectory)).to.deep.equal(['in-flight.mp4']);
						Expect(tmpOther.releaseLock(tmpOutput, '1a2b3c4d')).to.equal(false);
						Expect(libFS.existsSync(tmpPaths.LockFile)).to.equal(true);

						// Discarding releases the lock; then anyone can claim it.
						tmpRunner.discardPartial(tmpOutput, '1a2b3c4d');
						Expect(libFS.existsSync(tmpPaths.PartialDirectory)).to.equal(false);
						Expect(libFS.existsSync(tmpPaths.LockFile)).to.equal(false);

						// A crashed run's lock (dead pid) and partial are taken over.
						libFS.mkdirSync(tmpPaths.PartialDirectory);
						libFS.writeFileSync(libPath.join(tmpPaths.PartialDirectory, 'stale.mp4'), 'x');
						libFS.writeFileSync(tmpPaths.LockFile, JSON.stringify({ Pid: deadPid(), Hostname: libOS.hostname(), Started: '2026-01-01T00:00:00Z', Token: 'dead' }));
						tmpOther.preparePartial(tmpOutput, '1a2b3c4d');
						Expect(libFS.readdirSync(tmpPaths.PartialDirectory)).to.deep.equal([]);
						Expect(JSON.parse(libFS.readFileSync(tmpPaths.LockFile, 'utf8')).Pid).to.equal(process.pid);

						// A finished <PV>/ is never replaced unless it was verified damaged.
						libFS.mkdirSync(tmpPaths.PackageDirectory);
						libFS.writeFileSync(libPath.join(tmpPaths.PackageDirectory, 'package.json'), '{}');
						Expect(() => tmpOther.commitPartial(tmpOutput, '1a2b3c4d', false)).to.throw('never replaced');
						Expect(libFS.readFileSync(libPath.join(tmpPaths.PackageDirectory, 'package.json'), 'utf8')).to.equal('{}');
						tmpOther.commitPartial(tmpOutput, '1a2b3c4d', true);
						Expect(libFS.readdirSync(tmpPaths.PackageDirectory)).to.deep.equal([]);
						Expect(libFS.readdirSync(tmpOutput)).to.deep.equal(['1a2b3c4d']);
					}
				);

				test
				(
					'lock liveness: this pid live, a dead pid stale, another host live, a fresh unreadable lock live',
					() =>
					{
						Expect(libEncodeRunner.lockOwnerIsLive({ Pid: process.pid, Hostname: libOS.hostname() })).to.equal(true);
						Expect(libEncodeRunner.lockOwnerIsLive({ Pid: deadPid(), Hostname: libOS.hostname() })).to.equal(false);
						Expect(libEncodeRunner.lockOwnerIsLive({ Pid: deadPid(), Hostname: 'another-machine.local' })).to.equal(true);
						Expect(libEncodeRunner.lockOwnerIsLive({ MTimeMS: Date.now() })).to.equal(true);
						Expect(libEncodeRunner.lockOwnerIsLive({ MTimeMS: Date.now() - 60000 })).to.equal(false);
						Expect(libEncodeRunner.lockOwnerIsLive(null)).to.equal(false);
					}
				);

				test
				(
					'sha256File hands back a cancel handle that stops the read',
					(fDone) =>
					{
						let tmpBig = libPath.join(tmpScratch, 'big.bin');
						libFS.writeFileSync(tmpBig, Buffer.alloc(64 * 1024 * 1024, 7));
						let tmpCalls = [];
						let tmpHandle = libTools.sha256File(tmpBig, (pError, pDigest) => { tmpCalls.push({ Error: pError, Digest: pDigest }); });
						Expect(tmpHandle.cancel()).to.equal(true);
						Expect(tmpHandle.cancel()).to.equal(false);
						setTimeout(() =>
							{
								try
								{
									Expect(tmpCalls.length).to.equal(1);
									Expect(tmpCalls[0].Error.Cancelled).to.equal(true);
									Expect(tmpCalls[0].Digest).to.equal(undefined);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								libTools.sha256File(tmpBig, (pError, pDigest) =>
									{
										try
										{
											Expect(pError).to.equal(null);
											Expect(pDigest).to.equal(sha256Of(libFS.readFileSync(tmpBig)));
										}
										catch (pAssertError)
										{
											return fDone(pAssertError);
										}
										return fDone();
									});
							}, 300);
					}
				);

				test
				(
					'spawnCollect hands back a cancel handle: SIGTERM, or SIGKILL at once when immediate',
					(fDone) =>
					{
						let tmpSleeper = ['-e', 'setTimeout(() => {}, 30000)'];
						let tmpStarted = Date.now();
						let tmpHandle = libTools.spawnCollect(process.execPath, tmpSleeper, {}, (pError) =>
							{
								try
								{
									Expect(pError.Cancelled).to.equal(true);
									Expect(pError.Signal).to.equal('SIGTERM');
									Expect(Date.now() - tmpStarted).to.be.below(2000);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								// A child that ignores SIGTERM dies at once on an immediate cancel.
								let tmpStubborn = libTools.spawnCollect(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000)'], { KillTimeoutMS: 20000 }, (pStubbornError) =>
									{
										try
										{
											Expect(pStubbornError.Cancelled).to.equal(true);
											Expect(pStubbornError.Signal).to.equal('SIGKILL');
										}
										catch (pAssertError)
										{
											return fDone(pAssertError);
										}
										return fDone();
									});
								setTimeout(() =>
									{
										tmpStubborn.cancel();
										tmpStubborn.cancel(true);
									}, 200);
							});
						Expect(tmpHandle.Process).to.be.an('object');
						setTimeout(() => { tmpHandle.cancel(); }, 100);
					}
				);

				test
				(
					'Sanitiser.checkFiles hands back a cancel handle that stops the running ffprobe',
					(fDone) =>
					{
						// A stand-in ffprobe that never answers.
						let tmpStub = libPath.join(tmpScratch, 'hung-ffprobe.js');
						libFS.writeFileSync(tmpStub, `#!${process.execPath}\nsetTimeout(() => {}, 30000);\n`);
						libFS.chmodSync(tmpStub, 0o755);
						libFS.writeFileSync(libPath.join(tmpScratch, 'x.mp4'), 'not really');
						let tmpSanitiser = new libSanitiser({ FFprobePath: tmpStub, Log: QUIET_LOG });
						let tmpStarted = Date.now();
						let tmpHandle = tmpSanitiser.checkFiles(tmpScratch, ['x.mp4'], (pError) =>
							{
								try
								{
									Expect(pError).to.be.an('error');
									Expect(pError.Cancelled).to.equal(true);
									Expect(Date.now() - tmpStarted).to.be.below(3000);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								return fDone();
							});
						setTimeout(() => { Expect(tmpHandle.cancel()).to.equal(true); }, 150);
					}
				);

				test
				(
					'a cancelled run reports nothing after the cancel: ffmpeg\'s last progress=end block is not 100%',
					(fDone) =>
					{
						// A stand-in ffmpeg that, as ffmpeg does, answers SIGTERM by flushing a final block marked
						// progress=end (and exits 255).  Given 'finish', it ends on its own with progress=end, exit 0.
						let tmpStub = libPath.join(tmpScratch, 'flushing-ffmpeg.js');
						let tmpFlushed = libPath.join(tmpScratch, 'flushing-ffmpeg.flushed');
						libFS.writeFileSync(tmpStub, [
							`#!${process.execPath}`,
							'let tmpUs = 0;',
							"let fBlock = (pProgress) => 'out_time_us=' + tmpUs + '\\nprogress=' + pProgress + '\\n';",
							"if (process.argv.indexOf('finish') >= 0)",
							'{',
							"\ttmpUs = 1000000; process.stdout.write(fBlock('continue'));",
							"\ttmpUs = 10000000; process.stdout.write(fBlock('end'), () => process.exit(0));",
							'}',
							'else',
							'{',
							"\tlet tmpTimer = setInterval(() => { tmpUs += 100000; process.stdout.write(fBlock('continue')); }, 50);",
							`\tprocess.on('SIGTERM', () => { clearInterval(tmpTimer); require('fs').writeFileSync(${JSON.stringify(tmpFlushed)}, 'end'); process.stdout.write(fBlock('end'), () => process.exit(255)); });`,
							'}',
							''].join('\n'));
						libFS.chmodSync(tmpStub, 0o755);
						let tmpRunner = new libEncodeRunner({ FFmpegPath: tmpStub, Log: QUIET_LOG });
						let tmpPercents = [];
						let tmpAtCancel = -1;
						let tmpHandle = tmpRunner.run([], { DurationSeconds: 10,
							onProgress: (pPercent) =>
							{
								tmpPercents.push(pPercent);
								if (tmpAtCancel < 0)
								{
									tmpAtCancel = tmpPercents.length;
									tmpHandle.cancel();
								}
							} },
							(pError) =>
							{
								try
								{
									Expect(pError).to.be.an('error');
									Expect(pError.Cancelled).to.equal(true);
									Expect(libFS.existsSync(tmpFlushed), 'the stand-in flushed its progress=end block').to.equal(true);
									Expect(tmpPercents.length, JSON.stringify(tmpPercents)).to.equal(tmpAtCancel);
									Expect(tmpPercents).to.not.include(100);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								// A run that ends on its own still reports 100 at progress=end.
								let tmpFinished = [];
								tmpRunner.run(['finish'], { DurationSeconds: 10, onProgress: (pPercent) => { tmpFinished.push(pPercent); } }, (pFinishError) =>
									{
										try
										{
											Expect(pFinishError).to.equal(null);
											Expect(tmpFinished).to.deep.equal([10, 100]);
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
					'the package is the plan\'s file list: strays (.DS_Store, Thumbs.db) are never listed or hashed; a missing planned file fails',
					(fDone) =>
					{
						// The allowlist, from the plan alone.
						let tmpHLG = hlgPlan();
						Expect(libPackageWriter.plannedPackageFiles(tmpHLG)).to.deep.equal(['download.mp4', 'master.m3u8', 'poster.jpg',
							'v0/index.m3u8', 'v0/media.mp4', 'v1/index.m3u8', 'v1/media.mp4', 'v2/index.m3u8', 'v2/media.mp4', 'v3/index.m3u8', 'v3/media.mp4']);
						tmpHLG.Download = false;
						Expect(libPackageWriter.plannedPackageFiles(tmpHLG)).to.not.include('download.mp4');

						// A finished encode's files (two rungs), plus what Finder and Explorer leave behind.
						let tmpDirectory = libPath.join(tmpScratch, 'strays');
						let tmpPlan = { FirstVariantIndex: 1, SegmentSeconds: 6, Download: true, FrameRate: { OutputValue: 30 }, Audio: { Enabled: true }, Rungs: [] };
						let tmpVariants = [];
						[['v0', 1280, 720], ['v1', 960, 540]].forEach((pRung) =>
							{
								libFS.mkdirSync(libPath.join(tmpDirectory, pRung[0]), { recursive: true });
								let tmpInit = fakeInit(true);
								libFS.writeFileSync(libPath.join(tmpDirectory, pRung[0], 'media.mp4'), Buffer.concat([tmpInit, libCrypto.randomBytes(4000)]));
								libFS.writeFileSync(libPath.join(tmpDirectory, pRung[0], 'index.m3u8'), RUNG_PLAYLIST);
								tmpPlan.Rungs.push({ Playlist: `${pRung[0]}/index.m3u8`, File: `${pRung[0]}/media.mp4`, Width: pRung[1], Height: pRung[2] });
								tmpVariants.push({ URI: `${pRung[0]}/index.m3u8`, Bandwidth: 1000000, AverageBandwidth: 0, Width: pRung[1], Height: pRung[2], Codecs: 'avc1.640028,mp4a.40.2' });
							});
						libFS.writeFileSync(libPath.join(tmpDirectory, 'master.m3u8'), libPackageWriter.buildMasterPlaylist(['#EXTM3U', '#EXT-X-VERSION:7'], tmpVariants));
						libFS.writeFileSync(libPath.join(tmpDirectory, 'poster.jpg'), libCrypto.randomBytes(500));
						libFS.writeFileSync(libPath.join(tmpDirectory, 'download.mp4'), libCrypto.randomBytes(900));
						let tmpHostile = 'v1/\x1b]0;TITLE\x07evil\u{202e}gpj.exe';
						let tmpLong = `v1/${'x'.repeat(200)}`;
						let tmpStrays = ['.DS_Store', 'Thumbs.db', 'v0/.DS_Store', 'v0/Thumbs.db', tmpHostile, tmpLong];
						tmpStrays.forEach((pPath) => { libFS.writeFileSync(libPath.join(tmpDirectory, pPath), 'stray'); });

						let tmpWarnings = [];
						let tmpWriter = new libPackageWriter({ Log: Object.assign({}, QUIET_LOG, { warn: (pMessage) => { tmpWarnings.push(String(pMessage)); } }) });
						let tmpPlanned = libPackageWriter.plannedPackageFiles(tmpPlan);
						tmpWriter.write(tmpDirectory, { Plan: tmpPlan, PackageVersion: '1a2b3c4d' }, (pError, pDocument) =>
							{
								try
								{
									Expect(pError).to.equal(null);
									Expect(pDocument.Files.map((pFile) => pFile.Path)).to.deep.equal(tmpPlanned);
									Expect(JSON.parse(libFS.readFileSync(libPath.join(tmpDirectory, 'package.json'), 'utf8')).Files).to.deep.equal(pDocument.Files);
									Expect(pDocument.Poster).to.equal('poster.jpg');
									Expect(pDocument.Download).to.equal('download.mp4');
									// Left alone on disk.
									tmpStrays.forEach((pPath) => { Expect(libFS.existsSync(libPath.join(tmpDirectory, pPath)), pPath).to.equal(true); });
									// One warning names them, printable (no escape, control or bidi character) and capped.
									Expect(tmpWarnings.length).to.equal(1);
									Expect(tmpWarnings[0]).to.contain('6 file(s) the encode did not make are left out of the package');
									['".DS_Store"', '"Thumbs.db"', '"v0/.DS_Store"', '"v0/Thumbs.db"', '\\u001b]0;TITLE\\u0007evil\\u202egpj.exe'].forEach((pName) => { Expect(tmpWarnings[0]).to.contain(pName); });
									Expect(/[\x00-\x1f\x7f-\x9f\u{202a}-\u{202e}]/u.test(tmpWarnings[0])).to.equal(false);
									Expect(tmpWarnings[0]).to.contain(`"v1/${'x'.repeat(117)}"...`);
									Expect(tmpWarnings[0]).to.not.contain('x'.repeat(118));
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								// verifyPackage reads only Files[]: intact, strays and all.
								tmpWriter.verifyPackage(tmpDirectory, '1a2b3c4d', (pVerifyError, pReport) =>
									{
										try
										{
											Expect(pVerifyError).to.equal(null);
											Expect(pReport.Problems).to.deep.equal([]);
											Expect(pReport.Intact).to.equal(true);

											// Past ten strays the warning names ten, then counts the rest.
											for (let i = 0; i < 8; i++)
											{
												libFS.writeFileSync(libPath.join(tmpDirectory, `junk-${i}.tmp`), 'stray');
											}
											Expect(tmpWriter.selectPackageFiles(tmpDirectory, tmpPlan)).to.deep.equal(tmpPlanned);
											Expect(tmpWarnings.length).to.equal(2);
											Expect(tmpWarnings[1]).to.contain('14 file(s)').and.to.match(/ and 4 more\.$/);
											Expect(tmpWarnings[1].match(/(^|, |: )"/g).length).to.equal(10);

											// A planned file that is missing fails, naming it.
											libFS.rmSync(libPath.join(tmpDirectory, 'v1', 'media.mp4'));
											Expect(() => tmpWriter.selectPackageFiles(tmpDirectory, tmpPlan)).to.throw('The package is missing v1/media.mp4');
										}
										catch (pAssertError)
										{
											return fDone(pAssertError);
										}
										tmpWriter.write(tmpDirectory, { Plan: tmpPlan, PackageVersion: '1a2b3c4d' }, (pMissingError) =>
											{
												try
												{
													Expect(pMissingError).to.be.an('error');
													Expect(pMissingError.message).to.contain('missing v1/media.mp4').and.to.contain('broken');
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

				test
				(
					'poster.jpg is optional: without one the package is written with Poster null; a missing required file is named; an unreadable stray directory costs only a warning',
					(fDone) =>
					{
						// A finished two-rung encode of a source whose video stream ends before the poster's seek
						// point (~10% in): ffmpeg exited 0 and wrote no poster.jpg.
						let tmpDirectory = libPath.join(tmpScratch, 'no-poster');
						let tmpPlan = { FirstVariantIndex: 1, SegmentSeconds: 6, Download: true, FrameRate: { OutputValue: 30 }, Audio: { Enabled: true }, Rungs: [] };
						let tmpVariants = [];
						[['v0', 1280, 720], ['v1', 960, 540]].forEach((pRung) =>
							{
								libFS.mkdirSync(libPath.join(tmpDirectory, pRung[0]), { recursive: true });
								libFS.writeFileSync(libPath.join(tmpDirectory, pRung[0], 'media.mp4'), Buffer.concat([fakeInit(true), libCrypto.randomBytes(4000)]));
								libFS.writeFileSync(libPath.join(tmpDirectory, pRung[0], 'index.m3u8'), RUNG_PLAYLIST);
								tmpPlan.Rungs.push({ Playlist: `${pRung[0]}/index.m3u8`, File: `${pRung[0]}/media.mp4`, Width: pRung[1], Height: pRung[2] });
								tmpVariants.push({ URI: `${pRung[0]}/index.m3u8`, Bandwidth: 1000000, AverageBandwidth: 0, Width: pRung[1], Height: pRung[2], Codecs: 'avc1.640028,mp4a.40.2' });
							});
						let tmpMasterText = libPackageWriter.buildMasterPlaylist(['#EXTM3U', '#EXT-X-VERSION:7'], tmpVariants);
						libFS.writeFileSync(libPath.join(tmpDirectory, 'master.m3u8'), tmpMasterText);
						libFS.writeFileSync(libPath.join(tmpDirectory, 'download.mp4'), libCrypto.randomBytes(900));

						let tmpWarnings = [];
						let tmpWriter = new libPackageWriter({ Log: Object.assign({}, QUIET_LOG, { warn: (pMessage) => { tmpWarnings.push(String(pMessage)); } }) });
						let tmpExpected = ['download.mp4', 'master.m3u8', 'v0/index.m3u8', 'v0/media.mp4', 'v1/index.m3u8', 'v1/media.mp4'];
						Expect(libPackageWriter.plannedPackageFiles(tmpPlan)).to.include('poster.jpg');
						Expect(tmpWriter.selectPackageFiles(tmpDirectory, tmpPlan)).to.deep.equal(tmpExpected);
						// A directory named poster.jpg is not a poster.
						libFS.mkdirSync(libPath.join(tmpDirectory, 'poster.jpg'));
						Expect(tmpWriter.selectPackageFiles(tmpDirectory, tmpPlan)).to.deep.equal(tmpExpected);
						libFS.rmdirSync(libPath.join(tmpDirectory, 'poster.jpg'));
						Expect(tmpWarnings).to.deep.equal([]);

						tmpWriter.write(tmpDirectory, { Plan: tmpPlan, PackageVersion: '1a2b3c4d' }, (pError, pDocument) =>
							{
								try
								{
									Expect(pError).to.equal(null);
									Expect(pDocument.Poster).to.equal(null);
									Expect(pDocument.Download).to.equal('download.mp4');
									Expect(pDocument.Files.map((pFile) => pFile.Path)).to.deep.equal(tmpExpected);
									Expect(JSON.parse(libFS.readFileSync(libPath.join(tmpDirectory, 'package.json'), 'utf8')).Poster).to.equal(null);
									Expect(tmpWarnings).to.deep.equal([]);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								tmpWriter.verifyPackage(tmpDirectory, '1a2b3c4d', (pVerifyError, pReport) =>
									{
										let tmpUnreadable = libPath.join(tmpDirectory, 'v1', '.Spotlight-V100');
										try
										{
											Expect(pVerifyError).to.equal(null);
											Expect(pReport.Intact, pReport.Problems.join('; ')).to.equal(true);

											// Every other planned file is required: download.mp4 only while the plan has one.
											libFS.renameSync(libPath.join(tmpDirectory, 'download.mp4'), libPath.join(tmpScratch, 'no-poster-download.mp4'));
											Expect(() => tmpWriter.selectPackageFiles(tmpDirectory, tmpPlan)).to.throw('The package is missing download.mp4: the encode did not make it');
											Expect(tmpWriter.selectPackageFiles(tmpDirectory, Object.assign({}, tmpPlan, { Download: false })))
												.to.deep.equal(['master.m3u8', 'v0/index.m3u8', 'v0/media.mp4', 'v1/index.m3u8', 'v1/media.mp4']);
											libFS.renameSync(libPath.join(tmpScratch, 'no-poster-download.mp4'), libPath.join(tmpDirectory, 'download.mp4'));

											// A stray directory the walk cannot read: the package is the planned files all the same.
											libFS.mkdirSync(tmpUnreadable);
											libFS.writeFileSync(libPath.join(tmpUnreadable, 'store.db'), 'stray');
											libFS.chmodSync(tmpUnreadable, 0o000);
											let tmpReadable = true;
											try
											{
												libFS.readdirSync(tmpUnreadable);
											}
											catch (pReadError)
											{
												tmpReadable = false;
											}
											Expect(tmpWriter.selectPackageFiles(tmpDirectory, tmpPlan)).to.deep.equal(tmpExpected);
											Expect(tmpWarnings.length).to.equal(1);
											// (root reads anything: then the stray is simply named.)
											Expect(tmpWarnings[0]).to.contain(tmpReadable ? '"v1/.Spotlight-V100/store.db"' : 'could not look through the package directory for stray files (EACCES)');
										}
										catch (pAssertError)
										{
											return fDone(pAssertError);
										}
										finally
										{
											if (libFS.existsSync(tmpUnreadable))
											{
												libFS.chmodSync(tmpUnreadable, 0o755);
												libFS.rmSync(tmpUnreadable, { recursive: true });
											}
										}

										// write() names a missing master.m3u8 before it tries to read it.
										libFS.rmSync(libPath.join(tmpDirectory, 'master.m3u8'));
										tmpWriter.write(tmpDirectory, { Plan: tmpPlan, PackageVersion: '1a2b3c4d' }, (pMissingError) =>
											{
												try
												{
													Expect(pMissingError).to.be.an('error');
													Expect(pMissingError.message).to.equal('The package is missing master.m3u8: the encode did not make it, so the package would be broken.');
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
		suite
		(
			'ffmpeg preflight (pure): listings, requirements and messages',
			() =>
			{
				let fSummary = (pFixture) => libMediaProbe.summarize(require(libPath.join(__dirname, 'fixtures', `${pFixture}.json`)));

				test
				(
					'parses ffmpeg 7.1\'s -encoders, -filters and -hwaccels listings; the legends and the rule are not names',
					() =>
					{
						// As ffmpeg 7.1 (Homebrew) prints them, cut down.
						let tmpEncoders = ['Encoders:', ' V..... = Video', ' A..... = Audio', ' S..... = Subtitle', ' .F.... = Frame-level multithreading',
							' ..S... = Slice-level multithreading', ' ...X.. = Codec is experimental', ' ....B. = Supports draw_horiz_band',
							' .....D = Supports direct rendering method 1', ' ------',
							' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
							' V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)',
							' VFS... mjpeg                MJPEG (Motion JPEG)',
							' V....D libaom-av1           libaom AV1 (codec av1)',
							' A....D aac                  AAC (Advanced Audio Coding)', ''].join('\n');
						Expect(libTools.parseEncoderList(tmpEncoders)).to.deep.equal(['libx264', 'h264_videotoolbox', 'mjpeg', 'libaom-av1', 'aac']);

						let tmpFilters = ['Filters:', '  T.. = Timeline support', '  .S. = Slice threading', '  ..C = Command support', '  A = Audio input/output',
							'  V = Video input/output', '  N = Dynamic number and/or type of input/output', '  | = Source or sink filter',
							' TSC aap               AA->A      Apply Affine Projection algorithm to first audio stream.',
							' ... buffer            |->V       Buffer video frames, and make them accessible to the filterchain.',
							' TS. thumbnail         V->V       Select the most representative frame in a given sequence of consecutive frames.',
							' .S. zscale            V->V       Apply resizing, colorspace and bit depth conversion.', ''].join('\r\n');
						Expect(libTools.parseFilterList(tmpFilters)).to.deep.equal(['aap', 'buffer', 'thumbnail', 'zscale']);

						Expect(libTools.parseHwaccelList('Hardware acceleration methods:\nvideotoolbox\n\n')).to.deep.equal(['videotoolbox']);
						Expect(libTools.parseHwaccelList('Hardware acceleration methods:\nvdpau\ncuda\nvaapi\nqsv\ndrm\nopencl\nvulkan\n\n')).to.deep.equal(['vdpau', 'cuda', 'vaapi', 'qsv', 'drm', 'opencl', 'vulkan']);
						Expect(libTools.parseHwaccelList('Hardware acceleration methods:\n\n')).to.deep.equal([]);
						Expect(libTools.parseEncoderList('')).to.deep.equal([]);

						// What the tests' stand-in ffmpeg prints parses the same way.
						Expect(libTools.parseEncoderList(libStandInFFmpeg.encoderListing(libStandInFFmpeg.ALL_ENCODERS))).to.deep.equal(libStandInFFmpeg.ALL_ENCODERS);
						Expect(libTools.parseFilterList(libStandInFFmpeg.filterListing(libStandInFFmpeg.ALL_FILTERS))).to.deep.equal(libStandInFFmpeg.ALL_FILTERS);
					}
				);

				test
				(
					'filter names come out of a graph the way ffmpeg reads it: an escaped LUT path, quotes, labels and instances never split it',
					() =>
					{
						Expect(libTools.filterGraphNames(libLadderPlanner.buildFilterGraph(hlgPlan()))).to.deep.equal(['fps', 'scale', 'setsar', 'setparams', 'zscale', 'format', 'tonemap', 'split', 'null']);

						// Every character the option or the graph parser treats specially, in the LUT's path.
						let tmpAwkward = '/footage/LUTs, odd:dir;x/it\'s [v1]=a\\b.cube';
						let tmpGraph = libLadderPlanner.buildFilterGraph(libLadderPlanner.planLadder(fSummary('source-720p'), { Lut: tmpAwkward }));
						Expect(tmpGraph).to.contain('lut3d=file=/footage/LUTs\\, odd\\\\:dir\\;x/it\\\\\\\'s \\[v1\\]=a\\\\\\\\b.cube:interp=tetrahedral');
						Expect(libTools.filterGraphNames(tmpGraph)).to.deep.equal(['fps', 'scale', 'setsar', 'lut3d', 'format', 'split', 'null']);

						Expect(libTools.filterGraphNames('sws_flags=bicubic;[in] scale@top = w=\'iw/2,x\':h=-2 [a]; [a]drawtext=text=a\\,b\\;c\\[d\\] , null[out]')).to.deep.equal(['scale', 'drawtext', 'null']);
						Expect(libTools.filterGraphNames('')).to.deep.equal([]);
						Expect(libTools.filterGraphNames(undefined)).to.deep.equal([]);
					}
				);

				test
				(
					'the requirements are read from what will run -- the encode, the poster and the download -- not from a hand list',
					() =>
					{
						let tmpLadder = new libRetoldMediaLadder({ Log: QUIET_LOG });
						let fRequired = (pFixture, pOptions) => tmpLadder.ffmpegRequirements(libLadderPlanner.planLadder(fSummary(pFixture), pOptions), '/footage/-c:v copy.mp4');
						let tmpHLGFilters = ['fps', 'scale', 'setsar', 'setparams', 'zscale', 'format', 'tonemap', 'split', 'null', 'thumbnail'];

						// HLG on macOS: x264 + aac for the ladder, mjpeg + thumbnail for the poster, the VideoToolbox decode.
						Expect(fRequired('dji-4k-hlg-100fps-audio', { Hwaccel: true })).to.deep.equal({ Encoders: ['libx264', 'aac', 'mjpeg'], Filters: tmpHLGFilters, Hwaccels: ['videotoolbox'] });
						Expect(fRequired('dji-4k-hlg-100fps-audio', { Hwaccel: false, Fast: true })).to.deep.equal({ Encoders: ['h264_videotoolbox', 'aac', 'mjpeg'], Filters: tmpHLGFilters, Hwaccels: [] });
						// SDR, no audio: no zscale, tonemap or aac is asked for.
						Expect(fRequired('drone-no-audio', { Hwaccel: false, Download: false })).to.deep.equal({ Encoders: ['libx264', 'mjpeg'], Filters: ['fps', 'scale', 'setsar', 'format', 'split', 'null', 'thumbnail'], Hwaccels: [] });
						Expect(fRequired('slowmo-120fps', { Hwaccel: true, SlowMotion: true, Lut: '/footage/a, b.cube' }).Filters).to.deep.equal(['setpts', 'fps', 'scale', 'setsar', 'lut3d', 'format', 'split', 'null', 'thumbnail']);

						// Straight from argument lists: 'copy' needs no encoder, auto / none hwaccels are always there, an input is never a flag.
						Expect(libTools.capabilityRequirements([['-hwaccel', 'auto', '-i', '-vf', '-c', 'copy', '-vf', 'yadif,scale=-2:720', '-c:v:0', 'libx265'],
							['-hwaccel', 'none', '-acodec', 'libopus', '-filter:a', 'volume=2', '-c:a', 'libopus']])).to.deep.equal({ Encoders: ['libx265', 'libopus'], Filters: ['yadif', 'scale', 'volume'], Hwaccels: [] });
						Expect(libTools.capabilityRequirements([])).to.deep.equal({ Encoders: [], Filters: [], Hwaccels: [] });
					}
				);

				test
				(
					'one message names every missing piece and what media-ladder needs; a path or version line is made printable',
					() =>
					{
						let tmpVersion = 'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers';
						let tmpMissing = libTools.missingCapabilities({ Encoders: ['aac', 'mjpeg'], Filters: ['fps', 'scale'], Hwaccels: [] },
							{ Encoders: ['libx264', 'aac', 'mjpeg'], Filters: ['fps', 'zscale', 'scale', 'tonemap'], Hwaccels: ['videotoolbox'] });
						Expect(tmpMissing).to.deep.equal([{ Kind: 'encoder', Name: 'libx264' }, { Kind: 'filter', Name: 'zscale' }, { Kind: 'filter', Name: 'tonemap' }, { Kind: 'hwaccel', Name: 'videotoolbox' }]);
						Expect(libTools.missingCapabilities({ Encoders: ['libx264'], Filters: [], Hwaccels: [] }, { Encoders: ['libx264'], Filters: [], Hwaccels: [] })).to.deep.equal([]);

						Expect(libTools.describeMissingCapabilities('/usr/bin/ffmpeg', tmpVersion, tmpMissing.slice(0, 2))).to.equal(
							'This ffmpeg (/usr/bin/ffmpeg, ffmpeg version 6.1.1-3ubuntu5) cannot run this encode: it has no libx264 encoder and no zscale filter. '
							+ 'media-ladder needs ffmpeg 7.x built with libx264, zscale (zimg) and tonemap.');
						let tmpAll = libTools.capabilityError('/usr/bin/ffmpeg', tmpVersion, tmpMissing);
						Expect(tmpAll.message).to.equal(
							'This ffmpeg (/usr/bin/ffmpeg, ffmpeg version 6.1.1-3ubuntu5) cannot run this encode: it has no libx264 encoder, no zscale filter, no tonemap filter and no videotoolbox hwaccel. '
							+ 'media-ladder needs ffmpeg 7.x built with libx264, zscale (zimg) and tonemap. '
							+ 'Turn the hardware decode off (--no-hwaccel / Hwaccel: false) to decode in software instead.');
						Expect(tmpAll.Capability).to.equal(true);
						Expect(tmpAll.Missing).to.deep.equal(tmpMissing);
						Expect(tmpAll.FFmpeg).to.equal('/usr/bin/ffmpeg');
						Expect(tmpAll.FFmpegVersion).to.equal(tmpVersion);

						// A missing Fast encoder says so in both CLI and library terms; nothing else mentions Fast.
						Expect(libTools.describeMissingCapabilities('/usr/bin/ffmpeg', tmpVersion, [{ Kind: 'encoder', Name: 'h264_videotoolbox' }])).to.equal(
							'This ffmpeg (/usr/bin/ffmpeg, ffmpeg version 6.1.1-3ubuntu5) cannot run this encode: it has no h264_videotoolbox encoder. '
							+ 'media-ladder needs ffmpeg 7.x built with libx264, zscale (zimg) and tonemap. '
							+ 'Fast encoding (--fast / Fast: true) needs h264_videotoolbox, a macOS encoder; leave it off to encode with libx264.');
						Expect(tmpAll.message).to.not.contain('Fast');

						// A path can hold anything: what a terminal would act on is shown escaped.
						let tmpEscape = (pHex) => `\\u${pHex}`;
						Expect(libTools.describeMissingCapabilities('/opt/ff\x1b[2Jmpeg\n\u{202e}', 'ffmpeg version 7.1\x07', [{ Kind: 'encoder', Name: 'libx264' }])).to.equal(
							`This ffmpeg (/opt/ff${tmpEscape('001b')}[2Jmpeg${tmpEscape('000a')}${tmpEscape('202e')}, ffmpeg version 7.1${tmpEscape('0007')}) cannot run this encode: it has no libx264 encoder. `
							+ 'media-ladder needs ffmpeg 7.x built with libx264, zscale (zimg) and tonemap.');
						Expect(libTools.printableText('x'.repeat(600)).length).to.equal(503);
						Expect(libTools.printableText('/caf\u{e9}/\u{1F3AC}.mp4')).to.equal('/caf\u{e9}/\u{1F3AC}.mp4');
					}
				);

				test
				(
					'the ffmpeg version: 7.1, 6.1.1-3ubuntu5 and n7.0.2 read, git builds do not; below 7 is only a warning',
					() =>
					{
						let fCopyright = (pVersion) => `ffmpeg version ${pVersion} Copyright (c) 2000-2024 the FFmpeg developers`;
						Expect(libTools.parseFFmpegMajorVersion(fCopyright('7.1'))).to.equal(7);
						Expect(libTools.parseFFmpegMajorVersion(fCopyright('6.1.1-3ubuntu5'))).to.equal(6);
						Expect(libTools.parseFFmpegMajorVersion(fCopyright('n7.0.2'))).to.equal(7);
						Expect(libTools.parseFFmpegMajorVersion(fCopyright('4.4.2-0ubuntu0.22.04.1'))).to.equal(4);
						Expect(libTools.parseFFmpegMajorVersion(fCopyright('7.1-full_build-www.gyan.dev'))).to.equal(7);
						Expect(libTools.parseFFmpegMajorVersion(fCopyright('N-117962-g3f5e0f1a7a-20241118'))).to.equal(null);
						Expect(libTools.parseFFmpegMajorVersion(fCopyright('2024-11-18-git-4fb2e7ad47-full_build-www.gyan.dev'))).to.equal(null);
						Expect(libTools.parseFFmpegMajorVersion('ffmpeg version stub-for-tests')).to.equal(null);
						Expect(libTools.parseFFmpegMajorVersion(null)).to.equal(null);
						Expect(libTools.ffmpegVersionText(fCopyright('6.1.1-3ubuntu5'))).to.equal('ffmpeg version 6.1.1-3ubuntu5');

						Expect(libTools.olderFFmpegWarning('/usr/bin/ffmpeg', fCopyright('6.1.1-3ubuntu5'))).to.equal(
							'This ffmpeg (/usr/bin/ffmpeg, ffmpeg version 6.1.1-3ubuntu5) is older than the 7.x media-ladder is tested with; the encode may still work, but if it fails, install ffmpeg 7.x.');
						[fCopyright('7.1'), fCopyright('8.0'), fCopyright('N-117962-g3f5e0f1a7a-20241118'), 'ffmpeg version stub-for-tests'].forEach((pLine) =>
							{
								Expect(libTools.olderFFmpegWarning('/usr/bin/ffmpeg', pLine), pLine).to.equal(null);
							});
					}
				);
			}
		);

		suite
		(
			'ffmpeg preflight: the ladder checks ffmpeg before it hashes anything (a stand-in ffmpeg, no real one)',
			() =>
			{
				let tmpScratch = false;
				let tmpSource = false;
				let tmpRealSha256File = libTools.sha256File;
				let tmpHashed = [];
				let fSummary = (pFixture) => libMediaProbe.summarize(require(libPath.join(__dirname, 'fixtures', `${pFixture}.json`)));
				let tmpOldVersion = 'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers';
				let tmpHLGFilters = ['fps', 'scale', 'setsar', 'setparams', 'zscale', 'format', 'tonemap', 'split', 'null', 'thumbnail'];

				/** A ladder on pPlatform using the ffmpeg at pFFmpeg, probing pFixture whatever the input (warnings into pWarnings). */
				let fLadder = (pPlatform, pFFmpeg, pFixture, pWarnings) =>
				{
					let fQuiet = () => {};
					let fRecord = (pMessage) => { if (pWarnings) { pWarnings.push(String(pMessage)); } };
					let tmpLadder = new libRetoldMediaLadder({ FFmpegPath: pFFmpeg, Log: { trace: fQuiet, debug: fQuiet, info: fQuiet, warn: fRecord, error: fRecord } });
					tmpLadder.platform = pPlatform;
					let tmpSummary = fSummary(pFixture);
					tmpLadder.probe = (pInputPath, fCallback) =>
					{
						setImmediate(() => fCallback(null, tmpSummary));
						return libTools.inertHandle();
					};
					return tmpLadder;
				};

				let fGone = (pPid) =>
				{
					try
					{
						process.kill(pPid, 0);
						return false;
					}
					catch (pError)
					{
						return pError.code === 'ESRCH';
					}
				};

				suiteSetup
				(
					() =>
					{
						tmpScratch = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'retold-media-ladder-preflight-'));
						tmpSource = libPath.join(tmpScratch, 'source.mp4');
						libFS.writeFileSync(tmpSource, 'retold-media-ladder PackageVersion fixture\n');
						// Count every hash: a refused encode must not have started one.
						libTools.sha256File = function (pPath)
						{
							tmpHashed.push(pPath);
							return tmpRealSha256File.apply(null, arguments);
						};
					}
				);

				suiteTeardown
				(
					() =>
					{
						libTools.sha256File = tmpRealSha256File;
						if (tmpScratch)
						{
							libFS.rmSync(tmpScratch, { recursive: true, force: true });
						}
					}
				);

				setup
				(
					() =>
					{
						tmpHashed.length = 0;
					}
				);

				test
				(
					'an ffmpeg without libx264, zscale or tonemap: encode refuses with one sentence naming each, before hashing or writing anything',
					(fDone) =>
					{
						let tmpStub = libStandInFFmpeg.writeStandInFFmpeg(libPath.join(tmpScratch, 'distro-ffmpeg.js'),
							{
								VersionLine: tmpOldVersion,
								Encoders: ['libx265', 'mjpeg', 'aac'],
								Filters: libStandInFFmpeg.ALL_FILTERS.filter((pName) => pName !== 'zscale' && pName !== 'tonemap'),
								Hwaccels: []
							});
						let tmpOutput = libPath.join(tmpScratch, 'refused');
						let tmpPhases = [];
						fLadder('linux', tmpStub, 'dji-4k-hlg-100fps-audio').encode(tmpSource, { OutputDirectory: tmpOutput, onProgress: (pEvent) => { tmpPhases.push(pEvent.Phase); } }, (pError) =>
							{
								try
								{
									Expect(pError).to.be.an('error');
									Expect(pError.message).to.equal(`This ffmpeg (${tmpStub}, ffmpeg version 6.1.1-3ubuntu5) cannot run this encode: it has no libx264 encoder, no zscale filter and no tonemap filter. `
										+ 'media-ladder needs ffmpeg 7.x built with libx264, zscale (zimg) and tonemap.');
									Expect(pError.Capability).to.equal(true);
									Expect(pError.Missing).to.deep.equal([{ Kind: 'encoder', Name: 'libx264' }, { Kind: 'filter', Name: 'zscale' }, { Kind: 'filter', Name: 'tonemap' }]);
									Expect(pError.FFmpeg).to.equal(tmpStub);
									Expect(pError.FFmpegVersion).to.equal(tmpOldVersion);
									Expect(pError.Cancelled).to.equal(undefined);
									Expect(tmpPhases).to.deep.equal(['probe', 'preflight']);
									Expect(tmpHashed).to.deep.equal([]);
									Expect(libFS.existsSync(tmpOutput)).to.equal(false);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								// On macOS the default decode is VideoToolbox (a build without it is pointed at turning it off),
								// and Fast needs h264_videotoolbox (pointed at leaving Fast off).
								fLadder('darwin', tmpStub, 'source-720p').encode(tmpSource, { OutputDirectory: tmpOutput, Fast: true }, (pMacError) =>
									{
										try
										{
											Expect(pMacError.message).to.equal(`This ffmpeg (${tmpStub}, ffmpeg version 6.1.1-3ubuntu5) cannot run this encode: it has no h264_videotoolbox encoder and no videotoolbox hwaccel. `
												+ 'media-ladder needs ffmpeg 7.x built with libx264, zscale (zimg) and tonemap. '
												+ 'Fast encoding (--fast / Fast: true) needs h264_videotoolbox, a macOS encoder; leave it off to encode with libx264. '
												+ 'Turn the hardware decode off (--no-hwaccel / Hwaccel: false) to decode in software instead.');
											Expect(pMacError.Missing).to.deep.equal([{ Kind: 'encoder', Name: 'h264_videotoolbox' }, { Kind: 'hwaccel', Name: 'videotoolbox' }]);
											Expect(tmpHashed).to.deep.equal([]);
											Expect(libFS.existsSync(tmpOutput)).to.equal(false);
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
					'plan() never fails over the ffmpeg build: what is missing, an older version and an ffmpeg that does not run are warnings',
					(fDone) =>
					{
						let tmpStub = libStandInFFmpeg.writeStandInFFmpeg(libPath.join(tmpScratch, 'plan-distro-ffmpeg.js'),
							{
								VersionLine: tmpOldVersion,
								Encoders: ['mjpeg', 'aac'],
								Filters: libStandInFFmpeg.ALL_FILTERS.filter((pName) => pName !== 'zscale'),
								Hwaccels: []
							});
						let tmpMissingMessage = `This ffmpeg (${tmpStub}, ffmpeg version 6.1.1-3ubuntu5) cannot run this encode: it has no libx264 encoder and no zscale filter. `
							+ 'media-ladder needs ffmpeg 7.x built with libx264, zscale (zimg) and tonemap.';
						let tmpOlderWarning = `This ffmpeg (${tmpStub}, ffmpeg version 6.1.1-3ubuntu5) is older than the 7.x media-ladder is tested with; the encode may still work, but if it fails, install ffmpeg 7.x.`;
						fLadder('linux', tmpStub, 'dji-4k-hlg-100fps-audio').plan(tmpSource, {}, (pError, pResult) =>
							{
								try
								{
									Expect(pError).to.equal(null);
									Expect(pResult.Plan.Video.Encoder).to.equal('libx264');
									Expect(pResult.CommandLine).to.contain('libx264');
									Expect(pResult.Preflight).to.deep.equal(
										{
											FFmpeg: tmpStub,
											Version: tmpOldVersion,
											Major: 6,
											Runnable: true,
											Required: { Encoders: ['libx264', 'aac', 'mjpeg'], Filters: tmpHLGFilters, Hwaccels: [] },
											Missing: [{ Kind: 'encoder', Name: 'libx264' }, { Kind: 'filter', Name: 'zscale' }],
											Message: tmpMissingMessage,
											Warnings: [tmpOlderWarning]
										});
									Expect(pResult.Plan.Warnings.slice(-2)).to.deep.equal([tmpOlderWarning, tmpMissingMessage]);
									Expect(tmpHashed).to.deep.equal([]);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								let tmpNowhere = libPath.join(tmpScratch, 'no-such-ffmpeg');
								let tmpNotRunnable = `ffmpeg is not runnable (${tmpNowhere}): spawn ${tmpNowhere} ENOENT`;
								fLadder('linux', tmpNowhere, 'source-720p').plan(tmpSource, {}, (pNoError, pNoResult) =>
									{
										try
										{
											Expect(pNoError).to.equal(null);
											Expect(pNoResult.Preflight.Runnable).to.equal(false);
											Expect(pNoResult.Preflight.Version).to.equal(null);
											Expect(pNoResult.Preflight.Message).to.equal(tmpNotRunnable);
											Expect(pNoResult.Preflight.Required.Encoders).to.deep.equal(['libx264', 'aac', 'mjpeg']);
											Expect(pNoResult.Plan.Warnings[pNoResult.Plan.Warnings.length - 1]).to.equal(tmpNotRunnable);
										}
										catch (pAssertError)
										{
											return fDone(pAssertError);
										}
										// The encode keeps its message for an ffmpeg that does not run, and still hashes nothing.
										fLadder('linux', tmpNowhere, 'source-720p').encode(tmpSource, { OutputDirectory: libPath.join(tmpScratch, 'nowhere-out') }, (pEncodeError) =>
											{
												try
												{
													Expect(pEncodeError.message).to.equal(tmpNotRunnable);
													Expect(pEncodeError.Capability).to.equal(undefined);
													Expect(tmpHashed).to.deep.equal([]);
													Expect(libFS.existsSync(libPath.join(tmpScratch, 'nowhere-out'))).to.equal(false);
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

				test
				(
					'an ffmpeg older than 7.x only warns: the encode goes on, and the warning is logged with the plan\'s, once, before the hash',
					(fDone) =>
					{
						let tmpStub = libStandInFFmpeg.writeStandInFFmpeg(libPath.join(tmpScratch, 'older-ffmpeg.js'), { VersionLine: tmpOldVersion });
						let tmpWarnings = [];
						let tmpWarningsAtHash = null;
						let tmpPackageVersion = null;
						let tmpHandle = fLadder('linux', tmpStub, 'dlog-10bit-sdr', tmpWarnings).encode(tmpSource,
							{
								OutputDirectory: libPath.join(tmpScratch, 'older-out'),
								onProgress: (pEvent) =>
								{
									if ((pEvent.Phase === 'hash') && (tmpWarningsAtHash === null))
									{
										tmpWarningsAtHash = tmpWarnings.slice();
									}
									if (pEvent.Phase === 'plan')
									{
										tmpPackageVersion = pEvent.Message;
										tmpHandle.abort();
									}
								}
							},
							(pError) =>
							{
								try
								{
									Expect(pError.Cancelled).to.equal(true);
									Expect(tmpPackageVersion).to.match(/^PackageVersion [0-9a-f]{8}$/);
									Expect(tmpHashed).to.deep.equal([tmpSource]);
									Expect(tmpWarnings).to.deep.equal(
										[
											`media-ladder: ${libLadderPlanner.WARNING_POSSIBLY_DLOG}`,
											`media-ladder: This ffmpeg (${tmpStub}, ffmpeg version 6.1.1-3ubuntu5) is older than the 7.x media-ladder is tested with; the encode may still work, but if it fails, install ffmpeg 7.x.`
										]);
									// Logged before the (possibly long) hash began, and not again after it.
									Expect(tmpWarningsAtHash).to.deep.equal(tmpWarnings);
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
					'an ffmpeg that runs but cannot list what it has: plan keeps its version and gives the reason; encode refuses before hashing',
					(fDone) =>
					{
						let tmpStub = libStandInFFmpeg.writeStandInFFmpeg(libPath.join(tmpScratch, 'unlisting-ffmpeg.js'), { VersionLine: tmpOldVersion, Fail: '-filters' });
						let tmpReason = /^ffmpeg -filters exited with code 1: stand-in: -filters failed/;
						let tmpOlderWarning = libTools.olderFFmpegWarning(tmpStub, tmpOldVersion);
						fLadder('linux', tmpStub, 'source-720p').plan(tmpSource, {}, (pError, pResult) =>
							{
								try
								{
									Expect(pError).to.equal(null);
									Expect(pResult.Preflight.FFmpeg).to.equal(tmpStub);
									Expect(pResult.Preflight.Runnable).to.equal(true);
									Expect(pResult.Preflight.Version).to.equal(tmpOldVersion);
									Expect(pResult.Preflight.Major).to.equal(6);
									Expect(pResult.Preflight.Required.Encoders).to.deep.equal(['libx264', 'aac', 'mjpeg']);
									Expect(pResult.Preflight.Missing).to.deep.equal([]);
									Expect(pResult.Preflight.Message).to.match(tmpReason);
									Expect(pResult.Preflight.Warnings).to.deep.equal([tmpOlderWarning]);
									Expect(pResult.Plan.Warnings.slice(-2)).to.deep.equal([tmpOlderWarning, pResult.Preflight.Message]);
									Expect(tmpHashed).to.deep.equal([]);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								fLadder('linux', tmpStub, 'source-720p').encode(tmpSource, { OutputDirectory: libPath.join(tmpScratch, 'unlisting-out') }, (pEncodeError) =>
									{
										try
										{
											Expect(pEncodeError.message).to.match(tmpReason);
											Expect(pEncodeError.Capability).to.equal(undefined);
											Expect(tmpHashed).to.deep.equal([]);
											Expect(libFS.existsSync(libPath.join(tmpScratch, 'unlisting-out'))).to.equal(false);
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
					'cancel and abort during the preflight stop the listing ffmpeg; nothing is hashed or written',
					function (fDone)
					{
						this.timeout(15000);
						let tmpLog = libPath.join(tmpScratch, 'hung-listing.log');
						let tmpStub = libStandInFFmpeg.writeStandInFFmpeg(libPath.join(tmpScratch, 'hung-listing-ffmpeg.js'), { Hang: '-encoders', LogFile: tmpLog });
						let tmpOutput = libPath.join(tmpScratch, 'hung-out');
						let fHungPid = () => libStandInFFmpeg.readStandInLog(tmpLog).filter((pRun) => pRun.Arguments.indexOf('-encoders') >= 0).map((pRun) => pRun.Pid).pop();
						/** Once the -encoders listing is running (and hanging), call fStop. */
						let fWhenHung = (fStop) =>
						{
							let tmpTimer = setInterval(() =>
								{
									let tmpPid = fHungPid();
									if (tmpPid)
									{
										clearInterval(tmpTimer);
										libFS.rmSync(tmpLog, { force: true });
										fStop(tmpPid);
									}
								}, 20);
						};
						let tmpState = { Pid: 0, StoppedAt: 0, Result: null };
						let tmpHandle = fLadder('linux', tmpStub, 'source-720p').encode(tmpSource,
							{
								OutputDirectory: tmpOutput,
								onProgress: (pEvent) =>
								{
									if (pEvent.Phase === 'preflight')
									{
										fWhenHung((pPid) =>
											{
												tmpState.Pid = pPid;
												tmpState.StoppedAt = Date.now();
												tmpState.Result = tmpHandle.cancel();
											});
									}
								}
							},
							(pError) =>
							{
								try
								{
									Expect(pError).to.be.an('error');
									Expect(pError.Cancelled).to.equal(true);
									Expect(tmpState.Result).to.equal(true);
									// SIGTERM ends a listing at once; the 2 s SIGKILL grace is never waited out.
									Expect(Date.now() - tmpState.StoppedAt).to.be.below(1500);
									Expect(fGone(tmpState.Pid), 'the hung listing was stopped').to.equal(true);
									Expect(tmpHashed).to.deep.equal([]);
									Expect(libFS.existsSync(tmpOutput)).to.equal(false);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								// abort(): calls back at once, and the listing is SIGKILLed.
								let tmpAbort = { Pid: 0, CalledBack: false, Error: null };
								let tmpAbortHandle = fLadder('linux', tmpStub, 'source-720p').encode(tmpSource,
									{
										OutputDirectory: tmpOutput,
										onProgress: (pEvent) =>
										{
											if (pEvent.Phase !== 'preflight')
											{
												return;
											}
											fWhenHung((pPid) =>
												{
													tmpAbort.Pid = pPid;
													tmpAbortHandle.abort();
													let tmpDeadline = Date.now() + 2000;
													let fCheck = () =>
													{
														if (!fGone(pPid) && Date.now() < tmpDeadline)
														{
															return setTimeout(fCheck, 20);
														}
														try
														{
															Expect(tmpAbort.CalledBack, 'abort() calls back synchronously').to.equal(true);
															Expect(tmpAbort.Error.Cancelled).to.equal(true);
															Expect(fGone(pPid), 'the hung listing was killed').to.equal(true);
															Expect(tmpHashed).to.deep.equal([]);
															Expect(libFS.existsSync(tmpOutput)).to.equal(false);
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
									},
									(pAbortError) =>
									{
										tmpAbort.CalledBack = true;
										tmpAbort.Error = pAbortError;
									});
							});
					}
				);

				test
				(
					'the listings call back only when every listing process is gone: a cancel leaves none running, even one that ignores SIGTERM',
					(fDone) =>
					{
						let tmpLog = libPath.join(tmpScratch, 'stubborn-listing.log');
						let tmpStub = libStandInFFmpeg.writeStandInFFmpeg(libPath.join(tmpScratch, 'stubborn-listing-ffmpeg.js'), { Hang: ['-encoders', '-filters'], Stubborn: ['-filters'], LogFile: tmpLog });
						let fPids = () => libStandInFFmpeg.readStandInLog(tmpLog).map((pRun) => pRun.Pid);
						let tmpState = { CancelledAt: 0, Result: null };
						let tmpHandle = libTools.ffmpegCapabilities(tmpStub, {}, (pError, pListing) =>
							{
								try
								{
									Expect(pError).to.be.an('error');
									Expect(pError.Cancelled).to.equal(true);
									Expect(pListing).to.equal(undefined);
									Expect(tmpState.Result).to.equal(true);
									// The SIGTERM-proof listing is SIGKILLed as soon as the cancel takes, not after the 2 s grace.
									Expect(Date.now() - tmpState.CancelledAt).to.be.below(1500);
									let tmpPids = fPids();
									Expect(tmpPids.length).to.equal(3);
									tmpPids.forEach((pPid) => { Expect(fGone(pPid), `listing process ${pPid} is gone`).to.equal(true); });
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								return fDone();
							});
						let tmpTimer = setInterval(() =>
							{
								// All three listings have started (and -hwaccels has answered): cancel.
								if (fPids().length === 3)
								{
									clearInterval(tmpTimer);
									setTimeout(() =>
										{
											tmpState.CancelledAt = Date.now();
											tmpState.Result = tmpHandle.cancel();
										}, 100);
								}
							}, 20);
					}
				);

				test
				(
					'the listings run once per ffmpeg path per process; a failed listing is not kept, and a short one is listed again',
					(fDone) =>
					{
						let tmpLog = libPath.join(tmpScratch, 'cache.log');
						let tmpStub = libPath.join(tmpScratch, 'cache-ffmpeg.js');
						let tmpOther = libPath.join(tmpScratch, 'cache-other-ffmpeg.js');
						let fListings = () => libStandInFFmpeg.readStandInLog(tmpLog).filter((pRun) => pRun.Arguments.indexOf('-version') < 0).length;
						let tmpRequired = { Encoders: ['libx264'], Filters: ['scale'], Hwaccels: [] };
						let tmpSteps = [];
						let fStep = (fBody) => { tmpSteps.push(fBody); };
						let fNext = () =>
						{
							let fBody = tmpSteps.shift();
							if (!fBody)
							{
								return fDone();
							}
							try
							{
								return fBody();
							}
							catch (pAssertError)
							{
								return fDone(pAssertError);
							}
						};
						let fCheck = (pPath, pRequired, fAssert) =>
						{
							libTools.checkFFmpegCapabilities(pPath, pRequired, (pError, pMissing) =>
								{
									try
									{
										fAssert(pError, pMissing);
									}
									catch (pAssertError)
									{
										return fDone(pAssertError);
									}
									return fNext();
								});
						};
						let tmpBefore = 0;

						// A listing that fails is an error, and is not kept.
						fStep(() =>
							{
								libStandInFFmpeg.writeStandInFFmpeg(tmpStub, { LogFile: tmpLog, Fail: '-filters' });
								fCheck(tmpStub, tmpRequired, (pError) =>
									{
										Expect(pError).to.be.an('error');
										Expect(pError.message).to.equal('ffmpeg -filters exited with code 1: stand-in: -filters failed');
									});
							});
						// Fixed: listed afresh (all three), then kept.
						fStep(() =>
							{
								libStandInFFmpeg.writeStandInFFmpeg(tmpStub, { LogFile: tmpLog });
								tmpBefore = fListings();
								fCheck(tmpStub, tmpRequired, (pError, pMissing) =>
									{
										Expect(pError).to.equal(null);
										Expect(pMissing).to.deep.equal([]);
										Expect(fListings() - tmpBefore).to.equal(3);
									});
							});
						fStep(() =>
							{
								tmpBefore = fListings();
								fCheck(tmpStub, tmpRequired, (pError, pMissing) =>
									{
										Expect(pMissing).to.deep.equal([]);
										Expect(fListings() - tmpBefore, 'the second check used the kept listing').to.equal(0);
									});
							});
						// The ladder's preflight shares it: only -version runs.
						fStep(() =>
							{
								tmpBefore = libStandInFFmpeg.readStandInLog(tmpLog).length;
								let tmpLadder = fLadder('linux', tmpStub, 'drone-no-audio');
								tmpLadder.preflight(libLadderPlanner.planLadder(fSummary('drone-no-audio'), { Hwaccel: false }), tmpSource, (pError, pReport) =>
									{
										try
										{
											Expect(pError).to.equal(null);
											Expect(pReport.Missing).to.deep.equal([]);
											Expect(pReport.Version).to.equal(libStandInFFmpeg.STAND_IN_VERSION_LINE);
											Expect(libStandInFFmpeg.readStandInLog(tmpLog).slice(tmpBefore).map((pRun) => pRun.Arguments)).to.deep.equal([['-hide_banner', '-version']]);
										}
										catch (pAssertError)
										{
											return fDone(pAssertError);
										}
										return fNext();
									});
							});
						// Another path is listed on its own.
						fStep(() =>
							{
								libStandInFFmpeg.writeStandInFFmpeg(tmpOther, { LogFile: tmpLog });
								tmpBefore = fListings();
								fCheck(tmpOther, tmpRequired, (pError, pMissing) =>
									{
										Expect(pMissing).to.deep.equal([]);
										Expect(fListings() - tmpBefore).to.equal(3);
									});
							});
						// An ffmpeg replaced in place: a kept listing that comes up short is listed again before it refuses...
						fStep(() =>
							{
								libStandInFFmpeg.writeStandInFFmpeg(tmpStub, { LogFile: tmpLog, Encoders: ['aac'] });
								tmpBefore = fListings();
								fCheck(tmpStub, { Encoders: ['libx265'], Filters: [], Hwaccels: [] }, (pError, pMissing) =>
									{
										Expect(pMissing).to.deep.equal([{ Kind: 'encoder', Name: 'libx265' }]);
										Expect(fListings() - tmpBefore).to.equal(3);
									});
							});
						// ...so installing what was missing needs no restart.
						fStep(() =>
							{
								libStandInFFmpeg.writeStandInFFmpeg(tmpStub, { LogFile: tmpLog, Encoders: ['libx265'] });
								tmpBefore = fListings();
								fCheck(tmpStub, { Encoders: ['libx265'], Filters: [], Hwaccels: [] }, (pError, pMissing) =>
									{
										Expect(pError).to.equal(null);
										Expect(pMissing).to.deep.equal([]);
										Expect(fListings() - tmpBefore).to.equal(3);
									});
							});
						fNext();
					}
				);

				test
				(
					'the PackageVersion is 1.0.0\'s: the plan, the -version line and the source digest that key it are unchanged by the preflight moving ahead of the hash',
					(fDone) =>
					{
						let tmpStub = libStandInFFmpeg.writeStandInFFmpeg(libPath.join(tmpScratch, 'pv-ffmpeg.js'));
						let tmpLut = libPath.join(tmpScratch, 'identity.cube');
						let tmpLines = ['TITLE "identity"', 'LUT_3D_SIZE 2'];
						[0, 1].forEach((pB) => [0, 1].forEach((pG) => [0, 1].forEach((pR) => tmpLines.push(`${pR}.0 ${pG}.0 ${pB}.0`))));
						libFS.writeFileSync(tmpLut, tmpLines.join('\n') + '\n');
						// What retold-media-ladder 1.0.0 (a85cc71) computes for exactly these inputs: a re-run under
						// 1.0.1 must land on (and reuse) the same <out>/<PV>/.
						let tmpCases =
						[
							{ Fixture: 'source-720p', Platform: 'darwin', Options: { Lut: tmpLut }, PackageVersion: 'b35eb386' },
							{ Fixture: 'dji-4k-hlg-100fps-audio', Platform: 'darwin', Options: {}, PackageVersion: '1ec77d2e' },
							{ Fixture: 'drone-no-audio', Platform: 'linux', Options: { Download: false, Preset: 'veryfast' }, PackageVersion: '5a0c6d1b' },
							{ Fixture: 'slowmo-120fps', Platform: 'darwin', Options: { SlowMotion: true, Fast: true, Profile: 'hq' }, PackageVersion: 'b4c7ce0b' }
						];
						let fCase = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								return fDone();
							}
							let tmpCase = tmpCases[pIndex];
							let tmpLadder = fLadder(tmpCase.Platform, tmpStub, tmpCase.Fixture);
							let tmpInputs = [];
							let tmpRealCompute = tmpLadder.PackageWriter.computePackageVersion.bind(tmpLadder.PackageWriter);
							tmpLadder.PackageWriter.computePackageVersion = function ()
							{
								tmpInputs.push(Array.prototype.slice.call(arguments));
								return tmpRealCompute.apply(null, arguments);
							};
							let tmpReported = null;
							let tmpHandle = tmpLadder.encode(tmpSource, Object.assign(
								{
									OutputDirectory: libPath.join(tmpScratch, 'pv-out'),
									onProgress: (pEvent) =>
									{
										if (pEvent.Phase === 'plan')
										{
											tmpReported = pEvent.Message;
											tmpHandle.abort();
										}
									}
								}, tmpCase.Options), (pError) =>
								{
									try
									{
										Expect(pError.Cancelled, pError.message).to.equal(true);
										Expect(tmpReported, tmpCase.Fixture).to.equal(`PackageVersion ${tmpCase.PackageVersion}`);
										// The inputs, made independently the way 1.0.0 made them.
										let tmpPlannerOptions = Object.assign({ Hwaccel: (tmpCase.Platform === 'darwin') }, tmpCase.Options);
										if (tmpCase.Options.Lut)
										{
											tmpPlannerOptions.LutSha256 = sha256Of(libFS.readFileSync(tmpLut));
										}
										let tmpPlan = libLadderPlanner.planLadder(fSummary(tmpCase.Fixture), tmpPlannerOptions);
										Expect(tmpInputs.length).to.equal(1);
										Expect(tmpInputs[0][0]).to.deep.equal(tmpPlan);
										Expect(tmpInputs[0][1]).to.equal(libStandInFFmpeg.STAND_IN_VERSION_LINE);
										Expect(tmpInputs[0][2]).to.equal(sha256Of(libFS.readFileSync(tmpSource)));
										Expect(libPackageWriter.computePackageVersion(tmpPlan, libStandInFFmpeg.STAND_IN_VERSION_LINE, sha256Of(libFS.readFileSync(tmpSource)))).to.equal(tmpCase.PackageVersion);
									}
									catch (pAssertError)
									{
										return fDone(pAssertError);
									}
									return fCase(pIndex + 1);
								});
						};
						fCase(0);
					}
				);

				test
				(
					'EncodeRunner asks for -progress pipe:1 -nostats and no -stats_period (0.5 s is ffmpeg\'s own period; before 4.4 the flag is refused)',
					(fDone) =>
					{
						let tmpLog = libPath.join(tmpScratch, 'progress-arguments.log');
						let tmpStub = libStandInFFmpeg.writeStandInFFmpeg(libPath.join(tmpScratch, 'progress-ffmpeg.js'),
							{ LogFile: tmpLog, Body: ["process.stdout.write('out_time_us=1000000\\nprogress=end\\n', () => process.exit(0));"] });
						let tmpPercents = [];
						new libEncodeRunner({ FFmpegPath: tmpStub, Log: QUIET_LOG }).run(['-i', 'in.mp4', 'out.m3u8'], { DurationSeconds: 1, onProgress: (pPercent) => { tmpPercents.push(pPercent); } }, (pError) =>
							{
								try
								{
									Expect(pError).to.equal(null);
									Expect(tmpPercents).to.deep.equal([100]);
									Expect(libStandInFFmpeg.readStandInLog(tmpLog).map((pRun) => pRun.Arguments)).to.deep.equal([['-progress', 'pipe:1', '-nostats', '-i', 'in.mp4', 'out.m3u8']]);
								}
								catch (pAssertError)
								{
									return fDone(pAssertError);
								}
								return fDone();
							});
					}
				);
			}
		);

		suite
		(
			'Windows commit robustness (simulated on any OS): retried renames, rollback, best-effort cleanup',
			() =>
			{
				let tmpScratch = false;
				let tmpPackageVersion = '1a2b3c4d';
				// The default schedule's shape (doubling, capped, a total), in milliseconds instead of seconds.
				let tmpFastRetry = { FirstMS: 1, MaxMS: 4, TotalMS: 20 };

				/** An Error shaped like the one fs throws. */
				let fFSError = (pCode, pSyscall, pPath) =>
				{
					let tmpError = new Error(`${pCode}: simulated, ${pSyscall} '${pPath}'`);
					tmpError.code = pCode;
					tmpError.syscall = pSyscall;
					tmpError.path = pPath;
					return tmpError;
				};

				/**
				 * A runner on pPlatform whose renameSync / rmSync go through fRename / fRm (each given the real
				 * call to fall through to), warnings into pWarnings, on the fast schedule.
				 */
				let fRunner = (pPlatform, pWarnings, fRename, fRm) =>
				{
					let fQuiet = () => {};
					let tmpRunner = new libEncodeRunner({ Log: { trace: fQuiet, debug: fQuiet, info: fQuiet, warn: (pMessage) => { pWarnings.push(String(pMessage)); }, error: fQuiet } });
					tmpRunner.platform = pPlatform;
					tmpRunner.renameRetry = Object.assign({}, tmpFastRetry);
					tmpRunner.fileSystem = Object.assign({}, libFS,
						{
							renameSync: (pFrom, pTo) => (fRename ? fRename(pFrom, pTo, libFS.renameSync) : libFS.renameSync(pFrom, pTo)),
							rmSync: (pPath, pOptions) => (fRm ? fRm(pPath, pOptions, libFS.rmSync) : libFS.rmSync(pPath, pOptions))
						});
					return tmpRunner;
				};

				/** A fresh output directory with a claimed <PV>.partial/ holding 'new' (and a damaged <PV>/ holding 'old' when asked). */
				let fStage = (pRunner, pName, pWithDamaged) =>
				{
					let tmpOutput = libPath.join(tmpScratch, pName);
					let tmpPaths = pRunner.packagePaths(tmpOutput, tmpPackageVersion);
					if (pWithDamaged)
					{
						libFS.mkdirSync(tmpPaths.PackageDirectory, { recursive: true });
						libFS.writeFileSync(libPath.join(tmpPaths.PackageDirectory, 'package.json'), 'old');
					}
					pRunner.preparePartial(tmpOutput, tmpPackageVersion);
					libFS.writeFileSync(libPath.join(tmpPaths.PartialDirectory, 'package.json'), 'new');
					return { Output: tmpOutput, Paths: tmpPaths };
				};

				suiteSetup
				(
					() =>
					{
						tmpScratch = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'retold-media-ladder-commit-'));
					}
				);

				suiteTeardown
				(
					() =>
					{
						if (tmpScratch)
						{
							libFS.rmSync(tmpScratch, { recursive: true, force: true });
						}
					}
				);

				test
				(
					'the schedule: 50 ms doubling to 1 s, 10 s in all, on win32 only; directory removals ask Node to retry on win32 only',
					() =>
					{
						Expect(libEncodeRunner.retryDelays(50, 1000, 10000)).to.deep.equal([50, 100, 200, 400, 800, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 450]);
						Expect(libEncodeRunner.retryDelays(1, 4, 20)).to.deep.equal([1, 2, 4, 4, 4, 4, 1]);
						Expect(libEncodeRunner.retryDelays(0, 4, 20)).to.deep.equal([]);
						Expect(libEncodeRunner.RENAME_RETRY).to.deep.equal({ FirstMS: 50, MaxMS: 1000, TotalMS: 10000 });
						Expect(libEncodeRunner.RETRYABLE_RENAME_CODES).to.deep.equal(['EPERM', 'EACCES', 'EBUSY']);
						let tmpDefault = new libEncodeRunner({});
						Expect(tmpDefault.platform).to.equal(process.platform);
						Expect(tmpDefault.fileSystem).to.equal(libFS);
						Expect(tmpDefault.renameRetry).to.deep.equal({ FirstMS: 50, MaxMS: 1000, TotalMS: 10000 });

						Expect(libEncodeRunner.RM_RETRY).to.deep.equal({ maxRetries: 3, retryDelay: 100 });

						// Every directory removal (a stale partial, a discarded one, a replaced damaged package) carries
						// Node's retries on win32, and none elsewhere: a file that stays locked fails at once there, as in 1.0.0.
						[['linux', { recursive: true, force: true }], ['darwin', { recursive: true, force: true }], ['win32', { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }]].forEach((pCase) =>
							{
								let tmpRemovals = [];
								let tmpWarnings = [];
								let tmpRunner = fRunner(pCase[0], tmpWarnings, null, (pPath, pOptions, fReal) =>
									{
										tmpRemovals.push({ Path: libPath.basename(pPath), Options: pOptions });
										return fReal(pPath, pOptions);
									});
								let tmpStaged = fStage(tmpRunner, `rm-options-${pCase[0]}`, true);
								tmpRunner.commitPartial(tmpStaged.Output, tmpPackageVersion, true);
								tmpRunner.preparePartial(tmpStaged.Output, tmpPackageVersion);
								tmpRunner.discardPartial(tmpStaged.Output, tmpPackageVersion);
								let tmpDirectoryRemovals = tmpRemovals.filter((pRemoval) => !/\.lock$/.test(pRemoval.Path));
								Expect(tmpDirectoryRemovals.map((pRemoval) => pRemoval.Path.replace(/retired-.*$/, 'retired-*')), pCase[0]).to.deep.equal(
									['1a2b3c4d.partial', '1a2b3c4d.retired-*', '1a2b3c4d.partial', '1a2b3c4d.partial']);
								tmpDirectoryRemovals.forEach((pRemoval) =>
									{
										Expect(Object.assign({}, pRemoval.Options), `${pCase[0]} ${pRemoval.Path}`).to.deep.equal(pCase[1]);
									});
								Expect(libFS.readdirSync(tmpStaged.Output)).to.deep.equal([tmpPackageVersion]);
								Expect(tmpWarnings).to.deep.equal([]);
							});
					}
				);

				test
				(
					'win32: a rename that fails with EPERM, EACCES or EBUSY a few times goes through; the package lands and the lock is released',
					() =>
					{
						libEncodeRunner.RETRYABLE_RENAME_CODES.forEach((pCode) =>
							{
								let tmpWarnings = [];
								let tmpAttempts = 0;
								let tmpRunner = fRunner('win32', tmpWarnings, (pFrom, pTo, fReal) =>
									{
										if (/\.partial$/.test(pFrom))
										{
											tmpAttempts++;
											if (tmpAttempts <= 3)
											{
												throw fFSError(pCode, 'rename', pFrom);
											}
										}
										return fReal(pFrom, pTo);
									});
								let tmpStaged = fStage(tmpRunner, `transient-${pCode}`, false);
								Expect(tmpRunner.commitPartial(tmpStaged.Output, tmpPackageVersion, false)).to.equal(tmpStaged.Paths.PackageDirectory);
								Expect(tmpAttempts, pCode).to.equal(4);
								Expect(libFS.readFileSync(libPath.join(tmpStaged.Paths.PackageDirectory, 'package.json'), 'utf8')).to.equal('new');
								Expect(libFS.readdirSync(tmpStaged.Output)).to.deep.equal([tmpPackageVersion]);
								Expect(tmpWarnings.length, pCode).to.equal(1);
								Expect(tmpWarnings[0]).to.contain(`failed (${pCode}: another program, such as antivirus or the search indexer, may be holding a file in it); retrying for up to 20 ms.`);
							});
					}
				);

				test
				(
					'win32: a rename still locked when the time is up throws its last error; the partial is left for discardPartial',
					() =>
					{
						let tmpWarnings = [];
						let tmpThrown = [];
						let tmpRunner = fRunner('win32', tmpWarnings, (pFrom, pTo, fReal) =>
							{
								if (/\.partial$/.test(pFrom))
								{
									let tmpError = fFSError('EPERM', 'rename', pFrom);
									tmpThrown.push(tmpError);
									throw tmpError;
								}
								return fReal(pFrom, pTo);
							});
						let tmpStaged = fStage(tmpRunner, 'locked', false);
						let tmpStarted = Date.now();
						let tmpCaught = null;
						try
						{
							tmpRunner.commitPartial(tmpStaged.Output, tmpPackageVersion, false);
						}
						catch (pError)
						{
							tmpCaught = pError;
						}
						Expect(tmpCaught).to.equal(tmpThrown[tmpThrown.length - 1]);
						Expect(tmpCaught.code).to.equal('EPERM');
						Expect(tmpThrown.length).to.equal(libEncodeRunner.retryDelays(1, 4, 20).length + 1);
						// The waits really happen (Atomics.wait), and add up to the budget.
						Expect(Date.now() - tmpStarted).to.be.at.least(18);
						Expect(libFS.existsSync(tmpStaged.Paths.PackageDirectory)).to.equal(false);
						Expect(libFS.existsSync(libPath.join(tmpStaged.Paths.PartialDirectory, 'package.json'))).to.equal(true);
						Expect(libFS.existsSync(tmpStaged.Paths.LockFile)).to.equal(true);
						tmpRunner.discardPartial(tmpStaged.Output, tmpPackageVersion);
						Expect(libFS.readdirSync(tmpStaged.Output)).to.deep.equal([]);
					}
				);

				test
				(
					'macOS and Linux never retry a rename, and win32 does not retry an error a wait cannot fix',
					() =>
					{
						[['darwin', 'EPERM'], ['linux', 'EPERM'], ['linux', 'EBUSY'], ['win32', 'ENOENT'], ['win32', 'EXDEV'], ['win32', 'ENOTEMPTY']].forEach((pCase) =>
							{
								let tmpWarnings = [];
								let tmpAttempts = 0;
								let tmpRunner = fRunner(pCase[0], tmpWarnings, (pFrom, pTo, fReal) =>
									{
										if (/\.partial$/.test(pFrom))
										{
											tmpAttempts++;
											throw fFSError(pCase[1], 'rename', pFrom);
										}
										return fReal(pFrom, pTo);
									});
								let tmpStaged = fStage(tmpRunner, `no-retry-${pCase[0]}-${pCase[1]}`, false);
								Expect(() => tmpRunner.commitPartial(tmpStaged.Output, tmpPackageVersion, false), pCase.join(' ')).to.throw(pCase[1]);
								Expect(tmpAttempts, pCase.join(' ')).to.equal(1);
								Expect(tmpWarnings, pCase.join(' ')).to.deep.equal([]);
								tmpRunner.discardPartial(tmpStaged.Output, tmpPackageVersion);
							});
					}
				);

				test
				(
					'win32: once the new package is in place, a damaged package that cannot be removed only warns',
					() =>
					{
						let tmpWarnings = [];
						let tmpRunner = fRunner('win32', tmpWarnings, null, (pPath, pOptions, fReal) =>
							{
								if (/\.retired-/.test(pPath))
								{
									throw fFSError('EBUSY', 'rmdir', pPath);
								}
								return fReal(pPath, pOptions);
							});
						let tmpStaged = fStage(tmpRunner, 'retired-stays', true);
						Expect(tmpRunner.commitPartial(tmpStaged.Output, tmpPackageVersion, true)).to.equal(tmpStaged.Paths.PackageDirectory);
						Expect(libFS.readFileSync(libPath.join(tmpStaged.Paths.PackageDirectory, 'package.json'), 'utf8')).to.equal('new');
						let tmpLeft = libFS.readdirSync(tmpStaged.Output).sort();
						Expect(tmpLeft.length).to.equal(2);
						Expect(tmpLeft[0]).to.equal(tmpPackageVersion);
						Expect(tmpLeft[1]).to.match(/^1a2b3c4d\.retired-\d+-\d+$/);
						Expect(tmpWarnings.length).to.equal(1);
						Expect(tmpWarnings[0]).to.equal(`EncodeRunner: the package is in place, but the damaged package it replaced could not be removed (${libPath.join(tmpStaged.Output, tmpLeft[1])}): EBUSY: simulated, rmdir '${libPath.join(tmpStaged.Output, tmpLeft[1])}'`);
					}
				);

				test
				(
					'win32: when the new package cannot be renamed into place, the damaged one is moved back and the error is thrown',
					() =>
					{
						let tmpWarnings = [];
						let tmpRunner = fRunner('win32', tmpWarnings, (pFrom, pTo, fReal) =>
							{
								if (/\.partial$/.test(pFrom))
								{
									throw fFSError('EPERM', 'rename', pFrom);
								}
								return fReal(pFrom, pTo);
							});
						let tmpStaged = fStage(tmpRunner, 'rollback', true);
						Expect(() => tmpRunner.commitPartial(tmpStaged.Output, tmpPackageVersion, true)).to.throw(`EPERM: simulated, rename '${tmpStaged.Paths.PartialDirectory}'`);
						// What the caller had: the damaged package at <PV>/, nothing retired, the partial for discardPartial.
						Expect(libFS.readFileSync(libPath.join(tmpStaged.Paths.PackageDirectory, 'package.json'), 'utf8')).to.equal('old');
						Expect(libFS.readdirSync(tmpStaged.Output).sort()).to.deep.equal([tmpPackageVersion, '1a2b3c4d.lock', '1a2b3c4d.partial']);
						tmpRunner.discardPartial(tmpStaged.Output, tmpPackageVersion);
						Expect(libFS.readdirSync(tmpStaged.Output)).to.deep.equal([tmpPackageVersion]);

						// When even the move back fails: warn, and still throw the commit's own error.
						let tmpRestoreWarnings = [];
						let tmpStuck = fRunner('win32', tmpRestoreWarnings, (pFrom, pTo, fReal) =>
							{
								if (/\.partial$/.test(pFrom))
								{
									throw fFSError('EPERM', 'rename', pFrom);
								}
								if (/\.retired-/.test(pFrom))
								{
									throw fFSError('EACCES', 'rename', pFrom);
								}
								return fReal(pFrom, pTo);
							});
						let tmpStuckStaged = fStage(tmpStuck, 'rollback-fails', true);
						Expect(() => tmpStuck.commitPartial(tmpStuckStaged.Output, tmpPackageVersion, true)).to.throw(`EPERM: simulated, rename '${tmpStuckStaged.Paths.PartialDirectory}'`);
						let tmpRetired = libFS.readdirSync(tmpStuckStaged.Output).filter((pName) => /\.retired-/.test(pName));
						Expect(tmpRetired.length).to.equal(1);
						Expect(libFS.readFileSync(libPath.join(tmpStuckStaged.Output, tmpRetired[0], 'package.json'), 'utf8')).to.equal('old');
						Expect(tmpRestoreWarnings.filter((pLine) => pLine.indexOf('could not move the damaged package') >= 0)).to.deep.equal(
							[`EncodeRunner: could not move the damaged package ${libPath.join(tmpStuckStaged.Output, tmpRetired[0])} back to ${tmpStuckStaged.Paths.PackageDirectory}: EACCES: simulated, rename '${libPath.join(tmpStuckStaged.Output, tmpRetired[0])}'`]);
					}
				);
			}
		);
	}
);
