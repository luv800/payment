// functions/api/[[route]].js

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  // CORS Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Merchant-Id, x-gateway-signature',
      },
    });
  }

  // 1. Order / Payment Session Creation
  if (path.endsWith('/payments/create') || path.endsWith('/v1/payments')) {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    return handleCreateYoupiPayment(context);
  }

  // 2. YouPI Webhook Verification
  if (path.endsWith('/payments/webhook')) {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    return handleYoupiWebhook(context);
  }

  return Response.json({ error: `Endpoint not found: ${url.pathname}` }, { status: 404 });
}

async function handleCreateYoupiPayment(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { orderId, amount, customerPhone, customerName, branch, items, coupon } = body;

    if (!orderId || !amount) {
      return Response.json({ error: 'Missing required order details' }, { status: 400 });
    }

    // Persist order in D1
    if (env.DB) {
      const ts = new Date().toISOString();
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO orders (cid, ts, status, phone, name, branch, mode, pay, subtotal, total, items)
           VALUES (?, ?, 'PENDING', ?, ?, ?, 'Delivery', 'YouPI', ?, ?, ?)`
        ).bind(
          orderId,
          ts,
          customerPhone || '9462942290',
          customerName || 'Guest',
          branch || 'Borkheda',
          amount,
          amount,
          JSON.stringify(items || [])
        ).run();
      } catch (dbErr) {
        console.warn('D1 insert error:', dbErr.message);
      }
    }

    // Contact YouPI-PG Gateway API
    const youpiApiUrl = (env.YOUPI_API_URL || 'https://creditpay.pages.dev').replace(/\/+$/, '');
    const origin = new URL(request.url).origin;

    const gatewayRes = await fetch(`${youpiApiUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': env.YOUPI_MERCHANT_ID || 'hungerr-station',
      },
      body: JSON.stringify({
        orderId: orderId,
        amount: Number(amount).toFixed(2),
        currency: 'INR',
        returnUrl: `${origin}/?payment_status=complete&order_id=${encodeURIComponent(orderId)}`,
      }),
    });

    const data = await gatewayRes.json();
    if (!gatewayRes.ok) {
      throw new Error(data.error || 'Failed to initiate YouPI payment session');
    }

    return Response.json({
      success: true,
      orderId: orderId,
      checkoutUrl: data.checkoutUrl,
      paymentId: data.paymentId || data.id,
    }, {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return Response.json({ error: err.message }, {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }
}

async function handleYoupiWebhook(context) {
  const { request, env } = context;
  const signature = request.headers.get('x-gateway-signature');
  const rawBody = await request.text();

  if (!signature) {
    return new Response('Missing gateway signature', { status: 400 });
  }

  try {
    const webhookSecret = env.YOUPI_WEBHOOK_SECRET || '';
    if (webhookSecret) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(webhookSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
      );

      const sigHex = signature.replace(/^sha256=/, '');
      const sigBytes = hexToBytes(sigHex);
      const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(rawBody));

      if (!isValid) {
        return new Response('Invalid webhook signature', { status: 400 });
      }
    }

    const event = JSON.parse(rawBody);

    if (env.DB && event.orderId) {
      if (event.event === 'SUCCESS' || event.status === 'SUCCESS') {
        await env.DB.prepare(
          `UPDATE orders SET status = 'PAID', payment_ref = ?, utr = ? WHERE cid = ?`
        ).bind(event.paymentId || event.id || '', event.utr || '', event.orderId).run();
      } else {
        await env.DB.prepare(
          `UPDATE orders SET status = ? WHERE cid = ?`
        ).bind(event.event || 'FAILED', event.orderId).run();
      }
    }

    return Response.json({ received: true }, { status: 200 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
