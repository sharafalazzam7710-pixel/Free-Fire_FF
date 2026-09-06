const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'clash-squad.sqlite');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2367305746';
const sessions = new Map();

const DEFAULT_STATE = {
  teams: [],
  matches: [],
  winners: [],
  settings: {
    title: 'بطولة فري فاير كلاش سكواد',
    description: 'سجّل فريقك ونافس أفضل لاعبي Free Fire في بطولة عربية منظمة وسريعة.',
    rules: 'الفريق يتكون من لاعبين أساسيين ولاعب احتياط اختياري.\nيجب التأكد من صحة IDs قبل إرسال طلب التسجيل.\nالالتزام بموعد المواجهة شرط أساسي للاستمرار في البطولة.',
    registration: 'open',
    started: false,
    finished: false,
    maintenance: false,
    startDate: '',
    startTime: '',
  },
};

const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
if (!db.prepare('SELECT id FROM app_state WHERE id = 1').get()) {
  db.prepare('INSERT INTO app_state (id, payload, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)')
    .run(JSON.stringify(DEFAULT_STATE));
}

function readState() {
  try {
    const row = db.prepare('SELECT payload FROM app_state WHERE id = 1').get();
    const stored = JSON.parse(row.payload);
    return {
      ...DEFAULT_STATE,
      ...stored,
      settings: { ...DEFAULT_STATE.settings, ...(stored.settings || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function writeState(state) {
  db.prepare('UPDATE app_state SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    .run(JSON.stringify(state));
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function id() {
  return crypto.randomUUID();
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())];
  }));
}

function isAdmin(req) {
  const token = cookies(req).clash_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}

function publicState(state, admin) {
  if (admin) return state;
  return {
    ...state,
    teams: state.teams.map(({ registrationToken, ...team }) => team),
  };
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    json(res, 401, { error: 'authentication_required' });
    return false;
  }
  return true;
}

function sendFile(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(ROOT, `.${requested}`);
  if (!file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    json(res, 404, { error: 'not_found' });
    return;
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const admin = isAdmin(req);
  const state = readState();

  if (url.pathname === '/api/state' && req.method === 'GET') {
    if (state.settings.maintenance && !admin) {
      json(res, 503, { maintenance: true, message: 'الموقع تحت الصيانة' });
      return;
    }
    json(res, 200, { ...publicState(state, admin), authenticated: admin });
    return;
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    try {
      const input = await body(req);
      if (input.username !== ADMIN_USERNAME || hash(input.password) !== hash(ADMIN_PASSWORD)) {
        json(res, 401, { error: 'invalid_credentials' });
        return;
      }
      const token = id();
      sessions.set(token, { expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
      json(res, 200, { ok: true }, {
        'Set-Cookie': `clash_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
      });
    } catch {
      json(res, 400, { error: 'invalid_request' });
    }
    return;
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const token = cookies(req).clash_session;
    if (token) sessions.delete(token);
    json(res, 200, { ok: true }, { 'Set-Cookie': 'clash_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    return;
  }

  if (url.pathname === '/api/registration' && req.method === 'POST') {
    try {
      const input = await body(req);
      const current = readState();
      if (current.settings.maintenance || current.settings.started || current.settings.finished || current.settings.registration !== 'open') {
        json(res, 409, { error: 'registration_closed' });
        return;
      }
      const players = Array.isArray(input.players) ? input.players.map((player) => ({
        name: String(player.name || '').trim(),
        id: String(player.id || '').trim(),
      })).filter((player) => player.name || player.id) : [];
      if (!input.name || !input.owner || players.length < 2 || players.some((player) => !player.name || !player.id)) {
        json(res, 400, { error: 'invalid_registration' });
        return;
      }
      const ids = new Set(players.map((player) => player.id));
      const duplicate = current.teams.find((team) => team.owner === input.owner
        || team.players.some((player) => ids.has(String(player.id))));
      if (duplicate) {
        json(res, 409, { error: 'already_registered', team: { id: duplicate.id, name: duplicate.name } });
        return;
      }
      const registrationToken = id();
      const team = {
        id: id(),
        name: String(input.name).trim(),
        owner: String(input.owner).trim(),
        players,
        status: 'pending',
        registrationToken,
        wins: 0,
        losses: 0,
        draws: 0,
        points: 0,
      };
      current.teams.push(team);
      writeState(current);
      json(res, 201, { ok: true, team: { id: team.id, name: team.name }, token: registrationToken });
    } catch {
      json(res, 400, { error: 'invalid_request' });
    }
    return;
  }

  if (url.pathname === '/api/registration/withdraw' && req.method === 'POST') {
    try {
      const input = await body(req);
      const current = readState();
      const team = current.teams.find((item) => item.id === input.id && item.registrationToken === input.token);
      if (!team) {
        json(res, 404, { error: 'registration_not_found' });
        return;
      }
      if (current.settings.maintenance || current.settings.started || current.settings.finished) {
        json(res, 409, { error: 'withdrawal_closed' });
        return;
      }
      current.teams = current.teams.filter((item) => item.id !== team.id);
      writeState(current);
      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { error: 'invalid_request' });
    }
    return;
  }

  if (url.pathname === '/api/state' && req.method === 'PUT') {
    if (!requireAdmin(req, res)) return;
    try {
      const input = await body(req);
      const next = {
        teams: Array.isArray(input.teams) ? input.teams : [],
        matches: Array.isArray(input.matches) ? input.matches : [],
        winners: Array.isArray(input.winners) ? input.winners : [],
        settings: { ...DEFAULT_STATE.settings, ...(input.settings || {}) },
      };
      writeState(next);
      json(res, 200, { ...publicState(next, true), authenticated: true });
    } catch {
      json(res, 400, { error: 'invalid_request' });
    }
    return;
  }

  sendFile(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(() => json(res, 500, { error: 'server_error' }));
});

server.listen(PORT, HOST, () => {
  console.log(`Clash Squad server listening on http://${HOST}:${PORT}`);
});