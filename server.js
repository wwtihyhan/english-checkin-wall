require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database: Neon PostgreSQL via pg (TCP, not serverless) ─
let dbReady = false;
let pool = null;
let dbConnectError = null; // diagnostic: last connection error

// Neon connection string (render.yaml env vars not auto-applied for manual services)
const NEON_URL = 'postgresql://neondb_owner:npg_S5xAnYGJL4tH@ep-shy-tooth-atj1kwma-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=verify-full';

const dbUrlRaw = process.env.DATABASE_URL || NEON_URL;
// Remove channel_binding=require — pg uses standard TCP+TLS which is already secure
const dbUrl = dbUrlRaw.replace(/&?channel_binding=require/g, '');
const fromEnv = !!process.env.DATABASE_URL;
console.log(`🔍 DATABASE_URL: ${fromEnv ? '环境变量' : '内置备用'} (${dbUrl.length} 字符)`);

pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

// ── Middleware ────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Health check (diagnostics) ─────────────────────
app.get('/api/health', async (req, res) => {
  const info = {
    status: dbReady ? 'ok' : 'degraded',
    dbReady,
    hasPool: !!pool,
    hasDbUrl: !!process.env.DATABASE_URL,
    hasFallback: true,
    dbUrlLen: process.env.DATABASE_URL ? process.env.DATABASE_URL.length : 0,
    error: dbConnectError,
    nodeEnv: process.env.NODE_ENV || 'development',
    uptime: Math.floor(process.uptime())
  };
  // If dbReady, also test a simple query
  if (dbReady) {
    try {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM checkins');
      info.rowCount = rows[0].cnt;
    } catch (e) {
      info.queryError = e.message;
    }
  }
  res.json(info);
});

// ── API: Get all check-ins ────────────────────────────────
app.get('/api/checkins', async (req, res) => {
  if (!dbReady) return res.json([]);

  try {
    const { rows } = await pool.query('SELECT * FROM checkins ORDER BY id DESC');
    res.json(rows.map(row => ({
      id: row.id,
      name: row.name,
      date: row.date,
      title: row.title,
      stars: row.stars,
      colorIndex: row.color_index,
      audio: row.audio_base64 ? `/api/audio/${row.id}` : null,
      timestamp: row.timestamp
    })));
  } catch (err) {
    console.error('GET error:', err.message);
    res.status(500).json({ error: '查询失败，请稍后重试' });
  }
});

// ── API: Create a check-in ────────────────────────────────
app.post('/api/checkins', async (req, res) => {
  const { name, date, title, stars = 1, colorIndex = 0, audio, timestamp } = req.body;

  if (!name || !date || !title) {
    return res.status(400).json({ error: '姓名、日期、标题不能为空' });
  }

  if (!dbReady) {
    return res.status(503).json({ error: '数据库未连接，请稍后重试' });
  }

  try {
    // One-per-day check
    const existing = await pool.query(
      'SELECT id FROM checkins WHERE LOWER(name) = LOWER($1) AND date = $2',
      [name.trim(), date]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: `${name} 今天已经打过卡了` });
    }

    const result = await pool.query(
      `INSERT INTO checkins (name, date, title, stars, color_index, audio_base64, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [name.trim(), date, title.trim(), stars, colorIndex, audio || null, timestamp || new Date().toISOString()]
    );

    const id = result.rows[0].id;
    res.status(201).json({
      id, name: name.trim(), date, title: title.trim(),
      stars, colorIndex,
      audio: audio ? `/api/audio/${id}` : null,
      timestamp: timestamp || new Date().toISOString()
    });
  } catch (err) {
    console.error('POST error:', err.message);
    res.status(500).json({ error: '打卡失败，请稍后重试' });
  }
});

// ── API: Delete a check-in ────────────────────────────────
app.delete('/api/checkins/:id', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: '数据库未连接' });

  try {
    await pool.query('DELETE FROM checkins WHERE id = $1', [Number(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE error:', err.message);
    res.status(500).json({ error: '删除失败' });
  }
});

// ── API: Stream audio from DB ─────────────────────────────
app.get('/api/audio/:id', async (req, res) => {
  if (!dbReady) return res.status(404).send('Not available');

  try {
    const { rows } = await pool.query(
      'SELECT audio_base64 FROM checkins WHERE id = $1',
      [Number(req.params.id)]
    );
    if (!rows[0] || !rows[0].audio_base64) {
      return res.status(404).send('No audio');
    }

    const base64 = rows[0].audio_base64;
    const matches = base64.match(/^data:(audio\/\w+);base64,(.+)$/);
    if (!matches) return res.status(400).send('Invalid audio');

    const buffer = Buffer.from(matches[2], 'base64');
    res.set('Content-Type', matches[1]);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Audio error');
  }
});

// ── Audio cleanup: delete recordings older than 2 days ─────
async function cleanupExpiredAudio() {
  if (!dbReady) return;
  try {
    const { rows } = await pool.query(
      `UPDATE checkins
       SET audio_base64 = NULL
       WHERE audio_base64 IS NOT NULL
         AND timestamp < NOW() - INTERVAL '2 days'
       RETURNING id`
    );
    if (rows.length > 0) {
      console.log(`🗑️  已清理 ${rows.length} 条过期录音 (超过2天)`);
    }
  } catch (err) {
    console.error('清理过期录音失败:', err.message);
  }
}

// ⏰ 每小时检查一次
function startAudioCleanup() {
  cleanupExpiredAudio();
  setInterval(cleanupExpiredAudio, 60 * 60 * 1000);
  console.log('⏰ 录音自动清理已启动 (保留2天，每小时检查)');
}

// ── Start server: connect DB first, then listen ────────────
async function startServer() {
  try {
    console.log('🔌 正在连接 Neon (pg TCP)...');
    const client = await pool.connect();
    const { rows } = await client.query('SELECT 1 AS ok');
    client.release();
    console.log('✅ Neon 已连接:', rows[0].ok === 1 ? 'OK' : '?');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS checkins (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        date VARCHAR(10) NOT NULL,
        title VARCHAR(500) NOT NULL,
        stars INTEGER DEFAULT 1,
        color_index INTEGER DEFAULT 0,
        audio_base64 TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ 数据表已就绪');
    dbReady = true;
    dbConnectError = null;
    startAudioCleanup();
  } catch (err) {
    dbConnectError = `[${err.code || 'UNKNOWN'}] ${err.message}`;
    console.error('❌ Neon 连接失败:', dbConnectError);
    if (err.stack) console.error('   Stack:', err.stack.split('\n').slice(0, 3).join('\n'));
    console.log('⚠️  降级运行 (dbReady=false)');
  }

  app.listen(PORT, () => {
    console.log(`✅ 英语阅读打卡墙已启动: http://localhost:${PORT}`);
    console.log(`   数据库: ${dbReady ? 'Neon PostgreSQL ☁️ (pg)' : '未连接 ⚠️ 内置备用串已加载'}`);
  });
}

startServer().catch(err => {
  console.error('服务器启动失败:', err.message);
  process.exit(1);
});
