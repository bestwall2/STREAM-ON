'use strict';

/**
 * StreamManager
 * =============
 * Singleton that owns every StreamEngine instance.
 * Exposes a clean API consumed by the REST layer and Socket.IO handlers.
 * Also responsible for broadcasting real-time events and periodic stat polls.
 */

const { EventEmitter }           = require('events');
const { v4: uuidv4 }             = require('uuid');
const { StreamEngine, PRESETS, STATE } = require('./StreamEngine');
const db                         = require('./Database');

const STATS_INTERVAL_MS = 2000; // broadcast stats every 2 s

class StreamManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, StreamEngine>} */
    this.engines = new Map();
    this.io      = null;
    this._statsTimer = null;
  }

  // ─── Bootstrap ─────────────────────────────────────────────────────────────

  /**
   * Call once at server startup.  Loads stored streams, wires Socket.IO,
   * optionally auto-starts flagged streams.
   */
  init(io) {
    this.io = io;

    // Hydrate from database
    for (const row of db.getAllStreams()) {
      this._spawnEngine(this._rowToConfig(row));
    }

    // Auto-start
    let delay = 2000;
    for (const engine of this.engines.values()) {
      if (engine.config.autoStart) {
        setTimeout(() => engine.start(), delay);
        delay += 500; // stagger starts so we don't hammer RTMP all at once
      }
    }

    // Periodic stats broadcast
    this._statsTimer = setInterval(() => this._broadcastStats(), STATS_INTERVAL_MS);

    return this;
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  createStream(data) {
    const id  = uuidv4();
    const now = Date.now();

    const row = {
      id,
      name:                data.name,
      source_url:          data.sourceUrl,
      fb_stream_key:       data.fbStreamKey,
      preset:              data.preset              ?? '720p30',
      custom_width:        data.customWidth         ?? null,
      custom_height:       data.customHeight        ?? null,
      custom_fps:          data.customFps           ?? null,
      custom_video_bitrate: data.customVideoBitrate ?? null,
      custom_audio_bitrate: data.customAudioBitrate ?? null,
      encoding_mode:       data.encodingMode        ?? 'copy',
      video_codec:         data.videoCodec          ?? 'libx264',
      encoder_preset:      data.encoderPreset       ?? 'veryfast',
      rate_control:        data.rateControl         ?? 'cbr',
      max_bitrate:         data.maxBitrate          ?? null,
      buffer_size:         data.bufferSize          ?? null,
      crf_value:           data.crfValue            ?? null,
      keyframe_interval:   data.keyframeInterval    ?? null,
      profile:             data.profile             ?? 'main',
      level:               data.level               ?? '4.0',
      pixel_format:        data.pixelFormat         ?? 'yuv420p',
      color_space:         data.colorSpace          ?? 'bt709',
      video_filters:       data.videoFilters        ?? '',
      audio_codec:         data.audioCodec          ?? 'aac',
      sample_rate:         data.sampleRate          ?? '48000',
      audio_channels:      data.audioChannels       ?? '2',
      audio_filters:       data.audioFilters        ?? '',
      threads:             data.threads             ?? null,
      tune:                data.tune                ?? '',
      x264_params:         data.x264Params          ?? '',
      custom_flags:        data.customFlags         ?? '',
      raw_command:         data.rawCommand          ?? '',
      use_raw_command:     data.useRawCommand       ? 1 : 0,
      auto_start:          data.autoStart ? 1 : 0,
      created_at:          now,
      updated_at:          now,
    };

    const saved  = db.createStream(row);
    const config = this._rowToConfig(saved);
    const engine = this._spawnEngine(config);

    this._emit('stream:created', this._publicView(engine));
    return this._publicView(engine);
  }

  updateStream(id, data) {
    const engine = this.engines.get(id);
    if (!engine) return null;

    // Map camelCase payload → snake_case DB columns
    const changes = {};
    const map = {
      name:               'name',
      sourceUrl:          'source_url',
      fbStreamKey:        'fb_stream_key',
      preset:             'preset',
      customWidth:        'custom_width',
      customHeight:       'custom_height',
      customFps:          'custom_fps',
      customVideoBitrate: 'custom_video_bitrate',
      customAudioBitrate: 'custom_audio_bitrate',
      autoStart:          'auto_start',
      // Advanced encoding settings
      encodingMode:       'encoding_mode',
      videoCodec:         'video_codec',
      encoderPreset:      'encoder_preset',
      rateControl:        'rate_control',
      maxBitrate:         'max_bitrate',
      bufferSize:         'buffer_size',
      crfValue:           'crf_value',
      keyframeInterval:   'keyframe_interval',
      profile:            'profile',
      level:              'level',
      pixelFormat:        'pixel_format',
      colorSpace:         'color_space',
      videoFilters:       'video_filters',
      audioCodec:         'audio_codec',
      sampleRate:         'sample_rate',
      audioChannels:      'audio_channels',
      audioFilters:       'audio_filters',
      threads:            'threads',
      tune:               'tune',
      x264Params:         'x264_params',
      customFlags:        'custom_flags',
      rawCommand:         'raw_command',
      useRawCommand:      'use_raw_command',
    };
    for (const [js, sql] of Object.entries(map)) {
      if (data[js] !== undefined) {
        changes[sql] = (js === 'autoStart' || js === 'useRawCommand') ? (data[js] ? 1 : 0) : data[js];
      }
    }

    const saved = db.updateStream(id, changes);
    if (!saved) return null;

    engine.updateConfig(this._rowToConfig(saved));
    this._emit('stream:updated', this._publicView(engine));
    return this._publicView(engine);
  }

  deleteStream(id) {
    const engine = this.engines.get(id);
    if (!engine) return false;

    if (engine.state !== STATE.STOPPED && engine.state !== STATE.IDLE) {
      engine.stop();
    }

    this.engines.delete(id);
    db.deleteStream(id);
    this._emit('stream:deleted', { id });
    return true;
  }

  // ─── Control ───────────────────────────────────────────────────────────────

  startStream(id) {
    const e = this.engines.get(id);
    if (!e) return false;
    e.start();
    return true;
  }

  stopStream(id) {
    const e = this.engines.get(id);
    if (!e) return false;
    e.stop();
    return true;
  }

  restartStream(id) {
    const e = this.engines.get(id);
    if (!e) return false;
    e.restart();
    return true;
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  getAllPublic() {
    return [...this.engines.values()].map(e => this._publicView(e));
  }

  getStreamLogs(id, limit = 200) {
    const e = this.engines.get(id);
    return e ? e.getLogs(limit) : null;
  }

  getPresets() {
    return PRESETS;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _rowToConfig(row) {
    return {
      id:                row.id,
      name:              row.name,
      sourceUrl:         row.source_url,
      fbStreamKey:       row.fb_stream_key,
      preset:            row.preset,
      customWidth:       row.custom_width,
      customHeight:      row.custom_height,
      customFps:         row.custom_fps,
      customVideoBitrate:row.custom_video_bitrate,
      customAudioBitrate:row.custom_audio_bitrate,
      customSampleRate:  row.sample_rate,
      customChannels:    row.audio_channels,
      customVideoCodec:  row.video_codec,
      customAudioCodec:  row.audio_codec,
      customPresetSpeed: row.encoder_preset,
      customTune:        row.tune || 'zerolatency',
      customProfile:     row.profile,
      customLevel:       row.level,
      customKeyframeInterval: row.keyframe_interval,
      customPixelFormat: row.pixel_format,
      customColorSpace:  row.color_space,
      customCrf:         row.crf_value,
      customRateControl: (row.rate_control || '').toLowerCase(),
      encodingMode:      row.encoding_mode || 'reencode',
      autoStart:         row.auto_start === 1,
    };
  }

  _spawnEngine(config) {
    const engine = new StreamEngine(config);

    // ── Forward events to Socket.IO ────────────────────────────────────────
    engine.on('stateChange', ({ streamId, state, prevState }) => {
      this._emit('stream:state', {
        id:      streamId,
        state,
        prevState,
        status:  this._publicView(engine),
      });
      db.logEvent(streamId, 'state_change', `${prevState} → ${state}`);
    });

    engine.on('log', entry => {
      // Per-stream room so clients subscribe only to what they need
      if (this.io) {
        this.io.to(`logs:${entry.streamId}`).emit('stream:log', entry);
        this.io.emit('stream:log:any', entry);  // global feed (optional)
      }
    });

    engine.on('stats', ({ streamId, stats }) => {
      if (this.io) {
        this.io.emit(`stream:stats:${streamId}`, { id: streamId, stats });
      }
    });

    this.engines.set(config.id, engine);
    return engine;
  }

  /** Safe map of a StreamEngine to what the UI receives — never exposes the raw FB key */
  _publicView(engine) {
    const key = engine.config.fbStreamKey || '';
    const maskedKey = key.length > 8
      ? key.slice(0, 4) + '·'.repeat(Math.max(0, key.length - 8)) + key.slice(-4)
      : '·'.repeat(key.length);

    return {
      id:                engine.config.id,
      name:              engine.config.name,
      sourceUrl:         engine.config.sourceUrl,
      fbStreamKey:       engine.config.fbStreamKey,   // full key (private VPS tool)
      fbStreamKeyMasked: maskedKey,
      preset:            engine.config.preset,
      customWidth:       engine.config.customWidth,
      customHeight:      engine.config.customHeight,
      customFps:         engine.config.customFps,
      customVideoBitrate:engine.config.customVideoBitrate,
      customAudioBitrate:engine.config.customAudioBitrate,
      autoStart:         engine.config.autoStart,
      state:             engine.state,
      uptime:            engine.uptime,
      reconnectCount:    engine.reconnectCount,
      stats:             { ...engine.stats },
      usingFallback:     !!engine.fallbackProc,
    };
  }

  _broadcastStats() {
    if (!this.io || this.engines.size === 0) return;
    const payload = [...this.engines.values()].map(e => ({
      id:            e.config.id,
      state:         e.state,
      uptime:        e.uptime,
      reconnectCount:e.reconnectCount,
      stats:         { ...e.stats },
      usingFallback: !!e.fallbackProc,
    }));
    this.io.emit('streams:stats', payload);
  }

  _emit(event, data) {
    if (this.io) this.io.emit(event, data);
  }

  // ─── Shutdown ──────────────────────────────────────────────────────────────

  shutdown() {
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
    for (const engine of this.engines.values()) {
      if (engine._running) engine.stop();
    }
    db.close();
  }
}

// Export as a singleton
module.exports = new StreamManager();
