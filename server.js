require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Primary DB: Render PostgreSQL ────────────────────────
let dbReady = false;
let pool = null;
let dbConnectError = null;

// LOCAL: use .env DATABASE_URL or Neon fallback
// RENDER: DATABASE_URL injected by render.yaml → Render PostgreSQL
const dbUrl = process.env.DATABASE_URL || '';
if (!dbUrl) {
  console.warn('⚠️  DATABASE_URL 未设置 — 请配置 .env 或在 Render 上创建 PostgreSQL');
}

if (dbUrl) {
  pool = new Pool({
    connectionString: dbUrl.replace(/&?channel_binding=require/g, ''),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  console.log('🔌 主数据库连接池已创建');
} else {
  console.error('❌ 无可用 DATABASE_URL，应用将无法存储数据');
}

// ── Middleware ────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Health check ─────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const info = {
    status: dbReady ? 'ok' : 'degraded',
    dbReady,
    hasPool: !!pool,
    hasDbUrl: !!process.env.DATABASE_URL,
    dbUrlLen: process.env.DATABASE_URL ? process.env.DATABASE_URL.length : 0,
    error: dbConnectError,
    nodeEnv: process.env.NODE_ENV || 'development',
    uptime: Math.floor(process.uptime())
  };
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

  if (!name || !date) {
    return res.status(400).json({ error: '姓名和日期不能为空' });
  }

  if (!dbReady) {
    return res.status(503).json({ error: '数据库未连接，请稍后重试' });
  }

  try {
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
      [name.trim(), date, (title || '英语阅读打卡').trim(), stars, colorIndex, audio || null, timestamp || new Date().toISOString()]
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
    const id = Number(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE checkins SET audio_base64 = NULL WHERE id = $1', [id]);
      await client.query('DELETE FROM checkins WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
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
    const idx = base64.indexOf(';base64,');
    if (idx === -1) return res.status(400).send('Invalid audio');

    const mimeType = base64.substring(5, idx);
    const rawData = base64.substring(idx + 8);
    const buffer = Buffer.from(rawData, 'base64');
    res.set('Content-Type', mimeType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Audio error');
  }
});

// ── API: Recover data from Neon → Render PG ───────────────
let neonPool = null;
function getNeonPool() {
  if (neonPool) return neonPool;
  const neonUrl = process.env.NEON_URL || '';
  if (!neonUrl) return null;
  neonPool = new Pool({
    connectionString: neonUrl.replace(/&?channel_binding=require/g, ''),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  return neonPool;
}

app.get('/api/admin/recover', async (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ error: '主数据库未就绪' });
  }

  const np = getNeonPool();
  if (!np) {
    return res.status(503).json({ error: 'Neon 连接串未配置（NEON_URL 环境变量缺失）' });
  }

  try {
    // Test Neon connection
    const nc = await np.connect();
    await nc.query('SELECT 1');
    nc.release();

    // Fetch all records from Neon
    const { rows: neonRows } = await np.query(
      'SELECT * FROM checkins ORDER BY id'
    );

    if (neonRows.length === 0) {
      return res.json({ recovered: 0, total: 0, message: 'Neon 中无历史数据' });
    }

    // Insert into Render PG, skipping existing (by name+date)
    let inserted = 0, skipped = 0;
    for (const row of neonRows) {
      const existing = await pool.query(
        'SELECT id FROM checkins WHERE LOWER(name) = LOWER($1) AND date = $2',
        [row.name, row.date]
      );
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }
      await pool.query(
        `INSERT INTO checkins (name, date, title, stars, color_index, audio_base64, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.name, row.date, row.title, row.stars, row.color_index, row.audio_base64, row.timestamp]
      );
      inserted++;
    }

    const result = { recovered: inserted, skipped, total: neonRows.length, message: `从 Neon 恢复 ${inserted} 条，跳过 ${skipped} 条（已存在）` };
    console.log(`🔁 [恢复] ${result.message}`);
    res.json(result);
  } catch (err) {
    console.error('Neon 恢复失败:', err.message);
    res.status(503).json({ error: `Neon 连接失败: ${err.message}` });
  }
});

// ── Audio cleanup: delete recordings older than 30 days ─────
async function cleanupExpiredAudio() {
  if (!dbReady) return;
  try {
    const { rows } = await pool.query(
      `UPDATE checkins
       SET audio_base64 = NULL
       WHERE audio_base64 IS NOT NULL
         AND timestamp < NOW() - INTERVAL '30 days'
       RETURNING id`
    );
    if (rows.length > 0) {
      console.log(`🗑️  已清理 ${rows.length} 条过期录音 (超过30天)`);
    }
  } catch (err) {
    console.error('清理过期录音失败:', err.message);
  }
}

function startAudioCleanup() {
  cleanupExpiredAudio();
  setInterval(cleanupExpiredAudio, 60 * 60 * 1000);
  console.log('⏰ 录音自动清理已启动 (保留30天，每小时检查)');
}

// ── Periodic Neon recovery attempt ────────────────────────
async function tryRecoverFromNeon() {
  if (!dbReady) return;
  const np = getNeonPool();
  if (!np) return;

  try {
    const nc = await np.connect();
    await nc.query('SELECT 1');
    nc.release();

    const { rows: neonRows } = await np.query('SELECT id, name, date FROM checkins ORDER BY id');
    if (neonRows.length === 0) return;

    // Check which ones are missing from Render PG
    let recovered = 0;
    for (const row of neonRows) {
      const existing = await pool.query(
        'SELECT id FROM checkins WHERE LOWER(name) = LOWER($1) AND date = $2',
        [row.name, row.date]
      );
      if (existing.rows.length > 0) continue;

      // Fetch full record from Neon
      const { rows: full } = await np.query('SELECT * FROM checkins WHERE id = $1', [row.id]);
      if (full.length === 0) continue;
      const r = full[0];
      await pool.query(
        `INSERT INTO checkins (name, date, title, stars, color_index, audio_base64, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.name, r.date, r.title, r.stars, r.color_index, r.audio_base64, r.timestamp]
      );
      recovered++;
    }
    if (recovered > 0) {
      console.log(`🔁 [自动恢复] 从 Neon 恢复了 ${recovered} 条记录`);
    }
  } catch (_) {
    // Neon unavailable — silent, will retry later
  }
}

function startNeonRecoveryCron() {
  tryRecoverFromNeon();
  setInterval(tryRecoverFromNeon, 10 * 60 * 1000); // every 10 minutes
  console.log('🔁 Neon 数据恢复检测已启动 (每10分钟尝试一次)');
}

// ── Start server ───────────────────────────────────────────
async function startServer() {
  if (!pool) {
    console.log('⚠️  无 DATABASE_URL，跳过数据库初始化（只能查看静态页面）');
    app.listen(PORT, () => console.log(`✅ 静态模式: http://localhost:${PORT}`));
    return;
  }

  try {
    console.log('🔌 正在连接主数据库 (Render PostgreSQL)...');
    const client = await pool.connect();
    const { rows } = await client.query('SELECT 1 AS ok');
    client.release();
    console.log('✅ 数据库已连接');

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
    startNeonRecoveryCron();
  } catch (err) {
    dbConnectError = `[${err.code || 'UNKNOWN'}] ${err.message}`;
    console.error('❌ 数据库连接失败:', dbConnectError);
    console.log('⚠️  降级运行 (dbReady=false)');
  }

  app.listen(PORT, () => {
    console.log(`✅ 英语阅读打卡墙已启动: http://localhost:${PORT}`);
    console.log(`   数据库: ${dbReady ? '已连接 ✅' : '未连接 ⚠️'}`);
    if (process.env.NEON_URL) {
      console.log('   Neon 数据恢复: 已配置 (每10分钟自动尝试)');
    }
  });
}

startServer().catch(err => {
  console.error('服务器启动失败:', err.message);
  process.exit(1);
});
