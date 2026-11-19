/**
* Unit tests for the pure parts of PackageWriter, Sanitiser, EncodeRunner's
* progress parsing and the shared tools; plus the package lifecycle pieces
* that need only a temp directory and a stand-in process (no ffmpeg): the
* `<PV>.lock` claim, package verification, the master rebuild for sub-0.5 s
* clips, the cancel handles (and no progress after a cancel), and the plan's
* file list (a stray .DS_Store or Thumbs.db is never packaged).
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
	}
);
