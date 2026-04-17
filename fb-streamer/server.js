'use strict';

/**
 * FB Live Streamer — main entry point
 * ====================================
 * Starts the Express / Socket.IO server, registers API routes,
 * then hands control to StreamManager.
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const path     = require('path');

const manager  = require('./src/StreamManager');
const { PRESETS } = require('./src/StreamEngine');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ─── App & server setup ────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] },
  pingTimeout:  60000,
  pingInterval: 25000,
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Utility ───────────────────────────────────────────────────────────────

const ok  = (res, data, code = 200) => res.status(code).json(data);
const err = (res, msg,  code = 500) => res.status(code).json({ error: msg });

function requireId(req, res, next) {
  if (!manager.engines.has(req.params.id)) return err(res, 'Stream not found', 404);
  next();
}

function validateBody(req, res, next) {
  const { name, sourceUrl, fbStreamKey } = req.body;
  if (!name?.trim())         return err(res, 'name is required', 400);
  if (!sourceUrl?.trim())    return err(res, 'sourceUrl is required', 400);
  if (!fbStreamKey?.trim())  return err(res, 'fbStreamKey is required', 400);
  next();
}

// ─── REST routes ───────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  ok(res, {
    status: 'ok',
    streams: manager.engines.size,
    uptime:  process.uptime(),
    ts:      new Date().toISOString(),
  });
});

// Quality presets
app.get('/api/presets', (_req, res) => {
  ok(res, PRESETS);
});

// ── Streams CRUD ─────────

// List
app.get('/api/streams', (_req, res) => {
  ok(res, manager.getAllPublic());
});

// Create
app.post('/api/streams', validateBody, (req, res) => {
  try {
    const data = req.body;
    const stream = manager.createStream({
      name:               data.name.trim(),
      sourceUrl:          data.sourceUrl.trim(),
      fbStreamKey:        data.fbStreamKey.trim(),
      preset:             data.preset             || '720p30',
      customWidth:        data.customWidth        || null,
      customHeight:       data.customHeight       || null,
      customFps:          data.customFps          || null,
      customVideoBitrate: data.customVideoBitrate || null,
      customAudioBitrate: data.customAudioBitrate || null,
      autoStart:          !!data.autoStart,
      
      // Advanced encoding settings
      encodingMode:       data.encodingMode       || 'reencode',
      videoCodec:         data.videoCodec         || 'libx264',
      encoderPreset:      data.encoderPreset      || 'veryfast',
      rateControl:        data.rateControl        || 'cbr',
      maxBitrate:         data.maxBitrate         || null,
      bufferSize:         data.bufferSize         || null,
      crfValue:           data.crfValue           || null,
      keyframeInterval:   data.keyframeInterval   || null,
      profile:            data.profile            || 'main',
      level:              data.level              || '4.0',
      pixelFormat:        data.pixelFormat        || 'yuv420p',
      colorSpace:         data.colorSpace         || 'bt709',
      videoFilters:       data.videoFilters       || '',
      audioCodec:         data.audioCodec         || 'aac',
      sampleRate:         data.sampleRate         || '48000',
      audioChannels:      data.audioChannels      || '2',
      audioFilters:       data.audioFilters       || '',
      threads:            data.threads            || null,
      tune:               data.tune               || '',
      x264Params:         data.x264Params         || '',
      customFlags:        data.customFlags        || '',
      rawCommand:         data.rawCommand         || '',
      useRawCommand:      !!data.useRawCommand,
    });
    ok(res, stream, 201);
  } catch (e) {
    err(res, e.message);
  }
});

// Update
app.put('/api/streams/:id', requireId, (req, res) => {
  try {
    const updated = manager.updateStream(req.params.id, req.body);
    ok(res, updated);
  } catch (e) {
    err(res, e.message);
  }
});

// Delete
app.delete('/api/streams/:id', requireId, (req, res) => {
  manager.deleteStream(req.params.id);
  ok(res, { success: true });
});

// ── Stream control ───────────────────────────────────────────────────────────

app.post('/api/streams/:id/start', requireId, (req, res) => {
  manager.startStream(req.params.id);
  ok(res, { success: true });
});

app.post('/api/streams/:id/stop', requireId, (req, res) => {
  manager.stopStream(req.params.id);
  ok(res, { success: true });
});

app.post('/api/streams/:id/restart', requireId, (req, res) => {
  manager.restartStream(req.params.id);
  ok(res, { success: true });
});

// ── Log retrieval ────────────────────────────────────────────────────────────

app.get('/api/streams/:id/logs', requireId, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 600);
  ok(res, manager.getStreamLogs(req.params.id, limit));
});

// ── Stream analysis ────────────────────────────────────────────────────────────

const { spawn } = require('child_process');

app.post('/api/analyze', async (req, res) => {
  try {
    const { sourceUrl } = req.body;
    if (!sourceUrl) {
      return err(res, 'sourceUrl is required', 400);
    }
    
    // Use ffprobe to analyze the stream (spawned args: no shell interpolation)
    const probeArgs = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'v:0,a:0',
      sourceUrl,
    ];

    const result = await new Promise((resolve, reject) => {
      const proc = spawn('ffprobe', probeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        reject(new Error('ffprobe timed out after 30s'));
      }, 30000);

      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', code => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error((stderr || `ffprobe exited with code ${code}`).trim()));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Invalid ffprobe JSON: ${e.message}`));
        }
      });
    });
    const videoStream = result.streams?.find(s => s.codec_type === 'video');
    const audioStream = result.streams?.find(s => s.codec_type === 'audio');
    
    const parseFps = (r) => {
      if (!r) return 0;
      if (!String(r).includes('/')) return Number(r) || 0;
      const [n, d] = String(r).split('/').map(Number);
      return (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) ? 0 : n / d;
    };

    const width = Number(videoStream?.width) || 0;
    const height = Number(videoStream?.height) || 0;
    const fps = parseFps(videoStream?.r_frame_rate);
    const videoCodec = videoStream?.codec_name;
    const audioCodec = audioStream?.codec_name;
    const pixFmt = (videoStream?.pix_fmt || '').toLowerCase();

    const issues = [];
    if (videoCodec !== 'h264') issues.push(`Video codec is ${videoCodec || 'unknown'} (Facebook copy mode needs h264).`);
    if (audioStream && audioCodec !== 'aac') issues.push(`Audio codec is ${audioCodec || 'unknown'} (Facebook copy mode needs aac).`);
    if (width > 1920 || height > 1080) issues.push(`Resolution is ${width}x${height} (Facebook recommends up to 1920x1080).`);
    if (fps > 60) issues.push(`Frame rate is ${fps.toFixed(2)} (Facebook recommends up to 60 fps).`);
    if (pixFmt && pixFmt !== 'yuv420p') issues.push(`Pixel format is ${pixFmt} (Facebook copy mode works best with yuv420p).`);

    ok(res, {
      video: videoStream ? {
        codec_name: videoStream.codec_name,
        codec_long_name: videoStream.codec_long_name,
        width: videoStream.width,
        height: videoStream.height,
        r_frame_rate: videoStream.r_frame_rate,
        fps,
        pix_fmt: videoStream.pix_fmt,
        bit_rate: videoStream.bit_rate,
      } : null,
      audio: audioStream ? {
        codec_name: audioStream.codec_name,
        codec_long_name: audioStream.codec_long_name,
        sample_rate: audioStream.sample_rate,
        channels: audioStream.channels,
        bit_rate: audioStream.bit_rate,
      } : null,
      compatible: issues.length === 0,
      issues,
      recommendedMode: issues.length === 0 ? 'copy' : 'reencode',
    });
  } catch (e) {
    console.error('[analyze] error:', e.message);
    err(res, 'Failed to analyze stream: ' + e.message);
  }
});

// ─── Socket.IO ──────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log(`[ws] client connected  ${socket.id}`);

  // Push full state on connect
  socket.emit('init', {
    streams: manager.getAllPublic(),
    presets: PRESETS,
  });

  // Client subscribes to a stream's live log feed
  socket.on('logs:subscribe', ({ id }) => {
    if (id) socket.join(`logs:${id}`);
  });

  socket.on('logs:unsubscribe', ({ id }) => {
    if (id) socket.leave(`logs:${id}`);
  });

  // Client requests log history for a stream
  socket.on('logs:fetch', ({ id, limit }) => {
    const logs = manager.getStreamLogs(id, limit || 200);
    if (logs) socket.emit(`logs:history:${id}`, logs);
  });

  socket.on('disconnect', reason => {
    console.log(`[ws] client disconnected ${socket.id} (${reason})`);
  });
});

// ─── Startup ────────────────────────────────────────────────────────────────

manager.init(io);

server.listen(PORT, HOST, () => {
  console.log('\n========================================');
  console.log('  FB Live Streamer');
  console.log(`  Dashboard → http://localhost:${PORT}`);
  console.log('========================================\n');
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

const shutdown = (sig) => {
  console.log(`\n[server] received ${sig} — shutting down gracefully…`);
  manager.shutdown();
  server.close(() => {
    console.log('[server] HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000); // force-exit after 10 s
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Catch-alls: log but never crash the streaming process
process.on('uncaughtException',  err => console.error('[fatal] uncaughtException:', err));
process.on('unhandledRejection', err => console.error('[fatal] unhandledRejection:', err));
