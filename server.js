const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data', 'checkins.json');
const AUDIO_DIR = path.join(__dirname, 'data', 'audio');

// Ensure directories and data file exist
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

// Middleware: parse JSON bodies (up to 20MB for audio recordings)
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded audio recordings
app.use('/api/audio', express.static(AUDIO_DIR));

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

function saveAudio(base64Data) {
  // Extract MIME and buffer from base64 data URL
  const matches = base64Data.match(/^data:((audio|video)\/\w+);base64,(.+)$/);
  if (!matches) return null;
  const extMap = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
    'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
    'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
    'audio/aac': 'aac', 'audio/x-m4a': 'm4a', 'video/webm': 'webm'
  };
  const ext = extMap[matches[1]] || 'webm';
  const buffer = Buffer.from(matches[3], 'base64');
  const filename = `${crypto.randomUUID()}.${ext}`;
  const filepath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return filename;
}

function deleteAudio(filename) {
  if (!filename) return;
  const filepath = path.join(AUDIO_DIR, filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
}

// ── API Routes ───────────────────────────────────────────

// Get all check-ins
app.get('/api/checkins', (req, res) => {
  const data = readData();
  // Migrate old inline base64 audio to files
  let migrated = false;
  for (const c of data) {
    if (c.audio && c.audio.startsWith('data:')) {
      const filename = saveAudio(c.audio);
      if (filename) {
        c.audio = `/api/audio/${filename}`;
        migrated = true;
      }
    }
  }
  if (migrated) writeData(data);
  res.json(data);
});

// Create a check-in
app.post('/api/checkins', (req, res) => {
  const { name, date, title, stars, colorIndex, audio: audioData, timestamp } = req.body;

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

  // Save audio if provided
  let audioUrl = null;
  if (audioData && audioData.startsWith('data:')) {
    const filename = saveAudio(audioData);
    if (filename) audioUrl = `/api/audio/${filename}`;
  }

  const record = {
    id: Date.now(),
    name: name.trim(),
    date,
    title: title.trim(),
    stars: stars || 1,
    colorIndex: colorIndex || 0,
    audio: audioUrl,
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

  // Delete associated audio file
  if (record.audio && record.audio.startsWith('/api/audio/')) {
    const filename = record.audio.replace('/api/audio/', '');
    deleteAudio(filename);
  }

  data.splice(idx, 1);
  writeData(data);

  res.json({ success: true });
});

// ── Start server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ 英语阅读打卡墙服务已启动: http://localhost:${PORT}`);
});
