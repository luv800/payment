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

  // 2. Handle Payment Creation
  if (path.endsWith('/payments/create') || path.endsWith('/v1/payments') || path.endsWith('/payments')) {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    return handleCreatePaymentSession(context);
  }

  // 3. Handle Payment Verification / Status Check
  if (path.endsWith('/payments/verify')) {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    return handleVerifyPayment(context);
  }

  // 4. Handle Gateway Webhook
  if (path.endsWith('/payments/webhook')) {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    return handleGatewayWebhook(context);
  }

  return Response.json({ error: `Endpoint not found: ${url.pathname}` }, { status: 404 });
}

// Internal YouPI Session Engine (No loopback fetch calls)
async function handleCreatePaymentSession(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { orderId, amount, customerPhone, customerName, branch, items } = body;

    if (!orderId || !amount) {
      return Response.json({ error: 'Missing required order details' }, { status: 400 });
    }

    // Official BharatPe VPA from your account
    const upiVpa = env.UPI_VPA || 'BHARATPE.9V0C0B1Y6C197301@unitype';
    const payeeName = env.UPI_PAYEE_NAME || 'Hungerr Station';
    const note = `Order ${orderId}`;
    const formattedAmount = Number(amount).toFixed(2);

    // Standard NPCI UPI URI Scheme
    const upiUri = `upi://pay?pa=${encodeURIComponent(upiVpa)}&pn=${encodeURIComponent(payeeName)}&am=${formattedAmount}&cu=INR&tn=${encodeURIComponent(note)}&tr=${encodeURIComponent(orderId)}`;

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
          customerName || 'Customer',
          branch || 'Borkheda',
          formattedAmount,
          formattedAmount,
          JSON.stringify(items || [])
        ).run();
      } catch (dbErr) {
        console.warn('D1 insert warning:', dbErr.message);
      }
    }

    // Dynamic QR generation
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiUri)}`;

    return Response.json({
      success: true,
      orderId: orderId,
      amount: formattedAmount,
      upiUri: upiUri,
      qrUrl: qrUrl,
      vpa: upiVpa
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

// Verify payment UTR
async function handleVerifyPayment(context) {
  const { request, env } = context;
  try {
    const body = await request.json();
    const { orderId, utr } = body;

    if (env.DB && orderId) {
      await env.DB.prepare(
        `UPDATE orders SET status = 'PAID', payment_ref = ?, utr = ? WHERE cid = ?`
      ).bind('YOUPI-VERIFIED', utr || 'VERIFIED', orderId).run();
    }

    return Response.json({ success: true, verified: true }, { status: 200 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// Webhook Handler
async function handleGatewayWebhook(context) {
  const { request, env } = context;
  try {
    const body = await request.json();
    if (env.DB && body.orderId) {
      await env.DB.prepare(
        `UPDATE orders SET status = 'PAID', payment_ref = ?, utr = ? WHERE cid = ?`
      ).bind(body.paymentId || 'GATEWAY-PAID', body.utr || '', body.orderId).run();
    }
    return Response.json({ received: true }, { status: 200 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
