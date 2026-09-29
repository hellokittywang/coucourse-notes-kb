const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8686;

// ── Storage: in-memory with /tmp backup (Render's /tmp is writable) ──
const TMP_DIR = '/tmp';
const TMP_DATA = path.join(TMP_DIR, 'kb-data.json');
const TMP_SESSIONS = path.join(TMP_DIR, 'kb-sessions.json');

// Seed data — includes the user's course notes if available, otherwise defaults
function defaultData() {
  return {
    version: 1,
    settings: { adminPass: 'admin', adminName: '王倩', guestPass: '' },
    ui: { lastSectionId: null },
    courses: [],
    annotations: []
  };
}

// Try to read embedded seed data (baked in at deploy time)
let EMBEDDED_DATA = null;
try {
  const seedPath = path.join(__dirname, 'data', 'data.json');
  if (fs.existsSync(seedPath)) {
    const raw = fs.readFileSync(seedPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.courses) EMBEDDED_DATA = parsed;
  }
} catch (e) { /* ignore */ }

// In-memory state
let memData = null;
let memSessions = {};

// Initialize: try /tmp backup first, then embedded seed, then default
function initData() {
  // Try /tmp backup
  try {
    if (fs.existsSync(TMP_DATA)) {
      const raw = fs.readFileSync(TMP_DATA, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.courses) {
        memData = parsed;
        console.log('  Data restored from /tmp backup');
        return;
      }
    }
  } catch (e) { /* ignore */ }

  // Try embedded seed data
  if (EMBEDDED_DATA) {
    memData = JSON.parse(JSON.stringify(EMBEDDED_DATA));
    console.log('  Data loaded from embedded seed (' + memData.courses.length + ' courses)');
    return;
  }

  // Default
  memData = defaultData();
  console.log('  Data initialized with defaults');
}

function initSessions() {
  try {
    if (fs.existsSync(TMP_SESSIONS)) {
      memSessions = JSON.parse(fs.readFileSync(TMP_SESSIONS, 'utf-8'));
      return;
    }
  } catch (e) { /* ignore */ }
  memSessions = {};
}

// Save to /tmp (best effort — may fail on some platforms)
function saveData() {
  try { fs.writeFileSync(TMP_DATA, JSON.stringify(memData), 'utf-8'); } catch (e) { /* ignore */ }
}
function saveSessions() {
  try { fs.writeFileSync(TMP_SESSIONS, JSON.stringify(memSessions), 'utf-8'); } catch (e) { /* ignore */ }
}

initData();
initSessions();

// ── Helpers ──
function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Session management ──
function createSession(user) {
  const token = genToken();
  memSessions[token] = { ...user, at: Date.now() };
  saveSessions();
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = memSessions[token];
  if (!s) return null;
  return s;
}
function deleteSession(token) {
  delete memSessions[token];
  saveSessions();
}

// ── Middleware ──
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  let token = null;
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.slice(7);
  }
  if (!token && req.query.token) {
    token = req.query.token;
  }
  req.session = getSession(token);
  req.token = token;
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/html' || file.mimetype === 'text/markdown' ||
        file.originalname.endsWith('.html') || file.originalname.endsWith('.md') ||
        file.originalname.endsWith('.markdown')) cb(null, true);
    else cb(new Error('只支持 .html / .md 文件'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ── API: Auth ──

app.post('/api/login', (req, res) => {
  const { role, password, name } = req.body;

  if (role === 'admin') {
    if (password === memData.settings.adminPass) {
      const token = createSession({ role: 'admin', name: memData.settings.adminName });
      return res.json({ success: true, token, user: { role: 'admin', name: memData.settings.adminName } });
    }
    return res.status(401).json({ error: '密码不正确' });
  }

  if (role === 'guest') {
    if (!name || !name.trim()) {
      return res.status(400).json({ error: '请输入姓名' });
    }
    const gp = memData.settings.guestPass;
    if (gp && password !== gp) {
      return res.status(401).json({ error: '访客口令不正确' });
    }
    const token = createSession({ role: 'guest', name: name.trim() });
    return res.json({ success: true, token, user: { role: 'guest', name: name.trim() } });
  }

  return res.status(400).json({ error: '未知角色' });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  if (req.token) deleteSession(req.token);
  res.json({ success: true });
});

app.get('/api/session', authMiddleware, (req, res) => {
  if (req.session) {
    res.json({ loggedIn: true, user: { role: req.session.role, name: req.session.name } });
  } else {
    res.json({ loggedIn: false });
  }
});

app.get('/api/settings', (req, res) => {
  res.json({ guestPassRequired: !!memData.settings.guestPass });
});

// ── API: Data ──

app.get('/api/data', authMiddleware, (req, res) => {
  if (!req.session) return res.status(401).json({ error: '请先登录' });
  const safe = {
    version: memData.version,
    settings: { adminName: memData.settings.adminName, guestPassRequired: !!memData.settings.guestPass },
    ui: memData.ui,
    courses: memData.courses,
    annotations: memData.annotations
  };
  res.json(safe);
});

// ── API: Courses / Sections ──

app.post('/api/course', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const course = { id: uid(), title: safeName(req.body.title || '新课程'), chapters: [] };
  memData.courses.push(course);
  saveData();
  res.json({ success: true, course });
});

app.put('/api/course/:id', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const c = memData.courses.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: '课程不存在' });
  if (req.body.title) c.title = safeName(req.body.title);
  saveData();
  res.json({ success: true, course: c });
});

app.delete('/api/course/:id', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const c = memData.courses.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: '课程不存在' });
  const sectionIds = [];
  c.chapters.forEach(h => h.sections.forEach(s => sectionIds.push(s.id)));
  memData.courses = memData.courses.filter(c => c.id !== req.params.id);
  memData.annotations = memData.annotations.filter(a => !sectionIds.includes(a.sectionId));
  saveData();
  res.json({ success: true });
});

app.post('/api/course/:id/chapter', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const c = memData.courses.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: '课程不存在' });
  const chapter = { id: uid(), title: safeName(req.body.title || '新章节'), sections: [] };
  c.chapters.push(chapter);
  saveData();
  res.json({ success: true, chapter });
});

app.put('/api/chapter/:id', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  for (const c of memData.courses) {
    const h = c.chapters.find(h => h.id === req.params.id);
    if (h) {
      if (req.body.title) h.title = safeName(req.body.title);
      saveData();
      return res.json({ success: true, chapter: h });
    }
  }
  res.status(404).json({ error: '章节不存在' });
});

app.delete('/api/chapter/:id', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const sectionIds = [];
  for (const c of memData.courses) {
    const h = c.chapters.find(h => h.id === req.params.id);
    if (h) {
      h.sections.forEach(s => sectionIds.push(s.id));
      c.chapters = c.chapters.filter(h => h.id !== req.params.id);
      memData.annotations = memData.annotations.filter(a => !sectionIds.includes(a.sectionId));
      saveData();
      return res.json({ success: true });
    }
  }
  res.status(404).json({ error: '章节不存在' });
});

app.post('/api/chapter/:id/section', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  for (const c of memData.courses) {
    const h = c.chapters.find(h => h.id === req.params.id);
    if (h) {
      const section = { id: uid(), title: safeName(req.body.title || '新小节'), content: req.body.content || '<p>在这里开始撰写笔记正文…</p>' };
      h.sections.push(section);
      saveData();
      return res.json({ success: true, section });
    }
  }
  res.status(404).json({ error: '章节不存在' });
});

app.put('/api/section/:id', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  for (const c of memData.courses) {
    for (const h of c.chapters) {
      const s = h.sections.find(s => s.id === req.params.id);
      if (s) {
        if (req.body.title) s.title = safeName(req.body.title);
        if (req.body.content !== undefined) s.content = req.body.content;
        saveData();
        return res.json({ success: true, section: s });
      }
    }
  }
  res.status(404).json({ error: '小节不存在' });
});

app.delete('/api/section/:id', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  for (const c of memData.courses) {
    for (const h of c.chapters) {
      const s = h.sections.find(s => s.id === req.params.id);
      if (s) {
        h.sections = h.sections.filter(s => s.id !== req.params.id);
        memData.annotations = memData.annotations.filter(a => a.sectionId !== req.params.id);
        saveData();
        return res.json({ success: true });
      }
    }
  }
  res.status(404).json({ error: '小节不存在' });
});

app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const content = req.file.buffer.toString('utf-8');
  res.json({ success: true, content, name: req.file.originalname, size: req.file.size });
});

// ── API: Annotations ──

app.get('/api/annotations', authMiddleware, (req, res) => {
  if (!req.session) return res.status(401).json({ error: '请先登录' });
  res.json(memData.annotations);
});

app.post('/api/annotation', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const ann = {
    id: uid(),
    sectionId: req.body.sectionId,
    type: req.body.type || 'key',
    quote: req.body.quote || '',
    prefix: req.body.prefix || '',
    suffix: req.body.suffix || '',
    note: req.body.note || '',
    author: memData.settings.adminName,
    role: 'admin',
    createdAt: Date.now(),
    orphan: false,
    replies: []
  };
  memData.annotations.push(ann);
  saveData();
  res.json(ann);
});

app.put('/api/annotation/:id', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const ann = memData.annotations.find(a => a.id === req.params.id);
  if (!ann) return res.status(404).json({ error: '批注不存在' });
  if (req.body.type) ann.type = req.body.type;
  if (req.body.note !== undefined) ann.note = req.body.note;
  if (req.body.quote) ann.quote = req.body.quote;
  if (req.body.prefix !== undefined) ann.prefix = req.body.prefix;
  if (req.body.suffix !== undefined) ann.suffix = req.body.suffix;
  if (req.body.orphan !== undefined) ann.orphan = req.body.orphan;
  ann.editedAt = Date.now();
  saveData();
  res.json(ann);
});

app.delete('/api/annotation/:id', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const idx = memData.annotations.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '批注不存在' });
  memData.annotations.splice(idx, 1);
  saveData();
  res.json({ success: true });
});

// ── API: Replies ──

app.post('/api/annotation/:id/reply', authMiddleware, (req, res) => {
  if (!req.session) return res.status(401).json({ error: '请先登录' });
  const ann = memData.annotations.find(a => a.id === req.params.id);
  if (!ann) return res.status(404).json({ error: '批注不存在' });
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '回复内容不能为空' });
  const reply = {
    id: uid(),
    author: req.session.name,
    role: req.session.role,
    content,
    createdAt: Date.now()
  };
  ann.replies.push(reply);
  saveData();
  res.json(reply);
});

app.put('/api/reply/:annId/:replyId', authMiddleware, (req, res) => {
  if (!req.session) return res.status(401).json({ error: '请先登录' });
  const ann = memData.annotations.find(a => a.id === req.params.annId);
  if (!ann) return res.status(404).json({ error: '批注不存在' });
  const reply = ann.replies.find(r => r.id === req.params.replyId);
  if (!reply) return res.status(404).json({ error: '回复不存在' });
  const isOwner = reply.author === req.session.name && reply.role === req.session.role;
  const isAdmin = req.session.role === 'admin';
  if (!isOwner && !(isAdmin && reply.role === 'admin')) {
    return res.status(403).json({ error: '无权编辑此回复' });
  }
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '回复内容不能为空' });
  reply.content = content;
  reply.editedAt = Date.now();
  saveData();
  res.json(reply);
});

app.delete('/api/reply/:annId/:replyId', authMiddleware, (req, res) => {
  if (!req.session) return res.status(401).json({ error: '请先登录' });
  const ann = memData.annotations.find(a => a.id === req.params.annId);
  if (!ann) return res.status(404).json({ error: '批注不存在' });
  const idx = ann.replies.findIndex(r => r.id === req.params.replyId);
  if (idx === -1) return res.status(404).json({ error: '回复不存在' });
  const reply = ann.replies[idx];
  const isOwner = reply.author === req.session.name && reply.role === req.session.role;
  const isAdmin = req.session.role === 'admin';
  if (!isOwner && !(isAdmin && reply.role === 'admin')) {
    return res.status(403).json({ error: '无权删除此回复' });
  }
  ann.replies.splice(idx, 1);
  saveData();
  res.json({ success: true });
});

// ── API: Settings ──

app.put('/api/settings', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  if (req.body.adminName) memData.settings.adminName = req.body.adminName;
  if (req.body.adminPass) memData.settings.adminPass = req.body.adminPass;
  if (req.body.guestPass !== undefined) memData.settings.guestPass = req.body.guestPass;
  saveData();
  res.json({ success: true });
});

// ── API: Backup ──

app.get('/api/backup', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  res.setHeader('Content-Disposition', 'attachment; filename="kb-backup-' + new Date().toISOString().slice(0,10) + '.json"');
  res.json(memData);
});

app.post('/api/backup', authMiddleware, (req, res) => {
  if (!req.session || req.session.role !== 'admin') return res.status(403).json({ error: '无权限' });
  if (!req.body || !req.body.courses) return res.status(400).json({ error: '无效的备份文件' });
  memData = req.body;
  saveData();
  res.json({ success: true });
});

// ── Serve index.html for root ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n  课程笔记知识库已启动 → http://localhost:${PORT}`);
  console.log(`  课程数: ${memData.courses.length}, 批注数: ${memData.annotations.length}\n`);
});
