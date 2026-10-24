'use strict';
// Продаёт случайный товар раз в 3 секунды: node bot-example.js [токен] [id темы] [адрес API]
const TOKEN = process.argv[2] || 'demo-token-1';
const THREAD = process.argv[3] || '1';
const API = process.argv[4] || 'http://localhost:8080/api';

const call = (path, method = 'GET', body) =>
  fetch(`${API}/threads/${THREAD}${path}`, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  }).then(async r => ({ status: r.status, data: await r.json() }));

setInterval(async () => {
  const { status: s, data: d } = await call('/shop/manage');
  if (s !== 200) return console.log(`Ошибка ${s}: ${d.errors?.[0]}`);
  const inStock = d.shop.items.filter(i => i.stock > 0);
  if (!inStock.length) return console.log('Всё раскуплено');
  const item = inStock[Math.floor(Math.random() * inStock.length)];
  const { status, data } = await call(`/shop/items/${item.item_id}/sold`, 'POST', { qty: 1 });
  console.log(status === 200 ? `Продано: ${data.item.title}, осталось ${data.item.stock}` : `Ошибка ${status}: ${data.errors?.[0]}`);
}, 3000);
