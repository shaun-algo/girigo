/**
 * 기리고 — RITUAL SERVER
 * The oracle watches. The oracle waits. The oracle decides.
 */

const express = require('express');
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function loadLocalEnv() {
  const envPath = path.join(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

loadLocalEnv();

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_CODE_HASH = process.env.GIRIGO_ADMIN_CODE_HASH
  || (process.env.GIRIGO_ADMIN_CODE ? hashSecret(process.env.GIRIGO_ADMIN_CODE) : '');
const ADMIN_COOKIE = 'girigo_admin';
const ADMIN_SESSION = process.env.GIRIGO_ADMIN_SESSION || uuidv4();
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'girigo-wishes';
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_ANON_KEY);
const supabase = SUPABASE_ENABLED
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// ── Storage paths ────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, '../data');
const UPLOADS_DIR = path.join(DATA_DIR, 'videos');
const WISHES_FILE = path.join(DATA_DIR, 'wishes.json');

[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Wish store (in-memory + persisted to JSON) ────────────────
let wishes = {};
function loadWishes() {
  try { wishes = JSON.parse(fs.readFileSync(WISHES_FILE, 'utf8')); } catch { wishes = {}; }
}
function saveWishes() {
  fs.writeFileSync(WISHES_FILE, JSON.stringify(wishes, null, 2));
}
loadWishes();

function rowToWish(row) {
  if (!row) return null;
  return {
    wishId: row.wish_id,
    submittedAt: Number(row.submitted_at),
    durationSec: Number(row.duration_sec || 0),
    devotionSeed: Number(row.devotion_seed || 0),
    phase: row.phase || 'submission',
    granted: row.granted,
    videoFile: row.video_file,
    videoPath: row.video_path,
    videoSize: Number(row.video_size || 0),
    decreeAt: row.decree_at ? Number(row.decree_at) : null,
  };
}

function wishToRow(wish) {
  return {
    wish_id: wish.wishId,
    submitted_at: wish.submittedAt,
    duration_sec: wish.durationSec,
    devotion_seed: wish.devotionSeed,
    phase: wish.phase || 'submission',
    granted: wish.granted,
    video_file: wish.videoFile || null,
    video_path: wish.videoPath || null,
    video_size: wish.videoSize || null,
    decree_at: wish.decreeAt || null,
  };
}

async function saveWishRecord(wish) {
  if (!SUPABASE_ENABLED) {
    wishes[wish.wishId] = wish;
    saveWishes();
    return wish;
  }
  const { error } = await supabase.from('wishes').insert(wishToRow(wish));
  if (error) throw error;
  return wish;
}

async function getWishRecord(wishId) {
  if (!SUPABASE_ENABLED) return wishes[wishId] || null;
  const { data, error } = await supabase
    .from('wishes')
    .select('*')
    .eq('wish_id', wishId)
    .maybeSingle();
  if (error) throw error;
  return rowToWish(data);
}

async function updateWishRecord(wish) {
  if (!SUPABASE_ENABLED) {
    wishes[wish.wishId] = wish;
    saveWishes();
    return;
  }
  const { error } = await supabase
    .from('wishes')
    .update(wishToRow(wish))
    .eq('wish_id', wish.wishId);
  if (error) throw error;
}

async function listWishRecords() {
  if (!SUPABASE_ENABLED) {
    loadWishes();
    return Object.values(wishes);
  }
  const { data, error } = await supabase
    .from('wishes')
    .select('*')
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  return data.map(rowToWish);
}

// ── Multer (video upload) ─────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename:    (_, file, cb) => cb(null, `${uuidv4()}.webm`)
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ── Static frontend ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ═══════════════════════════════════════════════════════════════
// THE ORACLE — cult ritual logic
// Wishes are evaluated across 7 "phases of alignment":
//   1. Phase of Submission    — 0–2h  (wish received, oracle silent)
//   2. Phase of Contemplation — 2–6h  (oracle stirs)
//   3. Phase of Trial         — 6–12h (offering tested)
//   4. Phase of Resonance     — 12–18h (alignment sought)
//   5. Phase of The Vigil     — 18–22h (oracle dreams)
//   6. Phase of Revelation    — 22–23h (answer forms)
//   7. Phase of Manifestation — 23–24h (decree issued)
// After 24h, wishes expire and must be re-offered.
// A wish is granted based on: duration spoken, moon phase alignment,
// and a hidden "devotion score" accumulated from prior rituals.
// ═══════════════════════════════════════════════════════════════

const ORACLE_PHASES = [
  { name: 'submission',    minH: 0,  label: '봉헌 수신됨',     symbol: '⊙' },
  { name: 'contemplation', minH: 2,  label: '침묵 속 숙고',    symbol: '◌' },
  { name: 'trial',         minH: 6,  label: '봉헌 시험 중',    symbol: '△' },
  { name: 'resonance',     minH: 12, label: '공명 탐색 중',    symbol: '⬡' },
  { name: 'vigil',         minH: 18, label: '신탁의 꿈',       symbol: '☽' },
  { name: 'revelation',    minH: 22, label: '답이 형성 중',    symbol: '✦' },
  { name: 'manifestation', minH: 23, label: '현현 임박',       symbol: '◈' },
];

// Moon phase (0–7, 0=new, 4=full)
function moonPhase() {
  const now = Date.now();
  const LUNAR_MS = 29.53059 * 24 * 60 * 60 * 1000;
  const KNOWN_NEW = new Date('2000-01-06T18:14:00Z').getTime();
  return Math.floor(((now - KNOWN_NEW) % LUNAR_MS) / LUNAR_MS * 8);
}

function getOraclePhase(submittedAt) {
  const hoursElapsed = (Date.now() - submittedAt) / 3600000;
  let phase = ORACLE_PHASES[0];
  for (const p of ORACLE_PHASES) {
    if (hoursElapsed >= p.minH) phase = p;
  }
  return phase;
}

function evaluateWish(wish) {
  if (wish.granted !== null) return wish.granted; // already decided

  const hoursElapsed = (Date.now() - wish.submittedAt) / 3600000;
  if (hoursElapsed < 23) return null; // too early

  // Oracle decree — deterministic but opaque:
  // Factors: recording duration, moon phase, devotion seed, hour of submission
  const moon      = moonPhase(); // 0–7
  const duration  = wish.durationSec || 5;
  const hourOfDay = new Date(wish.submittedAt).getHours();
  const devotion  = wish.devotionSeed % 13; // 0–12

  // Ideal conditions: full/crescent moon, dawn/dusk hour, spoken ≥ 5s, devotion prime
  let score = 0;
  if (moon === 4 || moon === 1) score += 3; // full or waxing crescent
  if (moon === 0 || moon === 7) score += 1; // new moon partial
  if (hourOfDay >= 4 && hourOfDay <= 7)  score += 3; // dawn
  if (hourOfDay >= 17 && hourOfDay <= 20) score += 2; // dusk
  if (duration >= 10) score += 3;
  else if (duration >= 5) score += 2;
  else if (duration >= 3) score += 1;
  if ([2, 3, 5, 7, 11].includes(devotion)) score += 2; // prime devotion
  score += (devotion % 3); // residual

  // Total possible ≈ 11; grant threshold varies by moon
  const threshold = moon === 4 ? 5 : moon === 0 ? 9 : 7;
  return score >= threshold;
}

// ── Admin helpers ────────────────────────────────────────────
function parseCookies(req) {
  return (req.headers.cookie || '').split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1));
    return acc;
  }, {});
}

function isAdmin(req) {
  return parseCookies(req)[ADMIN_COOKIE] === ADMIN_SESSION;
}

function safeHashEquals(hash) {
  if (!ADMIN_CODE_HASH || !/^[a-f0-9]{64}$/i.test(hash) || !/^[a-f0-9]{64}$/i.test(ADMIN_CODE_HASH)) return false;
  const actual = Buffer.from(hash, 'hex');
  const expected = Buffer.from(ADMIN_CODE_HASH, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function adminCodeMatches(value) {
  if (typeof value !== 'string') return false;
  const candidate = value.slice(-96);
  if (candidate.length < 8) return false;
  for (let i = 0; i < candidate.length; i++) {
    if (safeHashEquals(hashSecret(candidate.slice(i)))) return true;
  }
  return false;
}

function setAdminCookie(res) {
  res.cookie(ADMIN_COOKIE, ADMIN_SESSION, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 1000 * 60 * 60 * 12,
  });
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(403).send(renderAdminLogin(true));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  }).format(new Date(ts));
}

function renderAdminLogin(hasError = false) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>기리고 관리자</title>
<style>
  *{box-sizing:border-box} body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#050202;color:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{width:min(380px,calc(100vw - 32px));display:grid;gap:18px}
  h1{margin:0;font-size:clamp(28px,9vw,54px);font-weight:300;letter-spacing:.32em;color:rgba(255,230,230,.92)}
  p{margin:0;color:rgba(255,200,200,.62);line-height:1.8;font-size:14px}
  form{display:grid;gap:12px}
  input,button{width:100%;height:48px;background:#0b0505;border:1px solid rgba(255,60,60,.28);color:#fff;font:inherit}
  input{padding:0 14px;letter-spacing:.04em}
  button{cursor:pointer;color:rgba(255,210,210,.9)}
  .err{color:rgb(255,90,90);min-height:20px}
</style>
</head>
<body>
<main>
  <h1>기리고</h1>
  <p>관리자 접근 코드가 필요합니다.</p>
  <form method="post" action="/admin/login">
    <input name="code" type="password" autocomplete="current-password" autofocus placeholder="secret code">
    <button type="submit">입장</button>
  </form>
  <p class="err">${hasError ? '코드가 맞지 않습니다.' : ''}</p>
</main>
</body>
</html>`;
}

function wishPhaseForAdmin(wish) {
  if (wish.granted === true) return { label: '허락됨', symbol: '✦', name: 'granted' };
  if (wish.granted === false) return { label: '거절됨', symbol: '×', name: 'refused' };
  return getOraclePhase(wish.submittedAt);
}

async function getAdminVideoUrl(wish) {
  if (SUPABASE_ENABLED) {
    if (!wish.videoPath) return '';
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUrl(wish.videoPath, 60 * 60);
    if (error) return '';
    return data.signedUrl;
  }
  return wish.videoFile ? `/admin/videos/${encodeURIComponent(wish.videoFile)}` : '';
}

async function renderAdminDashboard() {
  const wishRecords = await listWishRecords();
  const rows = await Promise.all(wishRecords
    .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0))
    .map(async wish => {
      const phase = wishPhaseForAdmin(wish);
      const videoUrl = await getAdminVideoUrl(wish);
      const videoExists = SUPABASE_ENABLED
        ? !!videoUrl
        : wish.videoFile && fs.existsSync(path.join(UPLOADS_DIR, wish.videoFile));
      return { wish, phase, videoUrl, videoExists };
    }));

  const items = rows.map(({ wish, phase, videoUrl, videoExists }) => `
    <article class="wish">
      <div class="media">
        ${videoExists
          ? `<video src="${videoUrl}" controls preload="metadata" playsinline></video>`
          : `<div class="missing">영상 없음</div>`}
      </div>
      <div class="meta">
        <div class="phase"><span>${escapeHtml(phase.symbol)}</span>${escapeHtml(phase.label)}</div>
        <div class="id">${escapeHtml(wish.wishId)}</div>
        <dl>
          <div><dt>제출</dt><dd>${escapeHtml(formatDate(wish.submittedAt))}</dd></div>
          <div><dt>길이</dt><dd>${escapeHtml(wish.durationSec || 0)}초</dd></div>
          <div><dt>파일</dt><dd>${escapeHtml(wish.videoFile || '—')}</dd></div>
          <div><dt>판정</dt><dd>${wish.granted === null ? '대기중' : wish.granted ? '허락' : '거절'}</dd></div>
        </dl>
      </div>
    </article>
  `).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>기리고 관리자</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#050202;color:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at top,rgba(160,0,0,.18),transparent 42%),linear-gradient(180deg,rgba(255,0,0,.04),transparent 28%);z-index:-1}
  header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px clamp(16px,4vw,42px);background:rgba(5,2,2,.86);backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,60,60,.14)}
  h1{margin:0;font-weight:300;letter-spacing:.28em;font-size:clamp(20px,4vw,34px)}
  .sub{color:rgba(255,205,205,.6);font-size:13px;letter-spacing:.08em}
  .top{display:grid;gap:4px}
  button{background:#100707;border:1px solid rgba(255,60,60,.28);color:rgba(255,220,220,.9);padding:10px 14px;cursor:pointer}
  main{width:min(1440px,100%);margin:0 auto;padding:clamp(14px,3vw,34px)}
  .empty{min-height:50dvh;display:grid;place-items:center;color:rgba(255,210,210,.56);letter-spacing:.14em}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr));gap:18px}
  .wish{display:grid;grid-template-rows:auto 1fr;background:rgba(18,7,7,.62);border:1px solid rgba(255,60,60,.16);overflow:hidden}
  .media{background:#000;aspect-ratio:9/16;display:grid;place-items:center}
  video{width:100%;height:100%;object-fit:contain;background:#000}
  .missing{color:rgba(255,210,210,.5)}
  .meta{display:grid;gap:12px;padding:15px}
  .phase{display:flex;align-items:center;gap:10px;color:rgba(255,210,210,.95);letter-spacing:.08em}
  .phase span{display:grid;place-items:center;width:30px;height:30px;border:1px solid rgba(255,70,70,.28);color:rgb(255,80,80)}
  .id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:rgba(255,210,210,.44);overflow-wrap:anywhere}
  dl{display:grid;gap:7px;margin:0}
  dl div{display:grid;grid-template-columns:58px 1fr;gap:10px}
  dt{color:rgba(255,150,150,.48)}
  dd{margin:0;color:rgba(255,235,235,.78);overflow-wrap:anywhere}
  @media (min-width:900px){.wish{grid-template-columns:minmax(180px,42%) 1fr;grid-template-rows:1fr}.media{aspect-ratio:auto;min-height:320px}}
</style>
</head>
<body>
<header>
  <div class="top">
    <h1>기리고 관리자</h1>
    <div class="sub">저장된 봉헌 영상과 신탁 상태</div>
  </div>
  <form method="post" action="/admin/logout"><button type="submit">나가기</button></form>
</header>
<main>
  ${rows.length ? `<section class="grid">${items}</section>` : '<div class="empty">아직 저장된 소원이 없습니다</div>'}
</main>
</body>
</html>`;
}

app.post('/api/admin/unlock', (req, res) => {
  if (req.body && adminCodeMatches(req.body.candidate || req.body.code)) {
    setAdminCookie(res);
    return res.json({ ok: true });
  }
  return res.status(403).json({ ok: false });
});

app.get('/admin', (req, res) => {
  if (!isAdmin(req)) return res.status(401).send(renderAdminLogin(false));
  renderAdminDashboard()
    .then(html => res.send(html))
    .catch(err => res.status(500).send(`Admin load failed: ${escapeHtml(err.message)}`));
});

app.post('/admin/login', (req, res) => {
  if (req.body && adminCodeMatches(req.body.code)) {
    setAdminCookie(res);
    return res.redirect('/admin');
  }
  return res.status(403).send(renderAdminLogin(true));
});

app.post('/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.redirect('/');
});

app.get('/admin/videos/:file', requireAdmin, (req, res) => {
  const file = req.params.file;
  if (!/^[a-f0-9-]+\.webm$/i.test(file)) return res.status(400).send('Bad video name');
  const videoPath = path.join(UPLOADS_DIR, file);
  if (!fs.existsSync(videoPath)) return res.status(404).send('Video not found');
  res.sendFile(videoPath);
});

app.post('/api/wish/upload-url', async (req, res) => {
  if (!SUPABASE_ENABLED) return res.status(501).json({ error: 'supabase_disabled' });
  const wishId = uuidv4();
  const fileName = `${wishId}.webm`;
  const day = new Date().toISOString().slice(0, 10);
  const pathName = `wishes/${day}/${fileName}`;
  try {
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUploadUrl(pathName);
    if (error) throw error;
    res.json({
      wishId,
      bucket: SUPABASE_BUCKET,
      path: pathName,
      fileName,
      signedUrl: data.signedUrl,
      token: data.token,
      supabaseUrl: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
    });
  } catch (err) {
    res.status(500).json({ error: 'upload_url_failed', detail: err.message });
  }
});

app.post('/api/wish/complete', async (req, res) => {
  if (!SUPABASE_ENABLED) return res.status(501).json({ error: 'supabase_disabled' });
  const submittedAt = Date.now();
  const durationSec = parseInt(req.body.durationSec) || 5;
  const wishId = String(req.body.wishId || '');
  const videoPath = String(req.body.path || '');
  const fileName = String(req.body.fileName || `${wishId}.webm`);
  const videoSize = Number(req.body.size || 0);

  if (!/^[a-f0-9-]{36}$/i.test(wishId) || !/^wishes\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}\.webm$/i.test(videoPath)) {
    return res.status(400).json({ error: 'bad_wish_upload' });
  }

  const devotionSeed = Math.floor(Math.random() * 1000);
  const wish = {
    wishId,
    submittedAt,
    durationSec,
    devotionSeed,
    phase: 'submission',
    granted: null,
    videoFile: fileName,
    videoPath,
    videoSize,
    decreeAt: null,
  };

  try {
    await saveWishRecord(wish);
    const phase = getOraclePhase(submittedAt);
    res.json({
      wishId,
      phase: phase.name,
      phaseLabel: phase.label,
      symbol: phase.symbol,
      moon: moonPhase(),
      message: '봉헌이 신탁에 전달되었습니다.',
    });
  } catch (err) {
    res.status(500).json({ error: 'wish_save_failed', detail: err.message });
  }
});

// ── API: Submit wish ─────────────────────────────────────────
app.post('/api/wish', upload.single('video'), async (req, res) => {
  const wishId      = uuidv4();
  const submittedAt = Date.now();
  const durationSec = parseInt(req.body.durationSec) || 5;
  const devotionSeed = Math.floor(Math.random() * 1000);

  const wish = {
    wishId,
    submittedAt,
    durationSec,
    devotionSeed,
    phase: 'submission',
    granted: null,
    videoFile: req.file ? req.file.filename : null,
    videoPath: null,
    videoSize: req.file ? req.file.size : null,
    decreeAt: null,
  };

  try {
    await saveWishRecord(wish);
    const phase = getOraclePhase(submittedAt);
    res.json({
      wishId,
      phase: phase.name,
      phaseLabel: phase.label,
      symbol: phase.symbol,
      moon: moonPhase(),
      message: '봉헌이 신탁에 전달되었습니다.',
    });
  } catch (err) {
    res.status(500).json({ error: 'wish_save_failed', detail: err.message });
  }
});

// ── API: Check wish status ────────────────────────────────────
app.get('/api/wish/:wishId', async (req, res) => {
  const wish = await getWishRecord(req.params.wishId).catch(err => {
    res.status(500).json({ error: 'wish_lookup_failed', detail: err.message });
    return null;
  });
  if (res.headersSent) return;
  if (!wish) return res.status(404).json({ error: '기록 없음' });

  const now         = Date.now();
  const elapsed     = now - wish.submittedAt;
  const hoursElapsed = elapsed / 3600000;
  const remaining   = Math.max(0, 24 * 3600000 - elapsed);
  const phase       = getOraclePhase(wish.submittedAt);

  // Attempt to evaluate if time is right
  if (wish.granted === null && hoursElapsed >= 23) {
    const result = evaluateWish(wish);
    if (result !== null) {
      wish.granted  = result;
      wish.decreeAt = now;
      wish.phase    = result ? 'granted' : 'refused';
      await updateWishRecord(wish);
    }
  }

  const isExpired = hoursElapsed >= 24 && wish.granted === false;

  res.json({
    wishId:       wish.wishId,
    phase:        wish.phase === 'granted' || wish.phase === 'refused' ? wish.phase : phase.name,
    phaseLabel:   phase.label,
    symbol:       phase.symbol,
    moon:         moonPhase(),
    granted:      wish.granted,
    decreeAt:     wish.decreeAt,
    submittedAt:  wish.submittedAt,
    remainingMs:  remaining,
    hoursElapsed: Math.floor(hoursElapsed),
    isExpired,
    // Cryptic oracle message per phase
    oracleText:   getOracleText(wish, phase.name),
  });
});

// ── Cryptic oracle text per phase ────────────────────────────
function getOracleText(wish, phaseName) {
  if (wish.granted === true)  return '신탁이 허락하였습니다. 소원이 이루어집니다.';
  if (wish.granted === false) return '신탁이 거절하였습니다. 다시 봉헌하십시오.';
  const texts = {
    submission:    '봉헌이 받아들여졌습니다. 신탁은 침묵 속에 있습니다.',
    contemplation: '신탁이 봉헌을 살피고 있습니다. 기다리십시오.',
    trial:         '봉헌이 시험받고 있습니다. 마음을 굳게 하십시오.',
    resonance:     '우주의 진동이 봉헌에 공명합니다.',
    vigil:         '신탁이 꿈속에서 봉헌을 헤아립니다.',
    revelation:    '답이 형성되고 있습니다. 곧 알게 될 것입니다.',
    manifestation: '현현이 임박했습니다. 떨며 기다리십시오.',
  };
  return texts[phaseName] || texts.submission;
}

// ── API: Oracle phases metadata ──────────────────────────────
app.get('/api/phases', (_, res) => {
  res.json(ORACLE_PHASES);
});

// ── Serve frontend for all other routes ──────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`기리고 ritual server running on :${PORT}`);
  console.log(`Moon phase: ${moonPhase()} (0=new, 4=full)`);
});
