import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

try {
  process.loadEnvFile();
} catch {
  // sem .env: usa os padrões
}
process.env.TZ ||= 'America/Sao_Paulo';

const { openDb, getSettings, setSetting, listWindows } = await import('./db.js');
const { runCheck, notifyAll } = await import('./monitor.js');
const { computeNextRun, activeWindows, parseDailyTimes } = await import('./schedule.js');
const { PROVIDERS, missingEnv, normalizePhone, evolutionStatus, evolutionConnect } = await import('./whatsapp.js');
const { parsePrice } = await import('./scraper.js');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const USER = process.env.DASHBOARD_USER || 'admin';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

if (!PASSWORD && !LOOPBACK.has(HOST)) {
  console.error('Para abrir o painel na rede (HOST diferente de 127.0.0.1), defina DASHBOARD_PASSWORD no .env.');
  process.exit(1);
}

const db = openDb();
const state = { running: false, nextRunAt: null, lastRun: null };

// ---------- agendador ----------

function reschedule() {
  const s = getSettings(db);
  try {
    state.nextRunAt = computeNextRun({
      now: new Date(),
      lastRunAt: s.last_run_at,
      dailyTimes: s.daily_times,
      windows: listWindows(db),
    });
  } catch (err) {
    console.error('[agenda]', err.message);
    state.nextRunAt = null;
  }
}

async function runNow(reason) {
  if (state.running) return false;
  state.running = true;
  setSetting(db, 'last_run_at', new Date().toISOString());
  console.log(`[monitor] ${new Date().toLocaleString('pt-BR')} verificando (${reason})...`);
  try {
    state.lastRun = await runCheck(db);
    const r = state.lastRun;
    console.log(`[monitor] ${r.checked} produto(s), ${r.failed} erro(s), ${r.alerts} alerta(s)`);
  } catch (err) {
    console.error('[monitor] falhou:', err);
  } finally {
    state.running = false;
    reschedule();
  }
  return true;
}

reschedule();
setInterval(() => {
  if (!state.running && state.nextRunAt && Date.now() >= state.nextRunAt.getTime()) runNow('agendado');
}, 15_000);

// ---------- validação ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function cleanUrl(value) {
  let u;
  try {
    u = new URL(String(value ?? '').trim());
  } catch {
    throw bad('Link inválido');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('O link precisa começar com http:// ou https://');
  return u.toString();
}

function optionalPrice(value) {
  if (value === '' || value == null) return null;
  const p = parsePrice(value);
  if (p == null) throw bad('Preço alvo inválido');
  return p;
}

function shortText(value, max, field) {
  const s = String(value ?? '').trim();
  if (s.length > max) throw bad(`${field}: no máximo ${max} caracteres`);
  return s;
}

function isoDate(value, field) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw bad(`${field} inválido`);
  return d.toISOString();
}

const bool = (v) => (v === false || v === 0 || v === '0' ? 0 : 1);

// ---------- rotas ----------

const routes = [];
const route = (method, path, handler) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>\\d+)')}$`), handler });

function getState() {
  const products = db.prepare('SELECT * FROM products ORDER BY active DESC, id').all();
  const history = db.prepare(
    'SELECT price, checked_at FROM (SELECT price, checked_at FROM prices WHERE product_id = ? ORDER BY checked_at DESC LIMIT 60) ORDER BY checked_at',
  );
  for (const p of products) p.history = history.all(p.id);

  const contacts = db
    .prepare('SELECT id, name, phone, active, apikey IS NOT NULL AND apikey <> \'\' AS has_apikey FROM contacts ORDER BY id')
    .all();
  const settings = getSettings(db);
  const windows = listWindows(db);
  const now = new Date();
  const active = activeWindows(windows, now);

  return {
    products,
    contacts,
    windows,
    settings,
    alerts: db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 30').all(),
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, missing: missingEnv(k) }])),
    status: {
      running: state.running,
      nextRunAt: state.nextRunAt?.toISOString() ?? null,
      lastRun: state.lastRun,
      lastRunAt: settings.last_run_at ?? null,
      activeWindows: active,
      timezone: process.env.TZ,
      now: now.toISOString(),
    },
  };
}

route('GET', '/api/state', () => getState());

function checkRange(alertFrom, ideal) {
  if (alertFrom != null && ideal != null && alertFrom < ideal) {
    throw bad('"Avisar a partir de" precisa ser maior ou igual ao preço ideal');
  }
}

route('POST', '/api/products', ({ body }) => {
  const ideal = optionalPrice(body.target_price);
  const alertFrom = optionalPrice(body.alert_from_price);
  checkRange(alertFrom, ideal);
  const r = db
    .prepare('INSERT INTO products (name, url, target_price, alert_from_price, selector, active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      shortText(body.name, 150, 'Nome'),
      cleanUrl(body.url),
      ideal,
      alertFrom,
      shortText(body.selector, 300, 'Seletor') || null,
      bool(body.active ?? 1),
    );
  const id = Number(r.lastInsertRowid);
  runCheck(db, { productIds: [id] }).catch((e) => console.error(e)); // primeira leitura já
  return { id };
});

route('PUT', '/api/products/:id', ({ params, body }) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(params.id);
  if (!p) throw new HttpError(404, 'Produto não encontrado');
  const url = 'url' in body ? cleanUrl(body.url) : p.url;
  const target = 'target_price' in body ? optionalPrice(body.target_price) : p.target_price;
  const alertFrom = 'alert_from_price' in body ? optionalPrice(body.alert_from_price) : p.alert_from_price;
  checkRange(alertFrom, target);
  const changedTarget = target !== p.target_price || alertFrom !== p.alert_from_price; // faixa nova: rearma
  db.prepare(
    `UPDATE products SET name = ?, url = ?, target_price = ?, alert_from_price = ?, selector = ?, active = ?,
       last_alert_price = CASE WHEN ? THEN NULL ELSE last_alert_price END WHERE id = ?`,
  ).run(
    'name' in body ? shortText(body.name, 150, 'Nome') : p.name,
    url,
    target,
    alertFrom,
    'selector' in body ? shortText(body.selector, 300, 'Seletor') || null : p.selector,
    'active' in body ? bool(body.active) : p.active,
    changedTarget ? 1 : 0,
    p.id,
  );
  return { ok: true };
});

route('DELETE', '/api/products/:id', ({ params }) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(params.id);
  return { ok: true };
});

route('POST', '/api/products/:id/check', async ({ params }) => {
  const id = Number(params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw new HttpError(404, 'Produto não encontrado');
  await runCheck(db, { productIds: [id] });
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
});

route('POST', '/api/contacts', ({ body }) => {
  const name = shortText(body.name, 80, 'Nome');
  if (!name) throw bad('Informe o nome do contato');
  const r = db
    .prepare('INSERT INTO contacts (name, phone, apikey, active) VALUES (?, ?, ?, ?)')
    .run(name, normalizeOr400(body.phone), shortText(body.apikey, 100, 'Apikey') || null, bool(body.active ?? 1));
  return { id: Number(r.lastInsertRowid) };
});

route('PUT', '/api/contacts/:id', ({ params, body }) => {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(params.id);
  if (!c) throw new HttpError(404, 'Contato não encontrado');
  db.prepare('UPDATE contacts SET name = ?, phone = ?, apikey = ?, active = ? WHERE id = ?').run(
    'name' in body ? shortText(body.name, 80, 'Nome') || c.name : c.name,
    'phone' in body ? normalizeOr400(body.phone) : c.phone,
    body.apikey ? shortText(body.apikey, 100, 'Apikey') : c.apikey, // vazio = mantém a atual
    'active' in body ? bool(body.active) : c.active,
    c.id,
  );
  return { ok: true };
});

route('DELETE', '/api/contacts/:id', ({ params }) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(params.id);
  return { ok: true };
});

route('POST', '/api/windows', ({ body }) => {
  const starts = isoDate(body.starts_at, 'Início');
  const ends = isoDate(body.ends_at, 'Fim');
  if (ends <= starts) throw bad('O fim precisa ser depois do início');
  const interval = Number(body.interval_min);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1440) throw bad('Intervalo: de 1 a 1440 minutos');
  db.prepare('INSERT INTO windows (label, starts_at, ends_at, interval_min) VALUES (?, ?, ?, ?)').run(
    shortText(body.label, 80, 'Nome') || 'Janela intensiva',
    starts,
    ends,
    interval,
  );
  reschedule();
  return { ok: true };
});

route('DELETE', '/api/windows/:id', ({ params }) => {
  db.prepare('DELETE FROM windows WHERE id = ?').run(params.id);
  reschedule();
  return { ok: true };
});

route('PUT', '/api/settings', ({ body }) => {
  if ('daily_times' in body) {
    const times = parseDailyTimesOr400(body.daily_times);
    setSetting(db, 'daily_times', times.map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`).join(','));
  }
  if ('drop_alert_pct' in body) {
    const pct = Number(body.drop_alert_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 90) throw bad('Queda mínima: de 0 a 90%');
    setSetting(db, 'drop_alert_pct', pct);
  }
  if ('whatsapp_provider' in body) {
    if (!PROVIDERS[body.whatsapp_provider]) throw bad('Provedor inválido');
    setSetting(db, 'whatsapp_provider', body.whatsapp_provider);
  }
  reschedule();
  return { ok: true };
});

route('POST', '/api/run', () => {
  if (state.running) return { started: false, message: 'Já existe uma verificação em andamento' };
  runNow('manual');
  return { started: true };
});

route('POST', '/api/test-message', async () => {
  const active = db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE active = 1').get().n;
  if (!active) throw bad('Cadastre (e ative) pelo menos um número de WhatsApp');
  const when = new Date().toLocaleString('pt-BR');
  return { results: await notifyAll(db, `✅ Teste do Monitor de Preços (${when}). Se você recebeu, está tudo certo!`) };
});

route('GET', '/api/whatsapp/status', () => evolutionStatus());

route('POST', '/api/whatsapp/connect', async () => {
  try {
    const r = await evolutionConnect();
    if (r.qr && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(r.qr)) throw new Error('QR code em formato inesperado');
    return r;
  } catch (err) {
    throw bad(err.message);
  }
});

function normalizeOr400(phone) {
  try {
    return normalizePhone(phone);
  } catch (err) {
    throw bad(err.message);
  }
}

function parseDailyTimesOr400(str) {
  try {
    return parseDailyTimes(str);
  } catch (err) {
    throw bad(err.message);
  }
}

// ---------- servidor HTTP ----------

function authorized(req) {
  if (!PASSWORD) return true;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const given = Buffer.from(Buffer.from(encoded, 'base64').toString('utf8'));
  const expected = Buffer.from(`${USER}:${PASSWORD}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new HttpError(413, 'Requisição grande demais');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw bad('JSON inválido');
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  try {
    // Sem senha, só aceita acesso pelo próprio computador (bloqueia DNS rebinding).
    const hostname = (req.headers.host || '').replace(/:\d+$/, '');
    if (!PASSWORD && !LOOPBACK.has(hostname)) throw new HttpError(403, 'Acesso permitido só via localhost');

    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Monitor de Precos", charset="UTF-8"' });
      return res.end('Login necessário');
    }

    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return send(res, 200, await readFile(new URL('../public/index.html', import.meta.url)), 'text/html; charset=utf-8');
    }

    if (pathname.startsWith('/api/')) {
      // Exigir JSON em escritas força o "preflight" do navegador e bloqueia CSRF de outros sites.
      if (req.method !== 'GET' && !String(req.headers['content-type']).startsWith('application/json')) {
        throw new HttpError(415, 'Use Content-Type: application/json');
      }
      for (const r of routes) {
        const m = r.method === req.method && pathname.match(r.re);
        if (!m) continue;
        const body = req.method === 'GET' ? {} : await readJson(req);
        return send(res, 200, await r.handler({ params: m.groups ?? {}, body }));
      }
    }
    throw new HttpError(404, 'Não encontrado');
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    send(res, status, { error: status === 500 ? 'Erro interno (veja o terminal)' : err.message });
  }
});

server.listen(PORT, HOST, () => {
  const s = getSettings(db);
  console.log(`\nMonitor de Preços rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Fuso: ${process.env.TZ} | WhatsApp: ${s.whatsapp_provider}`);
  console.log(`Próxima verificação: ${state.nextRunAt ? state.nextRunAt.toLocaleString('pt-BR') : 'nenhuma agendada'}\n`);
});
