const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data', 'checkins.json');

// Ensure data directory and file exist
const dataDir = path.dirname(DATA_FILE);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── API Routes ───────────────────────────────────────────

// Get all check-ins
app.get('/api/checkins', (req, res) => {
  res.json(readData());
});

// Create a check-in
app.post('/api/checkins', (req, res) => {
  const { name, date, title, stars, colorIndex, timestamp } = req.body;

  if (!name || !date || !title) {
    return res.status(400).json({ error: '姓名、日期、标题不能为空' });
  }

  const data = readData();

  // One-per-day check
  const alreadyDone = data.some(
    c => c.name.trim().toLowerCase() === name.trim().toLowerCase() && c.date === date
  );
  if (alreadyDone) {
    return res.status(409).json({ error: `${name} 今天已经打过卡了` });
  }

  const record = {
    id: Date.now(),
    name: name.trim(),
    date,
    title: title.trim(),
    stars: stars || 1,
    colorIndex: colorIndex || 0,
    timestamp: timestamp || new Date().toISOString()
  };

  data.push(record);
  writeData(data);

  res.status(201).json(record);
});

// Delete a check-in
app.delete('/api/checkins/:id', (req, res) => {
  const id = Number(req.params.id);
  const data = readData();
  const idx = data.findIndex(c => c.id === id);

  if (idx === -1) {
    return res.status(404).json({ error: '记录不存在' });
  }

  data.splice(idx, 1);
  writeData(data);

  res.json({ success: true });
});

// ── Start server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ 英语阅读打卡墙服务已启动: http://localhost:${PORT}`);
});
