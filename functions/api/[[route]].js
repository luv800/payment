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

  // 2. Handle payment initiation (supports both UPI and Card)
  if (path.endsWith('/payments/create') || path.endsWith('/v1/payments') || path.endsWith('/payments')) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return handleCreatePayment(context);
  }

  // 3. Webhook handling
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

async function handleCreatePayment(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { 
      orderId, 
      amount, 
      paymentMethod, 
      cardLast4, 
      cardHolder, 
      customerPhone, 
      customerName, 
      branch, 
      items 
    } = body;

    if (!orderId || !amount) {
      return Response.json({ error: 'Missing required order details' }, { status: 400 });
    }

    const payMode = paymentMethod === 'CARD' ? `CARD (Ending ${cardLast4})` : 'UPI';
    const authRef = Math.random().toString(36).substring(2, 9).toUpperCase();

    // Persist order to Cloudflare D1
    if (env.DB) {
      const ts = new Date().toISOString();
      const status = paymentMethod === 'CARD' ? 'PAID' : 'PENDING';
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO orders (cid, ts, status, phone, name, branch, mode, pay, subtotal, total, items, payment_ref)
           VALUES (?, ?, ?, ?, ?, ?, 'Delivery', ?, ?, ?, ?, ?)`
        ).bind(
          orderId,
          ts,
          status,
          customerPhone || '9462942290',
          customerName || cardHolder || 'Guest',
          branch || 'Borkheda',
          payMode,
          amount,
          amount,
          JSON.stringify(items || []),
          paymentMethod === 'CARD' ? `CARD-${authRef}` : null
        ).run();
      } catch (dbErr) {
        console.warn('D1 insert error:', dbErr.message);
      }
    }

    // Response for Card
    if (paymentMethod === 'CARD') {
      return Response.json({
        success: true,
        orderId: orderId,
        paymentMethod: 'CARD',
        authRef: authRef,
        amount: Number(amount).toFixed(2)
      }, {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Response for UPI with your updated BharatPe UPI ID
    const upiVpa = env.UPI_VPA || 'BHARATPE.9V0C0B1Y6C197301@unitype';
    const payeeName = env.UPI_PAYEE_NAME || 'Hungerr Station';
    const note = `Order ${orderId}`;
    const upiUri = `upi://pay?pa=${encodeURIComponent(upiVpa)}&pn=${encodeURIComponent(payeeName)}&am=${Number(amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}&tr=${encodeURIComponent(orderId)}`;

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

async function handleGatewayWebhook(context) {
  const { request, env } = context;
  const rawBody = await request.text();

  try {
    const event = JSON.parse(rawBody);
    if (env.DB && event.orderId) {
      if (event.status === 'SUCCESS' || event.event === 'SUCCESS') {
        await env.DB.prepare(
          `UPDATE orders SET status = 'PAID', payment_ref = ?, utr = ? WHERE cid = ?`
        ).bind(event.paymentId || 'GATEWAY-PAID', event.utr || '', event.orderId).run();
      }
    }
    return Response.json({ received: true }, { status: 200 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}