// hungerr-station-admin/functions/api/[[route]].js

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // Handle payment creation route
  if (path.startsWith('/api/payments/create')) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return handleCreateYoupiPayment(context);
  }

  // Handle payment webhook notification route
  if (path.startsWith('/api/payments/webhook')) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    return handleYoupiWebhook(context);
  }

  return Response.json({ error: 'Endpoint not found' }, { status: 404 });
}

// 1. Create Payment Session
async function handleCreateYoupiPayment(context) {
  const { request, env } = context;
  
  try {
    const body = await request.json();

    const response = await fetch(`${env.YOUPI_API_URL}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': env.YOUPI_MERCHANT_ID,
      },
      body: JSON.stringify({
        orderId: body.orderId,
        amount: body.amount,
        currency: 'INR',
        returnUrl: `${new URL(request.url).origin}/checkout/complete`,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to create YouPI payment session');
    }

    return Response.json(data, { status: 200 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// 2. Webhook Handler with Cloudflare D1 Database Integration
async function handleYoupiWebhook(context) {
  const { request, env } = context;
  const signature = request.headers.get('x-gateway-signature');
  const rawBody = await request.text();

  if (!signature) {
    return new Response('Missing signature', { status: 400 });
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.YOUPI_WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes = hexToBytes(signature.replace('sha256=', ''));
    const valid = await crypto.subtle.importKey && await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(rawBody));

    if (!valid) {
      return new Response('Invalid signature', { status: 400 });
    }

    const event = JSON.parse(rawBody);

    // Update your Cloudflare D1 database orders table automatically on webhook events
    if (env.DB) {
      switch (event.event) {
        case 'SUCCESS':
          await env.DB.prepare(
            `UPDATE orders SET status = ?, payment_ref = ? WHERE id = ? OR order_id = ?`
          ).bind('PAID', event.utr || event.paymentId, event.orderId, event.orderId).run();
          break;
        case 'FAILED':
        case 'EXPIRED':
        case 'CANCELLED':
          await env.DB.prepare(
            `UPDATE orders SET status = ? WHERE id = ? OR order_id = ?`
          ).bind('FAILED', event.orderId, event.orderId).run();
          break;
      }
    }

    return Response.json({ received: true }, { status: 200 });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// Helper utility for hex to byte conversion
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}