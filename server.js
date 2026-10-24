'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8080;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');
const PUBLIC = path.join(__dirname, 'public');
const LIMITS = { items: 200, title: 120, rules: 5000, post: 20_000, body: 100_000 };

// Хранилище
const db = JSON.parse(fs.readFileSync(fs.existsSync(DB_FILE) ? DB_FILE : SEED_FILE, 'utf8'));
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  }, 200);
}
const now = () => Math.floor(Date.now() / 1000);

// Живые обновления через SSE, по thread_id
const listeners = new Map();
function publish(thread) {
  thread.shop.update_date = now();
  save();
  const msg = `data: ${JSON.stringify(publicShop(thread))}\n\n`;
  for (const res of listeners.get(thread.thread_id) || []) res.write(msg);
}

// Публичные представления
const publicShop = ({ shop }) => ({
  currency: shop.currency,
  rules: shop.rules,
  update_date: shop.update_date,
  items: shop.items.filter(i => i.stock > 0),
});
const publicUser = u => {
  const { token, ...rest } = u;
  return rest;
};
const publicThread = t => {
  const { shop, user_id, ...rest } = t;
  return { ...rest, creator: publicUser(db.users[user_id]), shop: shop && publicShop(t) };
};

const msk = unix =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date(unix * 1000))
    .replace(',', '') + ' МСК';

// Тот же текст, который ждёт нынешний тег [api]
const assortmentTxt = t => {
  const lines = publicShop(t).items.map(i => `${i.title} - ${i.price} ${t.shop.currency} (в наличии: ${i.stock} шт.)`);
  return `${lines.join('\n') || 'Сейчас всё раскуплено.'}\n\nОбновлено: ${msk(t.shop.update_date)}`;
};

// Проверка данных
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const isInt = (n, min = 0) => Number.isInteger(n) && n >= min && n <= 1e9;
function cleanItem(raw, usedIds) {
  if (!raw || typeof raw !== 'object') throw fail(400, 'Товар передан в неверном формате. Передайте объект с полями title, price и stock.');
  const title = String(raw.title ?? '').trim();
  if (!title || title.length > LIMITS.title) throw fail(400, `Название товара должно быть длиной от 1 до ${LIMITS.title} символов.`);
  const price = Number(raw.price),
    stock = Number(raw.stock);
  if (!(price >= 0 && price <= 1e9)) throw fail(400, `Цена «${title}» должна быть числом от 0.`);
  if (!isInt(stock)) throw fail(400, `Остаток «${title}» должен быть целым числом от 0.`);
  let id = String(raw.item_id ?? '').trim();
  if (!/^[\w-]{1,40}$/.test(id) || usedIds.has(id)) id = crypto.randomBytes(4).toString('hex');
  usedIds.add(id);
  return { item_id: id, title, price: Math.round(price * 100) / 100, stock };
}

// Вход: страница по сессии, как на форуме, бот по токену API
const PROTO_USER_ID = 1;
const sessions = new Map();
const sessionId = req => /(?:^|;\s*)session=([a-f0-9]{32})/.exec(req.headers.cookie || '')?.[1];

function ensureSession(req) {
  const sid = sessionId(req);
  if (sid && sessions.has(sid)) return null;
  const fresh = crypto.randomBytes(16).toString('hex');
  sessions.set(fresh, PROTO_USER_ID);
  return { 'Set-Cookie': `session=${fresh}; Path=/; HttpOnly; SameSite=Strict` };
}

function currentUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (m) {
    const given = Buffer.from(m[1]);
    return (
      Object.values(db.users).find(u => {
        const t = Buffer.from(u.token);
        return t.length === given.length && crypto.timingSafeEqual(t, given);
      }) || null
    );
  }
  const user = db.users[sessions.get(sessionId(req))];
  if (!user) return null;
  // Изменения по сессии только со страницы, как _xfToken в XenForo
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'XMLHttpRequest')
    throw fail(403, 'Запрос отклонён: нет защиты от CSRF. Отправьте его со страницы форума.');
  return user;
}

// HTTP
function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Принимает JSON и данные формы, как API форума
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > LIMITS.body) {
        reject(fail(413, 'Запрос слишком большой. Сократите список товаров или правила.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(fail(400, 'Тело запроса не похоже на JSON. Отправьте JSON или данные формы.'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function serveStatic(res, file, headers) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) throw fail(404, 'Страница не найдена.');
  send(res, 200, fs.readFileSync(full, 'utf8'), MIME[path.extname(full)] || 'text/plain; charset=utf-8', headers);
}

const NEED_AUTH = 'Вы не вошли. Войдите на форум или передайте токен в заголовке Authorization.';

// Маршруты
async function route(req, res) {
  const p = new URL(req.url, 'http://x').pathname,
    M = req.method;
  let m;

  // Страницы
  if (M === 'GET' && p === '/') {
    res.writeHead(302, { Location: '/threads/1/' });
    return res.end();
  }
  if (M === 'GET' && /^\/threads\/\d+(\/shop\/edit)?\/?$/.test(p)) return serveStatic(res, 'topic.html', ensureSession(req));
  if (M === 'GET' && (m = /^\/static\/([\w.-]+)$/.exec(p))) return serveStatic(res, m[1]);

  if (M === 'GET' && p === '/api/me') {
    const user = currentUser(req);
    return send(res, 200, { user: user && publicUser(user) });
  }

  // API в формате api.lolz.team
  if (!(m = /^\/api\/threads\/(\d+)(\/.*)?$/.exec(p))) throw fail(404, 'Страница не найдена.');
  const thread = db.threads[m[1]];
  if (!thread) throw fail(404, 'Тема не найдена. Проверьте номер темы.');
  const sub = m[2] || '';

  if (M === 'GET' && sub === '') return send(res, 200, { thread: publicThread(thread) });

  // Правка первого сообщения, на форуме это PUT /posts/{post_id}
  if (M === 'PUT' && sub === '/post') {
    const user = currentUser(req);
    if (!user) throw fail(401, NEED_AUTH);
    if (user.user_id !== thread.user_id) throw fail(403, 'Редактировать сообщение может только автор темы.');
    const text = String((await readBody(req)).post_body ?? '');
    if (!text.trim() || text.length > LIMITS.post) throw fail(400, 'Сообщение должно быть длиной от 1 до 20 000 символов.');
    thread.body = text;
    save();
    return send(res, 200, { thread: publicThread(thread) });
  }

  if (!thread.shop) throw fail(404, 'К этой теме не подключён магазин.');

  // Публичная витрина
  if (M === 'GET')
    switch (sub) {
      case '/shop':
        return send(res, 200, { shop: publicShop(thread) });
      case '/shop/events': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(publicShop(thread))}\n\n`);
        if (!listeners.has(thread.thread_id)) listeners.set(thread.thread_id, new Set());
        listeners.get(thread.thread_id).add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          listeners.get(thread.thread_id).delete(res);
        });
        return;
      }
      case '/shop/assortment.txt':
        return send(res, 200, assortmentTxt(thread), 'text/plain; charset=utf-8');
      case '/shop/rules.txt':
        return send(res, 200, thread.shop.rules, 'text/plain; charset=utf-8');
      case '/shop/shop.json':
        return send(res, 200, { assortment: assortmentTxt(thread), rules: thread.shop.rules });
    }

  // Управление магазином, только автор темы
  const user = currentUser(req);
  if (!user) throw fail(401, NEED_AUTH);
  if (user.user_id !== thread.user_id) throw fail(403, 'Управлять магазином может только автор темы.');
  const shop = thread.shop;

  if (M === 'GET' && sub === '/shop/manage') return send(res, 200, { shop });

  // Редактор сохраняет всю таблицу разом
  if (M === 'PUT' && sub === '/shop') {
    const body = await readBody(req);
    // Пока продавец редактировал, бот мог продать товар
    if (body.base_update_date && body.base_update_date !== shop.update_date)
      throw fail(409, 'Остатки изменились, пока вы редактировали, например после продажи ботом. Обновите страницу и повторите.');
    if (!Array.isArray(body.items) || body.items.length > LIMITS.items)
      throw fail(400, `Список товаров должен быть массивом до ${LIMITS.items} позиций.`);
    const rules = String(body.rules ?? '');
    if (rules.length > LIMITS.rules) throw fail(400, `Правила должны быть не длиннее ${LIMITS.rules} символов.`);
    const ids = new Set();
    shop.items = body.items.map(i => cleanItem(i, ids));
    shop.rules = rules;
    publish(thread);
    return send(res, 200, { shop });
  }

  const item = (m = /^\/shop\/items\/([\w-]+)(\/sold)?$/.exec(sub)) && shop.items.find(i => i.item_id === m[1]);
  if (m && !item) throw fail(404, 'Товар не найден. Обновите список товаров.');

  // Продажа ботом, остаток списывается атомарно
  if (item && m[2] && M === 'POST') {
    const qty = Number((await readBody(req)).qty ?? 1);
    if (!isInt(qty, 1)) throw fail(400, 'Количество должно быть целым числом от 1.');
    if (item.stock < qty) throw fail(409, `На складе осталось ${item.stock} шт. Уменьшите количество.`);
    item.stock -= qty;
    publish(thread);
    return send(res, 200, { item });
  }

  // Изменение одного товара ботом
  if (item && !m[2] && M === 'PATCH') {
    Object.assign(item, cleanItem({ ...item, ...(await readBody(req)), item_id: item.item_id }, new Set()));
    publish(thread);
    return send(res, 200, { item });
  }

  throw fail(404, 'Страница не найдена.');
}

http
  .createServer((req, res) => {
    route(req, res).catch(err =>
      send(res, err.status || 500, { errors: [err.status ? err.message : 'Внутренняя ошибка сервера. Повторите запрос позже.'] }),
    );
  })
  .listen(PORT, () => {
    console.log(`Тема:          http://localhost:${PORT}/threads/1/`);
    console.log(`Редактор:      http://localhost:${PORT}/threads/1/shop/edit`);
    console.log(`Совместимость: http://localhost:${PORT}/api/threads/1/shop/assortment.txt`);
  });
