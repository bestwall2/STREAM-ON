'use strict';

const BetterSQLite = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'streams.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new BetterSQLite(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous  = NORMAL');
db.pragma('foreign_keys = ON');

// ─── Schema ─────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS streams (
    id                   TEXT    PRIMARY KEY,
    name                 TEXT    NOT NULL,
    source_url           TEXT    NOT NULL,
    fb_stream_key        TEXT    NOT NULL,
    preset               TEXT    NOT NULL DEFAULT '720p30',
    custom_width         INTEGER,
    custom_height        INTEGER,
    custom_fps           INTEGER,
    custom_video_bitrate INTEGER,
    custom_audio_bitrate INTEGER,
    custom_sample_rate   INTEGER,
    custom_channels      INTEGER,
    custom_video_codec   TEXT,
    custom_audio_codec   TEXT,
    custom_preset_speed  TEXT,
    custom_tune          TEXT,
    custom_profile       TEXT,
    custom_level         TEXT,
    custom_keyframe_interval INTEGER,
    custom_pixel_format  TEXT,
    custom_color_space   TEXT,
    custom_color_range   TEXT,
    custom_aspect_ratio  TEXT,
    custom_frame_mode    TEXT,
    custom_gop_size      INTEGER,
    custom_bframes       INTEGER,
    custom_refs          INTEGER,
    custom_sc_threshold  INTEGER,
    custom_qp_min        INTEGER,
    custom_qp_max        INTEGER,
    custom_crf           INTEGER,
    custom_rate_control  TEXT,
    custom_audio_sample_fmt TEXT,
    custom_deinterlace   INTEGER DEFAULT 0,
    custom_denoise       INTEGER DEFAULT 0,
    custom_sharpen       INTEGER DEFAULT 0,
    custom_extra_input_opts TEXT,
    custom_extra_output_opts TEXT,
    custom_video_filter_chain TEXT,
    custom_audio_filter_chain TEXT,
    auto_start           INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stream_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id   TEXT    NOT NULL,
    event_type  TEXT    NOT NULL,
    message     TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_stream
    ON stream_events (stream_id, created_at DESC);
`);

// ─── Prepared statements ─────────────────────────────────────────────────────

const stmts = {
  getAll:    db.prepare('SELECT * FROM streams ORDER BY created_at ASC'),
  getById:   db.prepare('SELECT * FROM streams WHERE id = ?'),
  insert:    db.prepare(`
    INSERT INTO streams
      (id, name, source_url, fb_stream_key, preset,
       custom_width, custom_height, custom_fps,
       custom_video_bitrate, custom_audio_bitrate,
       auto_start, created_at, updated_at)
    VALUES
      (@id, @name, @source_url, @fb_stream_key, @preset,
       @custom_width, @custom_height, @custom_fps,
       @custom_video_bitrate, @custom_audio_bitrate,
       @auto_start, @created_at, @updated_at)
  `),
  update:    db.prepare(`
    UPDATE streams SET
      name                 = @name,
      source_url           = @source_url,
      fb_stream_key        = @fb_stream_key,
      preset               = @preset,
      custom_width         = @custom_width,
      custom_height        = @custom_height,
      custom_fps           = @custom_fps,
      custom_video_bitrate = @custom_video_bitrate,
      custom_audio_bitrate = @custom_audio_bitrate,
      auto_start           = @auto_start,
      updated_at           = @updated_at
    WHERE id = @id
  `),
  delete:       db.prepare('DELETE FROM streams WHERE id = ?'),
  deleteEvents: db.prepare('DELETE FROM stream_events WHERE stream_id = ?'),
  logEvent:     db.prepare(`
    INSERT INTO stream_events (stream_id, event_type, message, created_at)
    VALUES (?, ?, ?, ?)
  `),
  getEvents:    db.prepare(`
    SELECT * FROM stream_events
    WHERE stream_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),
};

// ─── API ──────────────────────────────────────────────────────────────────────

module.exports = {
  getAllStreams() {
    return stmts.getAll.all();
  },

  getStream(id) {
    return stmts.getById.get(id) || null;
  },

  createStream(row) {
    stmts.insert.run(row);
    return stmts.getById.get(row.id);
  },

  updateStream(id, changes) {
    const existing = stmts.getById.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...changes, updated_at: Date.now() };
    stmts.update.run(merged);
    return stmts.getById.get(id);
  },

  deleteStream(id) {
    stmts.deleteEvents.run(id);
    return stmts.delete.run(id).changes > 0;
  },

  logEvent(streamId, eventType, message) {
    try {
      stmts.logEvent.run(streamId, eventType, message || null, Date.now());
    } catch (_) {
      // Non-fatal: never crash the streaming loop over a log write
    }
  },

  getRecentEvents(streamId, limit = 100) {
    return stmts.getEvents.all(streamId, limit);
  },

  close() {
    db.close();
  },
};
