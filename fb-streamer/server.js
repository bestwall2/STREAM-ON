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
