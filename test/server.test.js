'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18181;
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api/threads/1`;
const AUTHOR = { Authorization: 'Bearer demo-token-1' };
const STRANGER = { Authorization: 'Bearer demo-token-2' };
let server, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lolzteam-shop-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: path.join(dir, 'db.json') },
  });
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve);
    server.once('exit', code => reject(new Error(`сервер завершился с кодом ${code}`)));
  });
});

after(() => {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

const json = async (url, opts) => {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.json(), headers: r.headers };
};

test('витрина скрывает товары с нулевым остатком и токены', async () => {
  const { body } = await json(API);
  assert.equal(body.thread.creator.token, undefined);
  assert.ok(body.thread.shop.items.every(i => i.stock > 0));
});

test('assortment.txt совпадает с форматом тега [api]', async () => {
  const text = await (await fetch(`${API}/shop/assortment.txt`)).text();
  assert.match(text, /^Steam аккаунт, 10\+ игр - 450 ₽ \(в наличии: \d+ шт\.\)$/m);
  assert.match(text, /Обновлено: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} МСК$/);
});

test('страница выдаёт сессию автора, а изменения по ней требуют защиты от CSRF', async () => {
  const page = await fetch(`${BASE}/threads/1/`);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const me = await json(`${BASE}/api/me`, { headers: { cookie } });
  assert.equal(me.body.user.username, 'liwi');

  const put = (headers = {}) =>
    json(`${API}/post`, {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ post_body: 'Тест [shop]' }),
    });
  assert.equal((await put()).status, 403);
  assert.equal((await put({ 'X-Requested-With': 'XMLHttpRequest' })).status, 200);
});

test('без входа и чужим токеном управлять магазином нельзя', async () => {
  assert.equal((await json(`${API}/shop/manage`)).status, 401);
  assert.equal((await json(`${API}/shop/manage`, { headers: STRANGER })).status, 403);
});

test('бот списывает остаток и не уходит в минус', async () => {
  const sell = qty =>
    json(`${API}/shop/items/tgprem3/sold`, {
      method: 'POST',
      headers: { ...AUTHOR, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `qty=${qty}`,
    });
  const ok = await sell(2);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.stock, 3);
  const tooMuch = await sell(99);
  assert.equal(tooMuch.status, 409);
});

test('сохранение редактора не затирает продажи бота', async () => {
  const { body } = await json(`${API}/shop/manage`, { headers: AUTHOR });
  const save = base_update_date =>
    json(`${API}/shop`, {
      method: 'PUT',
      headers: { ...AUTHOR, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: body.shop.items, rules: body.shop.rules, base_update_date }),
    });
  assert.equal((await save(1)).status, 409);
  assert.equal((await save(body.shop.update_date)).status, 200);
});
