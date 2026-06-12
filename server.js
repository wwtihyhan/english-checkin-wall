const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data', 'checkins.json');
const IMG_DIR = path.join(__dirname, 'data', 'images');

// Ensure directories and data file exist
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

// Middleware: parse JSON bodies (up to 50MB for images)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded images
app.use('/api/images', express.static(IMG_DIR));

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

function saveImage(base64Data) {
  // Extract MIME and buffer from base64 data URL
  const matches = base64Data.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) return null;
  const ext = matches[1].split('/')[1] === 'jpeg' ? 'jpg' : matches[1].split('/')[1];
  const buffer = Buffer.from(matches[2], 'base64');
  const filename = `${crypto.randomUUID()}.${ext}`;
  const filepath = path.join(IMG_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return filename;
}

function deleteImage(filename) {
  if (!filename) return;
  const filepath = path.join(IMG_DIR, filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
}

// ── API Routes ───────────────────────────────────────────

// Get all check-ins
app.get('/api/checkins', (req, res) => {
  const data = readData();
  // Migrate old base64 images to files
  let migrated = false;
  for (const c of data) {
    if (c.img && c.img.startsWith('data:')) {
      const filename = saveImage(c.img);
      if (filename) {
        c.img = `/api/images/${filename}`;
        migrated = true;
      }
    }
  }
  if (migrated) writeData(data);
  res.json(data);
});

// Create a check-in
app.post('/api/checkins', (req, res) => {
  const { name, date, title, stars, colorIndex, img: imgData, timestamp } = req.body;

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

  // Save image if provided
  let imgUrl = null;
  if (imgData && imgData.startsWith('data:')) {
    const filename = saveImage(imgData);
    if (filename) imgUrl = `/api/images/${filename}`;
  }

  const record = {
    id: Date.now(),
    name: name.trim(),
    date,
    title: title.trim(),
    stars: stars || 1,
    colorIndex: colorIndex || 0,
    img: imgUrl,
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

  const record = data[idx];

  // Delete associated image file
  if (record.img && record.img.startsWith('/api/images/')) {
    const filename = record.img.replace('/api/images/', '');
    deleteImage(filename);
  }

  data.splice(idx, 1);
  writeData(data);

  res.json({ success: true });
});

// ── Start server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ 英语阅读打卡墙服务已启动: http://localhost:${PORT}`);
});
