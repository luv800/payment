// functions/api/[[route]].js

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  // 1. CORS Preflight
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

  // 2. Handle both /api/payments/create and /api/v1/payments endpoints
  if (path.endsWith('/payments/create') || path.endsWith('/v1/payments') || path.endsWith('/payments')) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return handleCreatePayment(context);
  }

  // 3. Handle webhook
  if (path.endsWith('/payments/webhook')) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return handleGatewayWebhook(context);
  }

  return Response.json(
    { error: `Endpoint not found: ${url.pathname}` }, 
    { status: 404 }
  );
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

    // Your UPI Merchant VPA (Update this or set UPI_VPA in Cloudflare Dashboard variables)
    const upiVpa = env.UPI_VPA || '9462942290@okbizaxis';
    const payeeName = env.UPI_PAYEE_NAME || 'Hungerr Station';
    const note = `Order ${orderId}`;

    // Standard NPCI UPI URI Scheme
    const upiUri = `upi://pay?pa=${encodeURIComponent(upiVpa)}&pn=${encodeURIComponent(payeeName)}&am=${Number(amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}&tr=${encodeURIComponent(orderId)}`;

    // Persist pending order to Cloudflare D1
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
        console.warn('D1 Insert warning:', dbErr.message);
      }
    }

    return Response.json({
      success: true,
      orderId: orderId,
      amount: Number(amount).toFixed(2),
      upiUri: upiUri,
      qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiUri)}`,
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

// 2. Gateway Webhook
async function handleGatewayWebhook(context) {
  const { request, env } = context;
  const rawBody = await request.text();

  try {
    const event = JSON.parse(rawBody);

    if (env.DB && event.orderId) {
      if (event.status === 'SUCCESS' || event.event === 'SUCCESS') {
        await env.DB.prepare(
          `UPDATE orders SET status = 'PAID', payment_ref = ?, utr = ? WHERE cid = ?`
        ).bind(event.paymentId || 'MANUAL-UPI', event.utr || '', event.orderId).run();
      }
    }

    return Response.json({ received: true }, { status: 200 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}