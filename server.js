require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// Bypass local proxy for Neon database connections (Node.js fetch respects proxy env vars)
const NEON_HOST = '.aws.neon.tech';
if (process.env.NO_PROXY) {
  process.env.NO_PROXY += ',' + NEON_HOST;
} else {
  process.env.NO_PROXY = NEON_HOST;
}
process.env.no_proxy = process.env.NO_PROXY;

const express = require('express');
const { neon } = require('@neondatabase/serverless');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database: Neon PostgreSQL ──────────────────────────────
let sql = null;
let useDB = false;

if (process.env.DATABASE_URL) {
  sql = neon(process.env.DATABASE_URL);
  useDB = true;
}

// ── Middleware ────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Get all check-ins ────────────────────────────────
app.get('/api/checkins', async (req, res) => {
  if (!useDB) return res.json([]);

  try {
    const rows = await sql`SELECT * FROM checkins ORDER BY id DESC`;
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

  if (!useDB) {
    return res.status(503).json({ error: '数据库未连接' });
  }

  try {
    // One-per-day check
    const existing = await sql`
      SELECT id FROM checkins WHERE LOWER(name) = LOWER(${name.trim()}) AND date = ${date}
    `;
    if (existing.length > 0) {
      return res.status(409).json({ error: `${name} 今天已经打过卡了` });
    }

    const result = await sql`
      INSERT INTO checkins (name, date, title, stars, color_index, audio_base64, timestamp)
      VALUES (${name.trim()}, ${date}, ${title.trim()}, ${stars}, ${colorIndex}, ${audio || null}, ${timestamp || new Date().toISOString()})
      RETURNING id
    `;

    const id = result[0].id;
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
  if (!useDB) return res.status(503).json({ error: '数据库未连接' });

  try {
    await sql`DELETE FROM checkins WHERE id = ${Number(req.params.id)}`;
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE error:', err.message);
    res.status(500).json({ error: '删除失败' });
  }
});

// ── API: Stream audio from DB ─────────────────────────────
app.get('/api/audio/:id', async (req, res) => {
  if (!useDB) return res.status(404).send('Not available');

  try {
    const result = await sql`SELECT audio_base64 FROM checkins WHERE id = ${Number(req.params.id)}`;
    if (!result[0] || !result[0].audio_base64) {
      return res.status(404).send('No audio');
    }

    const base64 = result[0].audio_base64;
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
  if (!useDB) return;
  try {
    const result = await sql`
      UPDATE checkins
      SET audio_base64 = NULL
      WHERE audio_base64 IS NOT NULL
        AND timestamp < NOW() - INTERVAL '2 days'
      RETURNING id
    `;
    if (result.length > 0) {
      console.log(`🗑️  已清理 ${result.length} 条过期录音 (超过2天)`);
    }
  } catch (err) {
    console.error('清理过期录音失败:', err.message);
  }
}

// ⏰ 每小时检查一次
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

function startAudioCleanup() {
  // 立即执行一次
  cleanupExpiredAudio();
  // 每小时定期执行
  setInterval(cleanupExpiredAudio, CLEANUP_INTERVAL);
  console.log('⏰ 录音自动清理已启动 (保留2天，每小时检查)');
}

// ── Start server immediately, init DB in background ───────
app.listen(PORT, () => {
  console.log(`✅ 英语阅读打卡墙已启动: http://localhost:${PORT}`);
  if (useDB) {
    console.log('   数据库: Neon PostgreSQL ☁️ (后台连接中...)');
  } else {
    console.log('   数据库: JSON 文件 (本地) 💾');
  }
});

// Background: test connection and ensure table exists
if (useDB) {
  (async () => {
    try {
      console.log('🔌 正在连接 Neon...');
      await sql`SELECT 1`;
      console.log('✅ Neon 已连接');

      await sql`
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
      `;
      console.log('✅ 数据表已就绪');

      // 启动录音自动清理
      startAudioCleanup();
    } catch (err) {
      console.error('❌ Neon 连接失败:', err.message);
      useDB = false;
    }
  })();
}
