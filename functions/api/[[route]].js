// functions/api/[[route]].js
// Hungerr Station payments: server-priced orders, unique-amount UPI matching,
// and payment confirmation ONLY from authenticated bank-alert forwarding.

const MENU = { sf1: 40, sf2: 65, fr1: 99, mo1: 70, sw1: 100 };   // keep in sync with DISHES in index.html
const COUPONS = { LOVE99: 0.99, HUNGER50: 0.5 };
const WINDOW_MS = 15 * 60 * 1000;      // how long a customer has to pay
const LATE_MATCH_MS = 30 * 60 * 1000;  // still accept an exact-amount alert this long after expiry
const SLOTS = 20;                      // extra paise 0..19 used to make each pending amount unique

const json = (data, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

export async function onRequest({ request, env }) {
  const route = new URL(request.url).pathname.replace(/^\/api/, '').replace(/\/+$/, '');
  try {
    if (route === '/payments/create' && request.method === 'POST') return await createOrder(request, env);
    if (route === '/payments/status' && request.method === 'GET') return await orderStatus(request, env);
    if (route === '/payments/notify' && request.method === 'POST') return await bankAlert(request, env);
    return json({ error: 'Not found' }, 404);
  } catch (err) {
    console.error('API error:', err && err.message);
    return json({ error: 'Server error' }, 500);
  }
}

/* ---------------- create order ---------------- */

async function createOrder(request, env) {
  if (!env.DB) return json({ error: 'Database not configured' }, 500);
  if (!env.UPI_VPA) return json({ error: 'UPI ID not configured' }, 500);

  let b;
  try { b = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const name = String(b.name || '').trim().slice(0, 60);
  const phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
  if (name.length < 2) return json({ error: 'Please enter your name' }, 400);
  if (!/^[6-9]\d{9}$/.test(phone)) return json({ error: 'Please enter a valid 10-digit mobile number' }, 400);
  const method = b.method === 'COD' ? 'COD' : 'UPI';

  // Price everything on the server. Nothing price-related from the browser is trusted.
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 20) {
    return json({ error: 'Your cart is empty' }, 400);
  }
  let subtotal = 0;
  const lines = [];
  for (const it of b.items) {
    const qty = Number(it && it.qty);
    if (!it || !Object.hasOwn(MENU, it.id) || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      return json({ error: 'Invalid item in cart' }, 400);
    }
    subtotal += MENU[it.id] * qty;
    lines.push({ id: it.id, qty, price: MENU[it.id] });
  }
  let rate = 0;
  if (b.coupon) {
    const code = String(b.coupon).toUpperCase();
    if (!Object.hasOwn(COUPONS, code)) return json({ error: 'Invalid coupon code' }, 400);
    rate = COUPONS[code];
  }
  const total = Math.max(1, subtotal - Math.round(subtotal * rate)); // whole rupees

  // Basic abuse limit: 10 orders / 10 min / IP (uses the existing `attempts` table)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  await env.DB.prepare('DELETE FROM attempts WHERE ts < ?').bind(now - 3600000).run();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE ip = ? AND ts > ?')
    .bind(ip, now - 600000).first();
  if (row && row.n >= 10) return json({ error: 'Too many orders. Please try again in a few minutes.' }, 429);
  await env.DB.prepare('INSERT INTO attempts (ip, ts) VALUES (?, ?)').bind(ip, now).run();

  const ts = new Date(now).toISOString();
  const items = JSON.stringify(lines);
  const branch = 'Borkheda, Kota';

  if (method === 'COD') {
    const cid = newOrderId();
    await env.DB.prepare(
      `INSERT INTO orders (cid, ts, status, phone, name, branch, mode, pay, subtotal, total, items)
       VALUES (?, ?, 'COD', ?, ?, ?, 'Delivery', 'COD', ?, ?, ?)`
    ).bind(cid, ts, phone, name, branch, subtotal, total, items).run();
    return json({ orderId: cid, status: 'COD', total });
  }

  // Free up amounts held by orders whose window has passed
  await env.DB.prepare(`UPDATE orders SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at < ?`).bind(ts).run();

  // Reserve a unique payable amount (total + 0..19 paise). A partial unique index on
  // pending orders makes a clash fail, so we just try the next paise value.
  const expiresAt = new Date(now + WINDOW_MS).toISOString();
  for (let k = 0; k < SLOTS; k++) {
    const payPaise = total * 100 + k;
    const cid = newOrderId();
    try {
      await env.DB.prepare(
        `INSERT INTO orders (cid, ts, status, phone, name, branch, mode, pay, subtotal, total, items, pay_paise, expires_at)
         VALUES (?, ?, 'PENDING', ?, ?, ?, 'Delivery', 'UPI', ?, ?, ?, ?, ?)`
      ).bind(cid, ts, phone, name, branch, subtotal, total, items, payPaise, expiresAt).run();
      const amount = (payPaise / 100).toFixed(2);
      return json({ orderId: cid, status: 'PENDING', amount, expiresAt, upiUri: buildUpiUri(env, amount, cid) });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    }
  }
  return json({ error: 'We are very busy right now. Please try again in a minute.' }, 503);
}

function buildUpiUri(env, amount, orderId) {
  const p = new URLSearchParams({
    pa: env.UPI_VPA,
    pn: env.UPI_PAYEE_NAME || 'Hungerr Station',
    am: amount,
    cu: 'INR',
    tn: `Order ${orderId}`,
  });
  return 'upi://pay?' + p.toString().replace(/\+/g, '%20');
}

function newOrderId() {
  const r = crypto.getRandomValues(new Uint8Array(4));
  const rand = [...r].map(x => x.toString(36).padStart(2, '0')).join('').slice(0, 6).toUpperCase();
  return 'HS' + Date.now().toString(36).toUpperCase() + rand;
}

/* ---------------- order status (polled by the page) ---------------- */

async function orderStatus(request, env) {
  const orderId = new URL(request.url).searchParams.get('orderId') || '';
  if (!/^HS[A-Z0-9]{6,30}$/.test(orderId)) return json({ error: 'Bad order id' }, 400);
  const o = await env.DB.prepare('SELECT status, utr, expires_at FROM orders WHERE cid = ?').bind(orderId).first();
  if (!o) return json({ error: 'Not found' }, 404);
  let status = o.status;
  if (status === 'PENDING' && o.expires_at < new Date().toISOString()) {
    status = 'EXPIRED';
    await env.DB.prepare(`UPDATE orders SET status = 'EXPIRED' WHERE cid = ? AND status = 'PENDING'`).bind(orderId).run();
  }
  return json({ status, utr: status === 'PAID' ? o.utr : null });
}

/* ---------------- bank alert from the restaurant phone ---------------- */

async function bankAlert(request, env) {
  if (!env.NOTIFY_SECRET || !safeEqual(request.headers.get('Authorization') || '', `Bearer ${env.NOTIFY_SECRET}`)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const text = String(b.text || b.message || '').slice(0, 1000);
  const sender = String(b.sender || b.from || '').slice(0, 100);
  const sentTs = String(b.ts || b.timestamp || '').slice(0, 40);
  if (!text) return json({ error: 'Empty alert' }, 400);

  const now = new Date();
  const nowIso = now.toISOString();

  // Parse
  const am = /(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text);
  const paise = am ? Math.round(parseFloat(am[1].replace(/,/g, '')) * 100) : null;
  const utrM = /\b(\d{12})\b/.exec(text);
  const utr = utrM ? utrM[1] : null;

  // Classify
  let outcome = 'MATCHED_PENDING';
  const patternOk = !env.ALERT_MATCH_PATTERN || new RegExp(env.ALERT_MATCH_PATTERN, 'i').test(`${sender} ${text}`);
  const looksCredit = /(received|credited|paid you|payment of|deposit)/i.test(text) &&
                      !/(debited|sent to|withdrawn|paid to)/i.test(text);
  if (!patternOk) outcome = 'IGNORED_SOURCE';
  else if (!looksCredit) outcome = 'IGNORED_NOT_CREDIT';
  else if (!paise || paise <= 0) outcome = 'UNPARSED';

  // De-duplicate retries of the same alert
  const dedupe = utr ? `utr:${utr}` : 'h:' + await sha256(`${text}|${sender}|${sentTs || Math.floor(now.getTime() / 60000)}`);
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO bank_alerts (received_at, sender, body, amount_paise, utr, outcome, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(nowIso, sender, text, paise, utr, outcome === 'MATCHED_PENDING' ? 'UNMATCHED' : outcome, dedupe).run();
  if (ins.meta && ins.meta.changes === 0) return json({ ok: true, duplicate: true });
  const alertId = ins.meta.last_row_id;

  if (outcome !== 'MATCHED_PENDING') return json({ ok: true, outcome });

  // Match an order by exact payable amount
  let order = await env.DB.prepare(
    `SELECT cid FROM orders WHERE status = 'PENDING' AND pay_paise = ? AND expires_at >= ?`
  ).bind(paise, nowIso).first();
  let ref = 'BHARATPE-ALERT';
  if (!order) {
    order = await env.DB.prepare(
      `SELECT cid FROM orders WHERE status = 'EXPIRED' AND pay_paise = ? AND expires_at >= ?
       ORDER BY expires_at DESC LIMIT 1`
    ).bind(paise, new Date(now.getTime() - LATE_MATCH_MS).toISOString()).first();
    ref = 'BHARATPE-ALERT-LATE';
  }
  if (!order) return json({ ok: true, outcome: 'UNMATCHED' });

  const upd = await env.DB.prepare(
    `UPDATE orders SET status = 'PAID', paid_at = ?, utr = ?, payment_ref = ?
     WHERE cid = ? AND status IN ('PENDING', 'EXPIRED')`
  ).bind(nowIso, utr, ref, order.cid).run();
  if (upd.meta && upd.meta.changes > 0) {
    await env.DB.prepare(`UPDATE bank_alerts SET outcome = 'MATCHED', matched_cid = ? WHERE id = ?`)
      .bind(order.cid, alertId).run();
    return json({ ok: true, outcome: 'MATCHED', orderId: order.cid });
  }
  return json({ ok: true, outcome: 'UNMATCHED' });
}

/* ---------------- helpers ---------------- */

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
