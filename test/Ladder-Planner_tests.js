/**
* Unit tests for the pure probe summary and the LadderPlanner.
*
* Driven entirely by ffprobe JSON fixtures in test/fixtures/ -- no ffmpeg runs.
* Also the macOS-only `Fast` check at the ladder's entry points (the probe
* stubbed with a fixture, the host platform overridden), and the `plan`
* command line: POSIX quoting kept byte-for-byte, and the Windows line read
* back the way cmd.exe and then the Microsoft C runtime's argv parser read
* it.
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

/**
 * What cmd.exe hands an external program for a typed or pasted line: it
 * turns a quoted run on and off at every " (a backslash means nothing to
 * it); outside one, ^ escapes the next character (and is removed), and an
 * unescaped & | < > ( ) would be acted on -- a redirect, a pipe, a second
 * command -- so it fails the test.  % is left alone (the line never names
 * a defined variable).
 *
 * @param {string} pLine
 * @returns {string}
 */
function cmdPassThrough(pLine)
{
	let tmpOutput = '';
	let tmpQuoted = false;
	for (let i = 0; i < pLine.length; i++)
	{
		let tmpCharacter = pLine[i];
		if (tmpCharacter === '"')
		{
			tmpQuoted = !tmpQuoted;
		}
		else if (!tmpQuoted && tmpCharacter === '^')
		{
			i++;
			if (i >= pLine.length)
			{
				throw new Error('cmd.exe would read a trailing ^ as a line continuation.');
			}
			tmpOutput += pLine[i];
			continue;
		}
		else if (!tmpQuoted && '&|<>()'.indexOf(tmpCharacter) >= 0)
		{
			throw new Error(`cmd.exe would act on the unquoted ${tmpCharacter} at ${i} in: ${pLine}`);
		}
		tmpOutput += tmpCharacter;
	}
	return tmpOutput;
}

/**
 * The program cmd.exe looks for on a line: a quoted run at the start (the
 * quotes removed), else everything up to the first space, tab, comma,
 * semicolon or equals sign, which cmd ends a bare program name at.  A / in
 * a bare program name fails the test: cmd can read it as a switch.
 *
 * @param {string} pLine
 * @returns {string}
 */
function cmdProgramToken(pLine)
{
	if (pLine[0] === '"')
	{
		return pLine.slice(1, pLine.indexOf('"', 1));
	}
	let tmpProgram = /^[^ \t,;=]*/.exec(pLine)[0];
	if (tmpProgram.indexOf('/') >= 0)
	{
		throw new Error(`cmd.exe may read the / in the bare program ${tmpProgram} as a switch.`);
	}
	return tmpProgram;
}

/**
 * The Microsoft C runtime's argv parser (CommandLineToArgvW reads a line
 * the same way, and ffmpeg.exe reads its arguments with that): argv[0] runs
 * to the closing quote (or to whitespace) with no escapes; after it,
 * arguments split on unquoted spaces and tabs, " turns a quoted run on and
 * off, 2n backslashes before a " are n backslashes (the " still counts),
 * 2n+1 are n and a literal ", and backslashes anywhere else are literal.  A
 * doubled "" inside a quoted run is read differently by different runtimes,
 * so a line that needs one fails the test.
 *
 * @param {string} pLine
 * @returns {Array<string>}
 */
function parseWindowsCommandLine(pLine)
{
	let i = 0;
	let tmpProgram = '';
	if (pLine[0] === '"')
	{
		i = 1;
		while (i < pLine.length && pLine[i] !== '"')
		{
			tmpProgram += pLine[i++];
		}
		i++;
	}
	else
	{
		while (i < pLine.length && pLine[i] !== ' ' && pLine[i] !== '\t')
		{
			tmpProgram += pLine[i++];
		}
	}
	let tmpArguments = [tmpProgram];
	let tmpCurrent = null;
	let tmpQuoted = false;
	while (i < pLine.length)
	{
		let tmpCharacter = pLine[i];
		if ((tmpCharacter === ' ' || tmpCharacter === '\t') && !tmpQuoted)
		{
			if (tmpCurrent !== null)
			{
				tmpArguments.push(tmpCurrent);
				tmpCurrent = null;
			}
			i++;
			continue;
		}
		if (tmpCurrent === null)
		{
			tmpCurrent = '';
		}
		if (tmpCharacter === '\\')
		{
			let tmpBackslashes = 0;
			while (pLine[i] === '\\')
			{
				tmpBackslashes++;
				i++;
			}
			if (pLine[i] !== '"')
			{
				tmpCurrent += '\\'.repeat(tmpBackslashes);
				continue;
			}
			tmpCurrent += '\\'.repeat(Math.floor(tmpBackslashes / 2));
			if (tmpBackslashes % 2 === 1)
			{
				tmpCurrent += '"';
				i++;
			}
			continue;
		}
		if (tmpCharacter === '"')
		{
			if (tmpQuoted && pLine[i + 1] === '"')
			{
				throw new Error(`The line needs a doubled "" inside a quoted run at ${i}: ${pLine}`);
			}
			tmpQuoted = !tmpQuoted;
			i++;
			continue;
		}
		tmpCurrent += tmpCharacter;
		i++;
	}
	if (tmpQuoted)
	{
		throw new Error(`The line ends inside a quoted run: ${pLine}`);
	}
	if (tmpCurrent !== null)
	{
		tmpArguments.push(tmpCurrent);
	}
	return tmpArguments;
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

		suite
		(
			'formatCommandLine: the plan command line, for a POSIX shell or for cmd.exe',
			() =>
			{
				// Arguments each quoting rule has to get right: empty, spaces and tabs, quotes, backslashes before a
				// quote and at the end, cmd's metacharacters (alone, and after an argument whose own \" flips cmd's
				// quoted state), a UNC path, %, and the filter-graph characters.
				const TRICKY_ARGUMENTS =
				[
					'', 'plain', 'two words', 'tab\there', 'quote"inside', 'trailing\\', 'trailing space\\', 'C:\\dir with space\\',
					'back\\\\"slash', '\\\\server\\share\\in.mp4', 'a&b|c<d>e^f(g)', '"', '\\"', 'a"b', 'c&d (e)', '100%',
					'x"&y"|z', '""', '\\\\', 'end\\\\ "', '[0:v]scale=-2:720,split=2[s0][s1];[s0]null[v0]', "it's", 'x$y'
				];

				test
				(
					'POSIX quoting is byte-for-byte 1.0.0\'s, and the default anywhere but Windows',
					() =>
					{
						let tmpPlan = libLadderPlanner.planLadder(loadSummary('source-720p'), { Lut: "/footage/it's,[odd];.cube" });
						let tmpArguments = libLadderPlanner.buildEncodeArguments(tmpPlan, '/footage/DJI 0001 (copy).MP4');
						// What 1.0.0 printed for this plan.
						let tmpExpected = String.raw`'/opt/ffmpeg 7/bin/ffmpeg' -hide_banner -nostdin -y -loglevel warning -hwaccel videotoolbox -i '/footage/DJI 0001 (copy).MP4' -filter_complex '[0:v]fps=30/1,scale=1280:720,setsar=1,lut3d=file=/footage/it\\\'\''s\,\[odd\]\;.cube:interp=tetrahedral,format=yuv420p,split=3[s0][s1][s2];[s0]null[v0];[s1]scale=-2:540[v1];[s2]scale=-2:360[v2]' -map '[v0]' -map '[v1]' -map '[v2]' -map 0:a:0 -map 0:a:0 -map 0:a:0 -map_metadata -1 -map_chapters -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -c:v libx264 -preset medium -profile:v high -crf 21 -sc_threshold 0 -g 60 -keyint_min 60 -force_key_frames 'expr:gte(t,n_forced*2)' -maxrate:v:0 3000k -bufsize:v:0 6000k -maxrate:v:1 2000k -bufsize:v:1 4000k -maxrate:v:2 730k -bufsize:v:2 1460k -color_primaries:v bt709 -color_trc:v bt709 -colorspace:v bt709 -color_range:v tv -c:a aac -b:a 128k -ac 2 -f hls -hls_time 6 -hls_playlist_type vod -hls_flags single_file+independent_segments -hls_segment_type fmp4 -hls_segment_filename v%v/media.mp4 -master_pl_name master.m3u8 -var_stream_map 'v:0,a:0 v:1,a:1 v:2,a:2' v%v/index.m3u8`;
						[undefined, 'darwin', 'linux', 'freebsd'].forEach((pPlatform) =>
							{
								Expect(libLadderPlanner.formatCommandLine('/opt/ffmpeg 7/bin/ffmpeg', tmpArguments, pPlatform), String(pPlatform)).to.equal(tmpExpected);
							});
						Expect(libLadderPlanner.formatCommandLine('ffmpeg', ['', 'a b', "it's", 'x$y', '\\'])).to.equal(String.raw`ffmpeg '' 'a b' 'it'\''s' 'x$y' '\'`);
					}
				);

				test
				(
					'win32: cmd.exe and then the C runtime\'s argv parser read every tricky argument back intact; plain ones stay bare',
					() =>
					{
						let tmpLine = libLadderPlanner.formatCommandLine('ffmpeg', TRICKY_ARGUMENTS, 'win32');
						Expect(parseWindowsCommandLine(cmdPassThrough(tmpLine))).to.deep.equal(['ffmpeg'].concat(TRICKY_ARGUMENTS));
						// Each argument on its own, too (so cmd's quoted state starts afresh for each).
						TRICKY_ARGUMENTS.forEach((pArgument) =>
							{
								let tmpOne = libLadderPlanner.formatCommandLine('ffmpeg', ['-i', pArgument, '-f', 'a&b'], 'win32');
								Expect(parseWindowsCommandLine(cmdPassThrough(tmpOne)), tmpOne).to.deep.equal(['ffmpeg', '-i', pArgument, '-f', 'a&b']);
							});
						// Readable: nothing is quoted that does not need it; a Windows path keeps its backslashes.
						Expect(libLadderPlanner.formatCommandLine('ffmpeg', ['-i', 'C:\\in.mp4', '-filter_complex', '[0:v]scale=-2:720[v0]', 'v%v/media.mp4', 'two words', '', 'expr:gte(t,n_forced*2)'], 'win32'))
							.to.equal('ffmpeg -i C:\\in.mp4 -filter_complex [0:v]scale=-2:720[v0] v%v/media.mp4 "two words" "" "expr:gte(t,n_forced*2)"');
						// A quote inside an argument flips cmd's state, so what follows it gets carets.
						Expect(libLadderPlanner.formatCommandLine('ffmpeg', ['a"b', 'c&d'], 'win32')).to.equal('ffmpeg "a\\"b" "c^&d"');
						Expect(libLadderPlanner.formatCommandLine('ffmpeg', ['C:\\dir with space\\'], 'win32')).to.equal('ffmpeg "C:\\dir with space\\\\"');
					}
				);

				test
				(
					'win32: an ffmpeg path cmd.exe would cut short (a , ; or = in it, or a /) is quoted and goes between the quotes as it is; a plain one stays bare',
					() =>
					{
						['C:\\ffmpeg,7.1\\bin\\ffmpeg.exe', 'C:\\ffmpeg;x\\ffmpeg.exe', 'C:\\build=full\\ffmpeg.exe', 'C:/ffmpeg/bin/ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\tools (x86)\\ffmpeg.exe', 'C:\\a&b\\ffmpeg.exe'].forEach((pProgram) =>
							{
								let tmpLine = libLadderPlanner.formatCommandLine(pProgram, ['-i', 'in.mp4'], 'win32');
								Expect(tmpLine, pProgram).to.equal(`"${pProgram}" -i in.mp4`);
								Expect(cmdProgramToken(tmpLine), pProgram).to.equal(pProgram);
								Expect(parseWindowsCommandLine(cmdPassThrough(tmpLine)), pProgram).to.deep.equal([pProgram, '-i', 'in.mp4']);
							});
						['ffmpeg', 'ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'D:\\tools\\ffmpeg-7.1_full\\ffmpeg.exe'].forEach((pProgram) =>
							{
								let tmpLine = libLadderPlanner.formatCommandLine(pProgram, ['-i', 'in.mp4'], 'win32');
								Expect(tmpLine, pProgram).to.equal(`${pProgram} -i in.mp4`);
								Expect(cmdProgramToken(tmpLine), pProgram).to.equal(pProgram);
								Expect(parseWindowsCommandLine(cmdPassThrough(tmpLine)), pProgram).to.deep.equal([pProgram, '-i', 'in.mp4']);
							});
						// The 1.0.0-style line, which left these bare, is what cmd.exe cuts short.
						Expect(cmdProgramToken('C:\\ffmpeg,7.1\\bin\\ffmpeg.exe -i in.mp4')).to.equal('C:\\ffmpeg');
					}
				);

				test
				(
					'win32: a whole ladder command -- a spaced ffmpeg.exe path, a LUT like C:\\x\\it\'s,[odd];.cube, an input with & and parentheses -- reaches ffmpeg.exe intact',
					() =>
					{
						let tmpFFmpeg = 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe';
						['source-720p', 'dji-4k-hlg-100fps-audio', 'drone-no-audio'].forEach((pFixture) =>
							{
								let tmpPlan = libLadderPlanner.planLadder(loadSummary(pFixture), { Lut: "C:\\x\\it's,[odd];.cube", Hwaccel: false });
								let tmpArguments = libLadderPlanner.buildEncodeArguments(tmpPlan, 'C:\\footage\\DJI 0001 (copy) & more.MP4');
								let tmpLine = libLadderPlanner.formatCommandLine(tmpFFmpeg, tmpArguments, 'win32');
								Expect(parseWindowsCommandLine(cmdPassThrough(tmpLine)), pFixture).to.deep.equal([tmpFFmpeg].concat(tmpArguments));
								Expect(tmpLine.indexOf(`"${tmpFFmpeg}" `), pFixture).to.equal(0);
								// No argument holds a quote, so quoting alone keeps cmd off every metacharacter: no carets.
								Expect(tmpLine, pFixture).to.not.contain('^');
								Expect(tmpLine, pFixture).to.contain(' -force_key_frames "expr:gte(t,n_forced*2)" ');
								// The graph needs no quotes for ffmpeg.exe: its escaped LUT path goes through as it is.
								Expect(tmpLine, pFixture).to.contain(` -filter_complex ${libLadderPlanner.buildFilterGraph(tmpPlan)} `);
							});
					}
				);
			}
		);

		suite
		(
			'Fast is macOS-only',
			() =>
			{
				let libTools = require('../source/Media-Ladder-Tools.js');
				let tmpRealSha256File = libTools.sha256File;

				// The refusal test counts hashes by wrapping the shared helper: put it back even when that test
				// fails or times out, so no later suite hashes through the wrapper.
				teardown
				(
					() =>
					{
						libTools.sha256File = tmpRealSha256File;
					}
				);

				test
				(
					'fastUnavailableReason: null on macOS, the same clear reason anywhere else; the plan never looks at the host',
					() =>
					{
						Expect(libLadderPlanner.fastUnavailableReason('darwin')).to.equal(null);
						['linux', 'win32', 'freebsd'].forEach((pPlatform) =>
							{
								Expect(libLadderPlanner.fastUnavailableReason(pPlatform), pPlatform).to.equal('Fast encoding (--fast / Fast: true) uses h264_videotoolbox, which is only available on macOS.');
							});
						Expect(libLadderPlanner.planLadder(loadSummary('source-720p'), { Fast: true }).Video.Encoder).to.equal('h264_videotoolbox');
					}
				);

				test
				(
					'encode and plan refuse Fast off macOS before probing or hashing anything; on macOS they go ahead',
					(fDone) =>
					{
						let libRetoldMediaLadder = require('../source/Retold-Media-Ladder.js');
						let fQuiet = () => {};
						let tmpQuietLog = { trace: fQuiet, debug: fQuiet, info: fQuiet, warn: fQuiet, error: fQuiet };
						let tmpReason = 'Fast encoding (--fast / Fast: true) uses h264_videotoolbox, which is only available on macOS.';
						let tmpCalls = { Probe: 0, Hash: 0, Phases: [] };
						let tmpOutput = libPath.join(require('node:os').tmpdir(), `retold-media-ladder-fast-${process.pid}-${Date.now()}`);
						let tmpMissing = libPath.join(tmpOutput, 'no-such-source.mp4');

						// Count every hash (teardown puts the helper back); probe from a fixture (the source does not exist).
						libTools.sha256File = function ()
						{
							tmpCalls.Hash++;
							return tmpRealSha256File.apply(null, arguments);
						};
						let fFinish = (pError) => fDone(pError);
						let fLadder = (pPlatform) =>
						{
							let tmpLadder = new libRetoldMediaLadder({ Log: tmpQuietLog });
							Expect(tmpLadder.platform).to.equal(process.platform);
							tmpLadder.platform = pPlatform;
							tmpLadder.probe = (pInputPath, fCallback) =>
							{
								tmpCalls.Probe++;
								setImmediate(() => fCallback(null, loadSummary('source-720p')));
								return libTools.inertHandle();
							};
							// No ffmpeg runs here: stand in for a capable one (the preflight has its own tests).
							tmpLadder.preflight = (pPlan, pInputPath, fCallback) =>
							{
								setImmediate(() => fCallback(null, { FFmpeg: 'ffmpeg', Version: 'ffmpeg version 7.1', Major: 7, Runnable: true, Required: tmpLadder.ffmpegRequirements(pPlan, pInputPath), Missing: [], Message: null, Warnings: [] }));
								return libTools.inertHandle();
							};
							return tmpLadder;
						};
						let fGuard = (fBody) =>
						{
							return function ()
							{
								try
								{
									return fBody.apply(null, arguments);
								}
								catch (pAssertError)
								{
									return fFinish(pAssertError);
								}
							};
						};

						fLadder('linux').encode(tmpMissing, { OutputDirectory: tmpOutput, Fast: true, onProgress: (pEvent) => tmpCalls.Phases.push(pEvent.Phase) }, fGuard((pError) =>
							{
								Expect(pError).to.be.an('error');
								Expect(pError.message).to.equal(tmpReason);
								Expect(tmpCalls).to.deep.equal({ Probe: 0, Hash: 0, Phases: [] });
								Expect(require('node:fs').existsSync(tmpOutput)).to.equal(false);

								fLadder('win32').plan(tmpMissing, { Fast: true }, fGuard((pPlanError) =>
									{
										Expect(pPlanError.message).to.equal(tmpReason);
										Expect(tmpCalls.Probe).to.equal(0);

										// Off macOS without Fast: x264, and the decode default is software.
										fLadder('linux').plan(tmpMissing, {}, fGuard((pX264Error, pX264) =>
											{
												Expect(pX264Error).to.equal(null);
												Expect(tmpCalls.Probe).to.equal(1);
												Expect(pX264.Plan.Video.Encoder).to.equal('libx264');
												Expect(pX264.Plan.Decode.Hwaccel).to.equal(null);

												fLadder('darwin').plan(tmpMissing, { Fast: true }, fGuard((pMacError, pMac) =>
													{
														Expect(pMacError).to.equal(null);
														Expect(tmpCalls.Probe).to.equal(2);
														Expect(pMac.Plan.Video.Encoder).to.equal('h264_videotoolbox');
														Expect(pMac.Plan.Decode.Hwaccel).to.equal('videotoolbox');

														// On macOS an encode gets past the check: it probes, then fails hashing the missing source.
														fLadder('darwin').encode(tmpMissing, { OutputDirectory: tmpOutput, Fast: true }, fGuard((pMacEncodeError) =>
															{
																Expect(pMacEncodeError).to.be.an('error');
																Expect(pMacEncodeError.message).to.not.contain('only available on macOS');
																Expect(tmpCalls.Probe).to.equal(3);
																Expect(tmpCalls.Hash).to.equal(1);
																return fFinish();
															}));
													}));
											}));
									}));
							}));
					}
				);
			}
		);
	}
);
