export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS pre-flight
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

  // Handle payment session creation
  if (path === '/api/payments/create') {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return handleCreatePayment(context);
  }

  // Handle gateway webhook
  if (path === '/api/payments/webhook') {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return handleGatewayWebhook(context);
  }

  return Response.json({ error: 'Endpoint not found' }, { status: 404 });
}

// 1. Create Payment Session
async function handleCreatePayment(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { orderId, amount, customerPhone, customerName, branch, items } = body;

    if (!orderId || !amount) {
      return Response.json({ error: 'Missing required order details' }, { status: 400 });
    }

    // Persist pending order to Cloudflare D1
    if (env.DB) {
      const ts = new Date().toISOString();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO orders (cid, ts, status, phone, name, branch, mode, pay, subtotal, total, items)
         VALUES (?, ?, 'PENDING', ?, ?, ?, 'Delivery', 'YouPI', ?, ?, ?)`
      ).bind(
        orderId,
        ts,
        customerPhone || 'N/A',
        customerName || 'Guest',
        branch || 'Borkheda',
        amount,
        amount,
        JSON.stringify(items || [])
      ).run();
    }

    // Connect to YouPI Gateway
    const gatewayUrl = (env.YOUPI_API_URL || 'https://creditpay.pages.dev').replace(/\/+$/, '');
    const origin = new URL(request.url).origin;

    const response = await fetch(`${gatewayUrl}/api/v1/payments`, {
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

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to initiate gateway session');
    }

    return Response.json({
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

// 2. Gateway Webhook with HMAC-SHA256 Verification & D1 Updates
async function handleGatewayWebhook(context) {
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

    // Sync order state in D1
    if (env.DB && event.orderId) {
      switch (event.event) {
        case 'SUCCESS':
          await env.DB.prepare(
            `UPDATE orders SET status = 'PAID', payment_ref = ?, utr = ? WHERE cid = ?`
          ).bind(event.paymentId || event.id || '', event.utr || '', event.orderId).run();
          break;
        case 'FAILED':
        case 'EXPIRED':
        case 'CANCELLED':
          await env.DB.prepare(
            `UPDATE orders SET status = ? WHERE cid = ?`
          ).bind(event.event, event.orderId).run();
          break;
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