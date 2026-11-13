/**
* Unit tests for the pure probe summary and the LadderPlanner.
*
* Driven entirely by ffprobe JSON fixtures in test/fixtures/ -- no ffmpeg runs.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libPath = require('node:path');

const libMediaProbe = require('../source/Media-Probe.js');
const libLadderPlanner = require('../source/Ladder-Planner.js');

function loadSummary(pName)
{
	return libMediaProbe.summarize(require(libPath.join(__dirname, 'fixtures', `${pName}.json`)));
}

function argumentAfter(pArguments, pFlag)
{
	let tmpIndex = pArguments.indexOf(pFlag);
	return (tmpIndex >= 0) ? pArguments[tmpIndex + 1] : undefined;
}

suite
(
	'Retold Media Ladder -- probe summary and planner',
	() =>
	{
		suite
		(
			'MediaProbe.summarize',
			() =>
			{
				test
				(
					'reads HLG, 10-bit, fps, audio and data streams from a DJI 4K100 HLG file',
					() =>
					{
						let tmpSummary = loadSummary('dji-4k-hlg-100fps-audio');
						Expect(tmpSummary.HasVideo).to.equal(true);
						Expect(tmpSummary.HasAudio).to.equal(true);
						Expect(tmpSummary.DataStreamCount).to.equal(1);
						Expect(tmpSummary.Video.Transfer).to.equal('hlg');
						Expect(tmpSummary.Video.IsHDR).to.equal(true);
						Expect(tmpSummary.Video.ColorPrimaries).to.equal('bt2020');
						Expect(tmpSummary.Video.BitDepth).to.equal(10);
						Expect(tmpSummary.Video.FrameRate).to.equal('100/1');
						Expect(tmpSummary.Video.DisplayWidth).to.equal(3840);
						Expect(tmpSummary.Video.DisplayHeight).to.equal(2160);
						Expect(tmpSummary.DurationSeconds).to.equal(12.5);
						Expect(tmpSummary.Raw).to.be.an('object');
					}
				);
				test
				(
					'a -90 display matrix normalises to 270 and swaps the displayed dimensions',
					() =>
					{
						let tmpSummary = loadSummary('phone-portrait-rotated');
						Expect(tmpSummary.Video.Rotation).to.equal(270);
						Expect(tmpSummary.Video.Width).to.equal(3840);
						Expect(tmpSummary.Video.DisplayWidth).to.equal(2160);
						Expect(tmpSummary.Video.DisplayHeight).to.equal(3840);
						Expect(tmpSummary.Video.FrameRate).to.equal('30000/1001');
						Expect(tmpSummary.Video.Transfer).to.equal('sdr');
					}
				);
				test
				(
					'no audio stream is reported as HasAudio false',
					() =>
					{
						let tmpSummary = loadSummary('drone-no-audio');
						Expect(tmpSummary.HasAudio).to.equal(false);
						Expect(tmpSummary.Audio).to.equal(null);
					}
				);
				test
				(
					'helpers: rotation, bit depth and transfer classes',
					() =>
					{
						Expect(libMediaProbe.normalizeRotation(-90)).to.equal(270);
						Expect(libMediaProbe.normalizeRotation(90)).to.equal(90);
						Expect(libMediaProbe.normalizeRotation(-180)).to.equal(180);
						Expect(libMediaProbe.normalizeRotation('x')).to.equal(0);
						Expect(libMediaProbe.streamRotation({ tags: { rotate: '90' } })).to.equal(90);
						Expect(libMediaProbe.streamBitDepth({ pix_fmt: 'p010le' })).to.equal(10);
						Expect(libMediaProbe.streamBitDepth({ pix_fmt: 'yuv420p12le' })).to.equal(12);
						Expect(libMediaProbe.streamBitDepth({ pix_fmt: 'yuv420p' })).to.equal(8);
						Expect(libMediaProbe.classifyTransfer('smpte2084')).to.equal('pq');
						Expect(libMediaProbe.classifyTransfer('arib-std-b67')).to.equal('hlg');
						Expect(libMediaProbe.classifyTransfer('bt709')).to.equal('sdr');
					}
				);
			}
		);

		suite
		(
			'LadderPlanner.planLadder',
			() =>
			{
				test
				(
					'landscape 4K HLG 100 fps with audio: four rungs, 50 fps, tone-map after fps+scale, 540p first',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('dji-4k-hlg-100fps-audio'), {});
						Expect(tmpPlan.Orientation).to.equal('landscape');
						Expect(tmpPlan.Rungs.map((pRung) => pRung.ShortSide)).to.deep.equal([1080, 720, 540, 360]);
						Expect(tmpPlan.Rungs.map((pRung) => `${pRung.Width}x${pRung.Height}`)).to.deep.equal(['1920x1080', '1280x720', '960x540', '640x360']);
						Expect(tmpPlan.Rungs.map((pRung) => pRung.MaxRate)).to.deep.equal([6000, 3000, 2000, 730]);
						Expect(tmpPlan.Rungs.map((pRung) => pRung.BufSize)).to.deep.equal([12000, 6000, 4000, 1460]);
						Expect(tmpPlan.FrameRate.Output).to.equal('50/1');
						Expect(tmpPlan.KeyframeInterval).to.equal(100);
						Expect(tmpPlan.Colour.Mode).to.equal('hlg-hable');
						Expect(tmpPlan.Colour.TagBT709).to.equal(true);
						Expect(tmpPlan.Audio.Enabled).to.equal(true);
						Expect(tmpPlan.FirstVariantIndex).to.equal(2);
						Expect(tmpPlan.Video.Encoder).to.equal('libx264');
						Expect(tmpPlan.Video.Preset).to.equal('medium');
						Expect(tmpPlan.Warnings).to.deep.equal([]);

						let tmpGraph = libLadderPlanner.buildFilterGraph(tmpPlan);
						let tmpFps = tmpGraph.indexOf('fps=50/1');
						let tmpScale = tmpGraph.indexOf('scale=1920:1080');
						let tmpToneMap = tmpGraph.indexOf('zscale=t=linear');
						let tmpSplit = tmpGraph.indexOf('split=4');
						Expect(tmpFps).to.be.above(-1);
						Expect(tmpScale).to.be.above(tmpFps);
						Expect(tmpToneMap).to.be.above(tmpScale);
						Expect(tmpSplit).to.be.above(tmpToneMap);
						Expect(tmpGraph).to.contain('setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc');
						Expect(tmpGraph).to.contain('tonemap=hable:desat=0');
						Expect(tmpGraph).to.contain('[s1]scale=-2:720[v1]');
						Expect(tmpGraph).to.contain('[s3]scale=-2:360[v3]');
					}
				);
				test
				(
					'the encode arguments carry the single-pass HLS contract',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('dji-4k-hlg-100fps-audio'), {});
						let tmpArguments = libLadderPlanner.buildEncodeArguments(tmpPlan, '/footage/in.mp4');
						Expect(argumentAfter(tmpArguments, '-hwaccel')).to.equal('videotoolbox');
						Expect(tmpArguments.indexOf('-hwaccel')).to.be.below(tmpArguments.indexOf('-i'));
						Expect(argumentAfter(tmpArguments, '-map_metadata')).to.equal('-1');
						Expect(argumentAfter(tmpArguments, '-map_chapters')).to.equal('-1');
						Expect(argumentAfter(tmpArguments, '-fflags')).to.equal('+bitexact');
						Expect(argumentAfter(tmpArguments, '-hls_segment_type')).to.equal('fmp4');
						Expect(argumentAfter(tmpArguments, '-hls_flags')).to.equal('single_file+independent_segments');
						Expect(argumentAfter(tmpArguments, '-hls_segment_filename')).to.equal('v%v/media.mp4');
						Expect(argumentAfter(tmpArguments, '-master_pl_name')).to.equal('master.m3u8');
						Expect(argumentAfter(tmpArguments, '-var_stream_map')).to.equal('v:0,a:0 v:1,a:1 v:2,a:2 v:3,a:3');
						Expect(argumentAfter(tmpArguments, '-hls_time')).to.equal('6');
						Expect(argumentAfter(tmpArguments, '-maxrate:v:0')).to.equal('6000k');
						Expect(argumentAfter(tmpArguments, '-bufsize:v:3')).to.equal('1460k');
						Expect(argumentAfter(tmpArguments, '-c:a')).to.equal('aac');
						Expect(argumentAfter(tmpArguments, '-b:a')).to.equal('128k');
						Expect(argumentAfter(tmpArguments, '-colorspace:v')).to.equal('bt709');
						Expect(tmpArguments.filter((pArgument) => pArgument === '0:a:0').length).to.equal(4);
						Expect(tmpArguments[tmpArguments.length - 1]).to.equal('v%v/index.m3u8');
					}
				);
				test
				(
					'--no-hwaccel drops the VideoToolbox decode',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('source-720p'), { Hwaccel: false });
						Expect(tmpPlan.Decode.Hwaccel).to.equal(null);
						Expect(libLadderPlanner.buildEncodeArguments(tmpPlan, '/in.mp4')).to.not.include('-hwaccel');
					}
				);
				test
				(
					'portrait (rotated 4K phone clip): rungs on the displayed short side, top rung 1080 wide',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('phone-portrait-rotated'), {});
						Expect(tmpPlan.Orientation).to.equal('portrait');
						Expect(tmpPlan.Rungs.map((pRung) => `${pRung.Width}x${pRung.Height}`)).to.deep.equal(['1080x1920', '720x1280', '540x960', '360x640']);
						Expect(tmpPlan.Rungs[1].Filter).to.equal('scale=720:-2');
						Expect(tmpPlan.FrameRate.Output).to.equal('30000/1001');
						Expect(tmpPlan.KeyframeInterval).to.equal(60);
						Expect(libLadderPlanner.buildFilterGraph(tmpPlan)).to.contain('scale=1080:1920');
					}
				);
				test
				(
					'portrait (native 1080x1920): never upscales, top rung is the source',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('phone-portrait-native'), {});
						Expect(tmpPlan.Rungs[0].Width).to.equal(1080);
						Expect(tmpPlan.Rungs[0].Height).to.equal(1920);
						Expect(tmpPlan.Rungs.length).to.equal(4);
					}
				);
				test
				(
					'no-audio drone: video-only variants, no audio maps or codec',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('drone-no-audio'), {});
						Expect(tmpPlan.Audio.Enabled).to.equal(false);
						let tmpArguments = libLadderPlanner.buildEncodeArguments(tmpPlan, '/in.mp4');
						Expect(argumentAfter(tmpArguments, '-var_stream_map')).to.equal('v:0 v:1 v:2 v:3');
						Expect(tmpArguments).to.not.include('0:a:0');
						Expect(tmpArguments).to.not.include('-c:a');
						Expect(tmpPlan.Colour.Mode).to.equal('none');
						Expect(tmpPlan.Warnings).to.deep.equal([]);
					}
				);
				test
				(
					'10-bit SDR warns "possibly D-Log" and does not tone-map',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('dlog-10bit-sdr'), {});
						Expect(tmpPlan.Colour.Mode).to.equal('none');
						Expect(tmpPlan.Warnings).to.include(libLadderPlanner.WARNING_POSSIBLY_DLOG);
						Expect(tmpPlan.Warnings.join(' ')).to.contain('possibly D-Log');
						Expect(tmpPlan.FrameRate.Output).to.equal('25/1');
					}
				);
				test
				(
					'--lut applies lut3d (escaped) instead of warning',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('dlog-10bit-sdr'), { Lut: '/LUTs/DJI D-Log M, Rec.709:v2.cube', LutSha256: 'abc' });
						Expect(tmpPlan.Colour.Mode).to.equal('lut');
						Expect(tmpPlan.Warnings).to.deep.equal([]);
						Expect(tmpPlan.Colour.Filter).to.equal('lut3d=file=/LUTs/DJI D-Log M\\, Rec.709\\\\:v2.cube:interp=tetrahedral');
						Expect(tmpPlan.Colour.Lut.Sha256).to.equal('abc');
						Expect(tmpPlan.Colour.TagBT709).to.equal(true);
					}
				);
				test
				(
					'a 720p source gets 720 / 540 / 360 only',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('source-720p'), {});
						Expect(tmpPlan.Rungs.map((pRung) => pRung.Name)).to.deep.equal(['720p', '540p', '360p']);
						Expect(tmpPlan.FirstVariantIndex).to.equal(1);
						Expect(libLadderPlanner.buildFilterGraph(tmpPlan)).to.contain('split=3');
					}
				);
				test
				(
					'120 fps conforms to 60; --slowmo stretches to 30 and drops the audio',
					() =>
					{
						let tmpConformed = libLadderPlanner.planLadder(loadSummary('slowmo-120fps'), {});
						Expect(tmpConformed.FrameRate.Output).to.equal('60/1');
						Expect(tmpConformed.FrameRate.SlowMotionFactor).to.equal(null);
						Expect(tmpConformed.Audio.Enabled).to.equal(true);
						Expect(tmpConformed.DurationSeconds).to.equal(12.5);

						let tmpSlow = libLadderPlanner.planLadder(loadSummary('slowmo-120fps'), { SlowMotion: true });
						Expect(tmpSlow.FrameRate.Output).to.equal('30/1');
						Expect(tmpSlow.FrameRate.SlowMotionFactor).to.equal('4/1');
						Expect(tmpSlow.DurationSeconds).to.equal(50);
						Expect(tmpSlow.Audio.Enabled).to.equal(false);
						Expect(tmpSlow.Warnings.join(' ')).to.contain('Audio dropped');
						Expect(libLadderPlanner.buildFilterGraph(tmpSlow)).to.contain('[0:v]setpts=PTS*4/1,fps=30/1,');

						let tmpIgnored = libLadderPlanner.planLadder(loadSummary('source-720p'), { SlowMotion: true });
						Expect(tmpIgnored.FrameRate.Output).to.equal('30/1');
						Expect(tmpIgnored.Warnings.join(' ')).to.contain('--slowmo ignored');
					}
				);
				test
				(
					'frame-rate conform keeps NTSC rates exact and divides other high rates',
					() =>
					{
						let tmpSummary = loadSummary('slowmo-120fps');
						tmpSummary.Video.FrameRate = '120000/1001';
						Expect(libLadderPlanner.planLadder(tmpSummary, {}).FrameRate.Output).to.equal('60000/1001');
						Expect(libLadderPlanner.planLadder(tmpSummary, { SlowMotion: true }).FrameRate.Output).to.equal('30000/1001');
						tmpSummary.Video.FrameRate = '240/1';
						Expect(libLadderPlanner.planLadder(tmpSummary, {}).FrameRate.Output).to.equal('60/1');
						tmpSummary.Video.FrameRate = '100/1';
						let tmpSlow = libLadderPlanner.planLadder(tmpSummary, { SlowMotion: true });
						Expect(tmpSlow.FrameRate.SlowMotionFactor).to.equal('10/3');
					}
				);
				test
				(
					'--profile hq raises only the 1080p cap to 7800k',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('dji-4k-hlg-100fps-audio'), { Profile: 'hq' });
						Expect(tmpPlan.Rungs[0].MaxRate).to.equal(7800);
						Expect(tmpPlan.Rungs[0].BufSize).to.equal(15600);
						Expect(tmpPlan.Rungs[1].MaxRate).to.equal(3000);
						Expect(() => libLadderPlanner.planLadder(loadSummary('source-720p'), { Profile: 'ultra' })).to.throw('Unknown profile');
					}
				);
				test
				(
					'--preset overrides x264; --fast switches to h264_videotoolbox',
					() =>
					{
						let tmpPreset = libLadderPlanner.planLadder(loadSummary('source-720p'), { Preset: 'ultrafast' });
						Expect(argumentAfter(libLadderPlanner.buildEncodeArguments(tmpPreset, '/in.mp4'), '-preset')).to.equal('ultrafast');
						Expect(() => libLadderPlanner.planLadder(loadSummary('source-720p'), { Preset: 'warp9' })).to.throw('Unknown x264 preset');

						let tmpFast = libLadderPlanner.planLadder(loadSummary('source-720p'), { Fast: true });
						let tmpArguments = libLadderPlanner.buildEncodeArguments(tmpFast, '/in.mp4');
						Expect(argumentAfter(tmpArguments, '-c:v')).to.equal('h264_videotoolbox');
						Expect(tmpArguments).to.not.include('-crf');
						Expect(tmpArguments).to.not.include('-sc_threshold');
						Expect(argumentAfter(tmpArguments, '-b:v:0')).to.equal('2400k');
						Expect(argumentAfter(tmpArguments, '-maxrate:v:0')).to.equal('3000k');
					}
				);
				test
				(
					'segment seconds: default 6, odd lengths key every second, bad values throw',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('source-720p'), { SegmentSeconds: 3 });
						Expect(tmpPlan.SegmentSeconds).to.equal(3);
						Expect(tmpPlan.KeyframeSeconds).to.equal(1);
						Expect(tmpPlan.KeyframeInterval).to.equal(30);
						Expect(() => libLadderPlanner.planLadder(loadSummary('source-720p'), { SegmentSeconds: 0 })).to.throw('SegmentSeconds');
					}
				);
				test
				(
					'a source smaller than 360p gets one rung at its own (even) size',
					() =>
					{
						let tmpSummary = loadSummary('source-720p');
						tmpSummary.Video.DisplayWidth = 427;
						tmpSummary.Video.DisplayHeight = 241;
						let tmpPlan = libLadderPlanner.planLadder(tmpSummary, {});
						Expect(tmpPlan.Rungs.length).to.equal(1);
						Expect(tmpPlan.Rungs[0].ShortSide).to.equal(240);
						Expect(tmpPlan.FirstVariantIndex).to.equal(0);
						Expect(libLadderPlanner.buildFilterGraph(tmpPlan)).to.match(/format=yuv420p\[v0\]$/);
					}
				);
				test
				(
					'no video stream throws',
					() =>
					{
						Expect(() => libLadderPlanner.planLadder({ HasVideo: false, Video: null }, {})).to.throw('no video stream');
					}
				);
				test
				(
					'even scaling matches ffmpeg -2 rounding and the first-variant rule',
					() =>
					{
						Expect(libLadderPlanner.evenScaledLongSide(720, 1920, 1080)).to.equal(1280);
						Expect(libLadderPlanner.evenScaledLongSide(540, 1920, 1080)).to.equal(960);
						Expect(libLadderPlanner.evenScaledLongSide(1080, 4096, 2160)).to.equal(2048);
						Expect(libLadderPlanner.chooseFirstVariantIndex([{ ShortSide: 1080 }, { ShortSide: 720 }, { ShortSide: 540 }, { ShortSide: 360 }])).to.equal(2);
						Expect(libLadderPlanner.chooseFirstVariantIndex([{ ShortSide: 720 }, { ShortSide: 360 }])).to.equal(1);
						Expect(libLadderPlanner.chooseFirstVariantIndex([{ ShortSide: 720 }])).to.equal(0);
					}
				);
			}
		);
	}
);
