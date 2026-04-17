'use strict';

/**
 * StreamEngine
 * ============
 * Manages a single stream: FFmpeg process lifecycle, reconnection state machine,
 * fallback slate injection, exponential backoff, stats parsing, and log buffering.
 *
 * Design philosophy
 * -----------------
 * The Facebook RTMP session must NEVER be dropped unless the user explicitly
 * stops the stream.  When the source becomes unavailable the engine immediately
 * substitutes a synthetic lavfi "Reconnecting…" slate so Facebook keeps the
 * session alive.  A background ffprobe loop tests the real source with
 * exponential backoff; as soon as the source is reachable the fallback is
 * torn down and the real stream is restored — all without interrupting the
 * Facebook session.
 */

const { spawn }       = require('child_process');
const { EventEmitter } = require('events');

// ─── Quality presets ────────────────────────────────────────────────────────

const PRESETS = {
  '480p30': {
    label: '480p 30 fps — Low Bandwidth',
    width: 854, height: 480, fps: 30,
    videoBitrate: 2500, maxrate: 2500, bufsize: 5000,
    audioBitrate: 96,  sampleRate: 44100, channels: 2,
  },
  '720p30': {
    label: '720p 30 fps — Recommended',
    width: 1280, height: 720, fps: 30,
    videoBitrate: 4500, maxrate: 4500, bufsize: 9000,
    audioBitrate: 128, sampleRate: 44100, channels: 2,
  },
  '720p60': {
    label: '720p 60 fps — Gaming',
    width: 1280, height: 720, fps: 60,
    videoBitrate: 6000, maxrate: 6000, bufsize: 12000,
    audioBitrate: 128, sampleRate: 44100, channels: 2,
  },
  '1080p30': {
    label: '1080p 30 fps — High Quality',
    width: 1920, height: 1080, fps: 30,
    videoBitrate: 8000, maxrate: 8000, bufsize: 16000,
    audioBitrate: 192, sampleRate: 44100, channels: 2,
  },
  '1080p60': {
    label: '1080p 60 fps — High Quality Gaming',
    width: 1920, height: 1080, fps: 60,
    videoBitrate: 10000, maxrate: 10000, bufsize: 20000,
    audioBitrate: 192, sampleRate: 44100, channels: 2,
  },
};

// ─── State enum ─────────────────────────────────────────────────────────────

const STATE = {
  IDLE:         'idle',
  STARTING:     'starting',
  STREAMING:    'streaming',
  FALLBACK:     'fallback',
  RECONNECTING: 'reconnecting',
  STOPPING:     'stopping',
  STOPPED:      'stopped',
};

// ─── Constants ───────────────────────────────────────────────────────────────

const FB_RTMP_BASE    = 'rtmp://live-api-s.facebook.com:80/rtmp/';
const BACKOFF_INIT    = 3000;   // 3 s initial retry delay
const BACKOFF_MAX     = 60000;  // 60 s maximum retry delay
const BACKOFF_FACTOR  = 1.6;    // exponential growth factor
const MAX_LOG_LINES   = 600;    // ring-buffer cap
const PROBE_TIMEOUT   = 12000;  // ms before ffprobe attempt is abandoned
const FB_MAX_WIDTH    = 1920;   // Facebook Live recommended max
const FB_MAX_HEIGHT   = 1080;   // Facebook Live recommended max
const FB_MAX_FPS      = 60;     // Facebook Live recommended max

// ─── StreamEngine ────────────────────────────────────────────────────────────

class StreamEngine extends EventEmitter {
  constructor(config) {
    super();
    this.setMaxListeners(100);

    this.config = { ...config };

    // Runtime state
    this.state           = STATE.IDLE;
    this.mainProc        = null;   // child_process of the real source stream
    this.fallbackProc    = null;   // child_process of the slate stream
    this._running        = false;
    this._stopping       = false;

    // Timers
    this._reconnectTimer = null;
    this._fallbackTimer  = null;

    // Metrics
    this.startedAt        = null;
    this.reconnectCount   = 0;
    this._backoff         = BACKOFF_INIT;
    this._runtimeForceReencode = false;
    this._fbOutputFailures = 0;

    // Stats (updated by FFmpeg stderr parser)
    this.stats = {
      fps: 0, bitrate: 0, frames: 0,
      droppedFrames: 0, speed: 0, quality: 0, sizeKb: 0,
    };

    // Log ring-buffer
    this.logs = [];
  }

  // ─── Static accessors ─────────────────────────────────────────────────────

  static get PRESETS() { return PRESETS; }
  static get STATE()   { return STATE;   }

  // ─── Computed properties ──────────────────────────────────────────────────

  get uptime() {
    return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
  }

  get fbRtmpUrl() {
    return FB_RTMP_BASE + this.config.fbStreamKey;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  start() {
    if (this._running) {
      this._log('warn', 'start() called while already running — ignored');
      return;
    }
    this._running  = true;
    this._stopping = false;
    this._backoff  = BACKOFF_INIT;
    this.reconnectCount = 0;
    this._runtimeForceReencode = false;
    this._fbOutputFailures = 0;
    this.startedAt = Date.now();

    this._log('info', `Stream starting — source: ${this.config.sourceUrl}`);
    this._setState(STATE.STARTING);
    this._checkSourceCompatibility(result => {
      if (!this._running) return;
      if (result.compatible) {
        this._launchMain();
        return;
      }
      this.reconnectCount++;
      this._log('warn',
        `Source preflight failed (${result.reason}). ` +
        `Reconnect #${this.reconnectCount} — starting fallback slate…`
      );
      this._launchFallback(true);
    });
  }

  stop() {
    if (this._stopping) return;
    this._stopping = true;
    this._running  = false;

    this._log('info', 'Stop requested — tearing down FFmpeg processes…');
    this._setState(STATE.STOPPING);
    this._clearTimers();

    this._kill(this.mainProc,     'main');
    this._kill(this.fallbackProc, 'fallback');
    this.mainProc     = null;
    this.fallbackProc = null;
    this.startedAt    = null;
    this._resetStats();
    this._setState(STATE.STOPPED);
    this._log('info', 'Stream stopped.');
  }

  restart() {
    this._log('info', 'Restart requested…');
    this.stop();
    setTimeout(() => this.start(), 1500);
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  getStatus() {
    return {
      id:               this.config.id,
      name:             this.config.name,
      state:            this.state,
      uptime:           this.uptime,
      reconnectCount:   this.reconnectCount,
      stats:            { ...this.stats },
      usingFallback:    !!this.fallbackProc,
    };
  }

  getLogs(limit = 200) {
    const l = Math.min(limit, MAX_LOG_LINES);
    return l >= this.logs.length ? [...this.logs] : this.logs.slice(-l);
  }

  // ─── State machine ────────────────────────────────────────────────────────

  _setState(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.emit('stateChange', { streamId: this.config.id, state: next, prevState: prev });
  }

  // ─── Logging ─────────────────────────────────────────────────────────────

  _log(level, msg) {
    const entry = { ts: new Date().toISOString(), level, msg };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_LINES) this.logs.shift();
    this.emit('log', { streamId: this.config.id, ...entry });
  }

  // ─── Timer helpers ────────────────────────────────────────────────────────

  _clearTimers() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._fallbackTimer)  { clearTimeout(this._fallbackTimer);  this._fallbackTimer  = null; }
  }

  // ─── Process kill helper ──────────────────────────────────────────────────

  _kill(proc, label) {
    if (!proc || proc.killed) return;
    try {
      proc.kill('SIGTERM');
      // Escalate to SIGKILL after 4 s if it hasn't exited
      setTimeout(() => {
        try { if (!proc.killed) proc.kill('SIGKILL'); } catch (_) {}
      }, 4000);
    } catch (err) {
      this._log('warn', `Could not kill ${label} process: ${err.message}`);
    }
  }

  // ─── Preset resolution ────────────────────────────────────────────────────

  _resolvePreset() {
    const base = PRESETS[this.config.preset] || PRESETS['720p30'];
    return {
      width:        this.config.customWidth        || base.width,
      height:       this.config.customHeight       || base.height,
      fps:          this.config.customFps          || base.fps,
      videoBitrate: this.config.customVideoBitrate || base.videoBitrate,
      maxrate:      this.config.customVideoBitrate || base.maxrate,
      bufsize:      this.config.customVideoBitrate
                      ? this.config.customVideoBitrate * 2
                      : base.bufsize,
      audioBitrate: this.config.customAudioBitrate || base.audioBitrate,
      sampleRate:   this.config.customSampleRate   || base.sampleRate,
      channels:     this.config.customChannels     || base.channels,
      // New custom FFmpeg properties
      videoCodec:   this.config.customVideoCodec   || 'libx264',
      audioCodec:   this.config.customAudioCodec   || 'aac',
      presetSpeed:  this.config.customPresetSpeed  || 'veryfast',
      tune:         this.config.customTune         || 'zerolatency',
      profile:      this.config.customProfile      || 'main',
      level:        this.config.customLevel        || '4.0',
      keyframeInterval: this.config.customKeyframeInterval || null,
      pixelFormat:  this.config.customPixelFormat  || 'yuv420p',
      colorSpace:   this.config.customColorSpace   || null,
      colorRange:   this.config.customColorRange   || null,
      aspectRatio:  this.config.customAspectRatio  || null,
      frameMode:    this.config.customFrameMode    || 'cfr', // cfr, vfr
      gopSize:      this.config.customGopSize      || null,
      bframes:      this.config.customBframes      ?? null,
      refs:         this.config.customRefs         ?? null,
      scThreshold:  this.config.customScThreshold  ?? 0,
      qpMin:        this.config.customQpMin        ?? null,
      qpMax:        this.config.customQpMax        ?? null,
      crf:          this.config.customCrf          ?? null,
      rateControl:  this.config.customRateControl  || 'vbr', // vbr, cbr, crf
      audioSampleFmt: this.config.customAudioSampleFmt || null,
      deinterlace:  this.config.customDeinterlace  || false,
      denoise:      this.config.customDenoise      || false,
      sharpen:      this.config.customSharpen      || false,
      extraInputOpts: this.config.customExtraInputOpts || [],
      extraOutputOpts: this.config.customExtraOutputOpts || [],
      videoFilterChain: this.config.customVideoFilterChain || [],
      audioFilterChain: this.config.customAudioFilterChain || [],
    };
  }

  // ─── FFmpeg argument builders ─────────────────────────────────────────────

  /**
   * Arguments for streaming the real source to Facebook.
   * Heavily hardened against network instability, bad timestamps, missing
   * streams and codec errors.
   */
  _buildMainArgs() {
    const p = this._resolvePreset();
    const copyMode = this.config.encodingMode === 'copy' && !this._runtimeForceReencode;
    const fpsMode = (p.frameMode === 'vfr') ? 'vfr' : 'cfr';
    const videoCodec = copyMode ? 'copy' : (p.videoCodec || 'libx264');
    const audioCodec = copyMode ? 'copy' : (p.audioCodec || 'aac');

    const args = [
      '-hide_banner',

      // ── Input resilience for network sources ──────────────────────────────
      '-reconnect',           '1',
      '-reconnect_at_eof',    '1',
      '-reconnect_streamed',  '1',
      '-reconnect_delay_max', '5',

      // Socket / read-write timeout (10 s, expressed in microseconds)
      '-timeout',    '10000000',
      '-rw_timeout', '10000000',

      // Give FFmpeg time to probe messed-up IPTV streams
      '-analyzeduration', '10000000',
      '-probesize',       '10000000',

      // ── Error-tolerance input flags ───────────────────────────────────────
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-flags',  '+low_delay',
      '-err_detect', 'ignore_err',
      '-use_wallclock_as_timestamps', '1',

      // ── Logging ───────────────────────────────────────────────────────────
      '-loglevel', 'warning',
      '-stats',

      // ── Input ─────────────────────────────────────────────────────────────
      '-i', this.config.sourceUrl,
    ];

    if (copyMode) {
      args.push('-c:v', 'copy', '-c:a', 'copy');
    } else {
      // ── Video filter chain ────────────────────────────────────────────────
      args.push('-vf', [
        `fps=${p.fps}`,
        `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease`,
        `pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'setsar=1',
        `format=${p.pixelFormat || 'yuv420p'}`,
      ].join(','));

      // ── Video encoder ─────────────────────────────────────────────────────
      args.push('-c:v', videoCodec);
      if (videoCodec === 'libx264') {
        args.push('-preset', p.presetSpeed || 'veryfast');
        if (p.tune) args.push('-tune', p.tune);
        if (p.profile) args.push('-profile:v', p.profile);
        if (p.level) args.push('-level:v', p.level);
      }
      if (p.rateControl === 'crf' && p.crf != null) {
        args.push('-crf', String(p.crf));
      } else {
        args.push('-b:v', `${p.videoBitrate}k`, '-maxrate', `${p.maxrate}k`, '-bufsize', `${p.bufsize}k`);
      }
      args.push('-g', String(p.gopSize || (p.fps * 2)));
      args.push('-keyint_min', String(p.keyframeInterval || p.fps));
      args.push('-sc_threshold', String(p.scThreshold ?? 0));
      args.push('-r', String(p.fps));
      args.push('-fps_mode', fpsMode);

      // ── Audio encoder ─────────────────────────────────────────────────────
      args.push('-c:a', audioCodec);
      if (audioCodec !== 'copy') {
        args.push('-af', 'aresample=async=1:first_pts=0');
        args.push('-b:a', `${p.audioBitrate}k`, '-ar', String(p.sampleRate), '-ac', String(p.channels));
      }
    }

    // ── Output ──────────────────────────────────────────────────────────────
    args.push('-f', 'flv', this.fbRtmpUrl);
    return args;
  }

  /**
   * Arguments for a synthetic "Reconnecting…" slate.
   * Uses lavfi color + anullsrc so it never depends on any external resource.
   * withText = false is the safe fallback when drawtext (libfreetype) is absent.
   */
  _buildFallbackArgs(withText) {
    const p = this._resolvePreset();

    const textFilter = withText
      ? `,drawtext=text='RECONNECTING':fontsize=${Math.floor(p.height / 18)}` +
        `:fontcolor=white@0.80:x=(w-text_w)/2:y=(h-text_h)/2-${Math.floor(p.height / 12)}` +
        `,drawtext=text='Stream will resume automatically':fontsize=${Math.floor(p.height / 32)}` +
        `:fontcolor=gray@0.70:x=(w-text_w)/2:y=(h-text_h)/2+${Math.floor(p.height / 18)}`
      : '';

    return [
      '-hide_banner',
      '-loglevel', 'warning',
      '-stats',

      // Synthetic video: dark slate at exactly the target resolution & fps
      '-f', 'lavfi',
      '-i', `color=c=0x0d1117:size=${p.width}x${p.height}:rate=${p.fps}`,

      // Synthetic silence
      '-f', 'lavfi',
      '-i', `anullsrc=r=${p.sampleRate}:cl=stereo`,

      '-vf', `setsar=1,format=yuv420p${textFilter}`,

      '-c:v',        'libx264',
      '-preset',     'ultrafast',
      '-tune',       'zerolatency',
      '-b:v',        '900k',
      '-maxrate',    '900k',
      '-bufsize',    '1800k',
      '-g',          String(p.fps * 2),
      '-r',          String(p.fps),
      '-fps_mode',   'cfr',

      '-c:a', 'aac',
      '-b:a', '64k',
      '-ar',  String(p.sampleRate),
      '-ac',  String(p.channels),

      '-f',   'flv',
      this.fbRtmpUrl,
    ];
  }

  // ─── Main stream launch ───────────────────────────────────────────────────

  _launchMain() {
    if (!this._running) return;

    this._log('info', 'Launching FFmpeg → main stream');
    const args = this._buildMainArgs();
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.mainProc = proc;
    this._setState(STATE.STREAMING);

    let buf = '';
    proc.stderr.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (t) this._parseStderrLine(t);
      }
    });

    proc.on('error', err => this._log('error', `FFmpeg spawn error: ${err.message}`));

    proc.on('exit', (code, signal) => {
      if (!this._running)            return;
      if (this.mainProc !== proc)    return; // stale reference — ignore
      this.mainProc = null;
      this.reconnectCount++;
      this._resetStats();
      this._log('warn',
        `Main stream exited (code=${code ?? '?'} signal=${signal ?? 'none'}).` +
        ` Reconnect #${this.reconnectCount} — starting fallback slate…`
      );
      this._launchFallback(true);
    });
  }

  // ─── Fallback slate ───────────────────────────────────────────────────────

  _launchFallback(withText) {
    if (!this._running) return;

    this._setState(STATE.FALLBACK);
    this._log('info', `Launching FFmpeg → fallback slate (drawtext=${withText})`);

    const args = this._buildFallbackArgs(withText);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.fallbackProc = proc;

    // Track whether this instance survives long enough to be considered stable
    let stableTimer = setTimeout(() => { stableTimer = null; }, 4000);

    proc.stderr.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const l of lines) {
        const t = l.trim();
        if (!t || /^frame=/.test(t)) continue;
        this._noteFacebookOutputFailure(t);
        if (/error|invalid|fail/i.test(t)) this._log('warn', `[slate] ${t}`);
      }
    });

    proc.on('error', err => this._log('error', `Fallback spawn error: ${err.message}`));

    proc.on('exit', (code, signal) => {
      if (!this._running)               return;
      if (this.fallbackProc !== proc)   return;
      this.fallbackProc = null;

      // Died before stable: drawtext failed — retry with plain color
      if (stableTimer && withText) {
        clearTimeout(stableTimer);
        this._log('warn', 'Slate with text died immediately — retrying plain color slate');
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        this._launchFallback(false);
        return;
      }

      this._log('warn', `Fallback slate exited (code=${code ?? '?'}) — restarting in 2 s…`);
      this._fallbackTimer = setTimeout(() => {
        if (this._running) this._launchFallback(false);
      }, 2000);
    });

    // Start probing source in background
    this._scheduleProbe();
  }

  // ─── Source probe / reconnect loop ───────────────────────────────────────

  _scheduleProbe() {
    if (!this._running) return;
    const delay = Math.min(this._backoff, BACKOFF_MAX);
    this._log('info',
      `Source probe in ${(delay / 1000).toFixed(1)} s ` +
      `(backoff=${(delay / 1000).toFixed(1)} s, attempt #${this.reconnectCount})`
    );
    this._setState(STATE.RECONNECTING);

    this._reconnectTimer = setTimeout(() => {
      if (!this._running) return;
      this._checkSourceCompatibility(result => {
        if (!this._running) return;
        if (result.compatible) {
          this._log('info', 'Source is reachable and compatible — switching back to main stream…');
          this._backoff = BACKOFF_INIT; // reset

          // Tear down the fallback and give the RTMP endpoint ~900 ms
          // to release the connection before we reconnect with the real feed.
          const staleProc = this.fallbackProc;
          this.fallbackProc = null;
          this._kill(staleProc, 'fallback');
          if (this._fallbackTimer) { clearTimeout(this._fallbackTimer); this._fallbackTimer = null; }

          setTimeout(() => { if (this._running) this._launchMain(); }, 900);
        } else {
          this._log('warn', `Source probe failed compatibility check: ${result.reason}`);
          // Grow backoff & stay on fallback
          this._backoff = Math.min(this._backoff * BACKOFF_FACTOR, BACKOFF_MAX);
          this._setState(STATE.FALLBACK);
          this._scheduleProbe();
        }
      });
    }, delay);
  }

  _checkSourceCompatibility(cb) {
    const args = [
      '-v',             'error',
      '-timeout',       '8000000',
      '-rw_timeout',    '8000000',
      '-analyzeduration','2000000',
      '-probesize',     '500000',
      '-show_entries',  'stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels',
      '-of',            'json',
      this.config.sourceUrl,
    ];

    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => { out += d; });

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { if (!proc.killed) proc.kill(); } catch (_) {}
      cb(result);
    };

    proc.on('exit', code => {
      if (code !== 0 || out.trim().length === 0) {
        finish({ compatible: false, reason: 'ffprobe failed to read source' });
        return;
      }

      try {
        const parsed = JSON.parse(out);
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const video = streams.find(s => s.codec_type === 'video');
        if (!video) {
          finish({ compatible: false, reason: 'no video stream detected' });
          return;
        }

        const width = Number(video.width) || 0;
        const height = Number(video.height) || 0;
        const fps = this._parseFps(video.r_frame_rate);
        if (width > FB_MAX_WIDTH || height > FB_MAX_HEIGHT || fps > FB_MAX_FPS) {
          this._log('warn',
            `Source exceeds Facebook guidelines (${width}x${height} @ ${fps}fps). ` +
            'Output will be normalized by transcoding.'
          );
        }

        const audio = streams.find(s => s.codec_type === 'audio');
        if (!audio) {
          this._log('warn', 'Source has no audio stream — synthetic silence will be used by encoder.');
        }

        finish({ compatible: true, reason: 'ok' });
      } catch (_) {
        finish({ compatible: false, reason: 'invalid ffprobe metadata' });
      }
    });
    proc.on('error', ()  => finish({ compatible: false, reason: 'ffprobe spawn error' }));
    setTimeout(()        => finish({ compatible: false, reason: 'ffprobe timed out' }), PROBE_TIMEOUT);
  }

  _parseFps(value) {
    if (!value || typeof value !== 'string') return 0;
    if (!value.includes('/')) {
      const asNum = Number(value);
      return Number.isFinite(asNum) ? asNum : 0;
    }
    const [n, d] = value.split('/').map(Number);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
    return n / d;
  }

  // ─── Stats reset ─────────────────────────────────────────────────────────

  _resetStats() {
    this.stats = { fps: 0, bitrate: 0, frames: 0, droppedFrames: 0, speed: 0, quality: 0, sizeKb: 0 };
  }

  // ─── FFmpeg stderr parser ────────────────────────────────────────────────

  /**
   * FFmpeg writes a single re-written stats line like:
   *   frame= 1200 fps= 30 q=28.0 size=  20480kB time=00:00:40.00 bitrate=4096.0kbits/s dup=0 drop=2 speed=1.00x
   * Everything else is a log message.
   */
  _parseStderrLine(line) {
    // Stats line
    if (/^frame=/.test(line)) {
      const g = (re) => { const m = line.match(re); return m ? m[1] : null; };

      const frames   = g(/frame=\s*(\d+)/);
      const fps      = g(/fps=\s*([\d.]+)/);
      const quality  = g(/q=([\d.-]+)/);
      const sizeKb   = g(/size=\s*([\d.]+)kB/);
      const bitrate  = g(/bitrate=\s*([\d.]+)kbits\/s/);
      const dropped  = g(/drop=\s*(\d+)/);
      const speed    = g(/speed=\s*([\d.]+)x/);

      if (frames  !== null) this.stats.frames       = parseInt(frames,  10);
      if (fps     !== null) this.stats.fps           = parseFloat(fps);
      if (quality !== null) this.stats.quality       = parseFloat(quality);
      if (sizeKb  !== null) this.stats.sizeKb        = parseFloat(sizeKb);
      if (bitrate !== null) this.stats.bitrate       = parseFloat(bitrate);
      if (dropped !== null) this.stats.droppedFrames = parseInt(dropped, 10);
      if (speed   !== null) this.stats.speed         = parseFloat(speed);
      this._fbOutputFailures = 0;

      this.emit('stats', { streamId: this.config.id, stats: { ...this.stats } });
      return;
    }

    // Classify as error / warn / info
    let level = 'info';
    if (/error|invalid|corrupt|fail|refused|abort|broken|reset/i.test(line)) level = 'error';
    else if (/warn|wrong|missing|deprecated|mismatch|packet dts/i.test(line))  level = 'warn';
    this._noteFacebookOutputFailure(line);
    this._log(level, line);
  }
}

module.exports = { StreamEngine, PRESETS, STATE };
