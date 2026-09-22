// WayMark — Camp Supplies shop helper (Cloudflare Worker)
//
// Takes the money with Stripe (embedded checkout, so nobody leaves
// waymark.it.com) and sends each paid order to Printful to be printed and
// posted. It stores nothing itself: Stripe holds the payment, Printful holds
// the order, and the Stripe session id links the two.
//
//   GET  /catalog               → what is on sale: name, kind, price, options (public)
//   POST /checkout {items:[{k, opt, qty}], code}
//                               → a Stripe embedded-checkout session for a basket;
//                                 returns client_secret. {n, size} still works for one tee.
//   GET  /code?c=SUMMIT10       → is this discount code live, and what is it worth
//   GET  /status?session=cs_…   → paid or not, for the thank-you screen
//   POST /stripe-webhook        → Stripe calls this when a payment completes
//   GET  /printful/variants?product=ID → Printful's sizes/colours for a garment (setup helper)
//   GET  /health                → is everything set?
//
// Settings → Variables and Secrets:
//   STRIPE_SECRET_KEY      (secret)  sk_test_… first, sk_live_… when ready
//   STRIPE_WEBHOOK_SECRET  (secret)  whsec_… from the webhook you add in Stripe
//   PRINTFUL_TOKEN         (secret)  private token from developers.printful.com
//   PRINTFUL_STORE_ID      (plain)   the id of your "Manual order / API" store
//   PRINTFUL_CONFIRM       (plain)   "false" = orders land as drafts you approve; "true" = straight to print
//   SHIPPING_PENCE         (plain)   UK postage charged per order, e.g. 399
//   FREE_OVER_PENCE        (plain)   goods total at which delivery is free, e.g. 5000 (leave out for never)
//   ALLOWED_ORIGIN         (plain)   https://waymark.it.com
//   SHOP_CATALOG           (plain)   JSON — see SHOP-SETUP.md. Example:
//   Every entry is a product. Tees keep their design number as the key; anything
//   else (stickers, caps, beanies, bottles, patches, neck gaiters…) gets any key
//   you like and a "kind". Optional: "img" (picture URLs for the shop),
//   "blurb" (one line), "opt" (what the choice is called: Size, Colour, Pack…).
//     {"13":{"name":"Mark Your Journeys","price":2800,
//            "variants":{"S":11546,"M":11547,"L":11548,"XL":11549},
//            "files":{"back":"https://waymark.it.com/print/13-back.png",
//                     "front":"https://waymark.it.com/print/13-front.png"}}}

const STRIPE = 'https://api.stripe.com/v1';
const PRINTFUL = 'https://api.printful.com';

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || 'https://waymark.it.com').split(',')
      .map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
      .flatMap(o => [o, o.replace('://', '://www.')]);
    const okOrigin = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      // Stripe calls this one directly: no browser, no Origin, so it is checked by signature instead
      if (req.method === 'POST' && path === '/stripe-webhook') return await webhook(req, env);
      // /alert-test?key=<first 8 characters of NTFY_TOPIC> sends a test push and email
      if (req.method === 'GET' && path === '/alert-test') {
        if (!env.NTFY_TOPIC || url.searchParams.get('key') !== env.NTFY_TOPIC.slice(0, 8)) return new Response('no', { status: 403 });
        await alertJoe(env, 'Test alert from the WayMark shop', 'If you can read this, order alerts are working.', true);
        return new Response('sent', { status: 200 });
      }

      if (req.method === 'GET' && (path === '/' || path === '/health')) {
        let cat = null; try { cat = catalog(env); } catch (e) {}
        return json({ waymark: 'shop-helper', ok: true,
          stripe: !!env.STRIPE_SECRET_KEY, stripeMode: (env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live' : 'test',
          webhook: !!env.STRIPE_WEBHOOK_SECRET, printful: !!env.PRINTFUL_TOKEN, store: !!env.PRINTFUL_STORE_ID,
          printfulConfirm: env.PRINTFUL_CONFIRM === 'true', alertPush: !!env.NTFY_TOPIC, alertEmail: !!env.RESEND_API_KEY, version: 'v191', onSale: cat ? Object.keys(cat).length : 'SHOP_CATALOG is not valid JSON'
        }, 200, { ...cors, 'Access-Control-Allow-Origin': '*' });
      }

      if (req.method === 'GET' && path === '/catalog') {
        const cat = catalog(env), out = {};
        for (const [n, d] of Object.entries(cat)) out[n] = { price: d.price, sizes: Object.keys(d.variants || {}),
          kind: d.kind || 'tee', name: d.name || '', img: d.img || [], blurb: d.blurb || '', opt: d.opt || (d.kind && d.kind !== 'tee' ? 'Option' : 'Size'),
          details: d.details || [] };
        return json({ currency: 'gbp', shipping: +env.SHIPPING_PENCE || 0, freeOver: +env.FREE_OVER_PENCE || 0, items: out }, 200,
          { ...cors, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=120' });
      }

      if (req.method === 'GET' && path === '/printful/variants') {
        const id = String(url.searchParams.get('product') || '').replace(/\D/g, '');
        if (!id) return json({ message: 'Add ?product=<Printful catalog product id>' }, 400, cors);
        const r = await pf(env, 'GET', '/products/' + id);
        const vs = (r.result && r.result.variants || []).map(v => ({ id: v.id, size: v.size, colour: v.color, code: v.color_code, inStock: v.in_stock }));
        return json({ product: r.result && r.result.product && r.result.product.title, variants: vs }, 200, { ...cors, 'Access-Control-Allow-Origin': '*' });
      }

      if (!okOrigin) return json({ message: 'Not allowed from ' + (origin || 'no origin') }, 403, cors);

      if (req.method === 'GET' && path === '/code') {
        const c = await promo(env, url.searchParams.get('c'));
        if (!c) return json({ ok: false, message: 'That code isn\u2019t valid.' }, 200, cors);
        return json({ ok: true, code: c.code, percent: c.percent || 0, amount: c.amount || 0, min: c.min || 0, label: c.label }, 200, cors);
      }

      if (req.method === 'POST' && path === '/checkout') {
        const body = await req.json();
        const cat = catalog(env);
        // a basket, or one tee from an older page
        const want = Array.isArray(body.items) ? body.items : [{ k: body.n, opt: body.size, qty: 1 }];
        const lines = [];
        for (const w of want.slice(0, 12)) {
          const k = String(w.k), d = cat[k];
          if (!d) return json({ message: 'Something in your backpack is no longer on sale.' }, 404, cors);
          const variant = d.variants && d.variants[w.opt];
          if (!variant) return json({ message: 'Choose a ' + (d.opt || 'size').toLowerCase() + ' for ' + (d.name || 'that item') + '.' }, 400, cors);
          const qty = Math.max(1, Math.min(10, Math.floor(+w.qty || 1)));
          const same = lines.find(l => l.k === k && l.opt === w.opt);
          if (same) same.qty = Math.min(10, same.qty + qty); else lines.push({ k, opt: String(w.opt), qty, d, variant });
        }
        if (!lines.length) return json({ message: 'Your backpack is empty.' }, 400, cors);
        // free delivery is judged on the goods, before any code — the same rule the app shows
        const goods = lines.reduce((a, l) => a + l.d.price * l.qty, 0);
        const freeOver = +env.FREE_OVER_PENCE || 0;
        const post = freeOver && goods >= freeOver ? 0 : (+env.SHIPPING_PENCE || 0);
        const f = new URLSearchParams({
          'ui_mode': 'embedded_page',   // Stripe renamed 'embedded' in API 2026-03-25 (dahlia)
          'mode': 'payment',
          'redirect_on_completion': 'never',
          'shipping_address_collection[allowed_countries][0]': 'GB',
          'phone_number_collection[enabled]': 'true',
          'shipping_options[0][shipping_rate_data][type]': 'fixed_amount',
          'shipping_options[0][shipping_rate_data][display_name]': post ? 'UK delivery' : 'Free UK delivery',
          'shipping_options[0][shipping_rate_data][fixed_amount][amount]': String(post),
          'shipping_options[0][shipping_rate_data][fixed_amount][currency]': 'gbp',
          'shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]': 'business_day',
          'shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]': '4',
          'shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]': 'business_day',
          'shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]': '10',
          // the basket, compact: key~option~qty per line (Stripe metadata holds 500 characters)
          'metadata[cart]': lines.map(l => [l.k, l.opt, l.qty].map(x => String(x).replace(/[~,]/g, '')).join('~')).join(',').slice(0, 500)
        });
        lines.forEach((l, i) => {
          f.set('line_items[' + i + '][quantity]', String(l.qty));
          f.set('line_items[' + i + '][price_data][currency]', 'gbp');
          f.set('line_items[' + i + '][price_data][unit_amount]', String(l.d.price));
          f.set('line_items[' + i + '][price_data][product_data][name]', (l.d.name || ('WayMark ' + (l.d.kind || 'tee'))) + (l.opt && l.opt !== 'One size' ? ' — ' + l.opt : ''));
        });
        // a code typed in the basket is applied here; otherwise Stripe's own box is offered
        const code = body.code ? await promo(env, body.code) : null;
        if (body.code && !code) return json({ message: 'That discount code isn\u2019t valid any more.' }, 400, cors);
        if (code) f.set('discounts[0][promotion_code]', code.id);
        else f.set('allow_promotion_codes', 'true');
        const s = await stripe(env, 'POST', '/checkout/sessions', f);
        return json({ clientSecret: s.client_secret, id: s.id }, 200, cors);
      }

      if (req.method === 'GET' && path === '/status') {
        const id = String(url.searchParams.get('session') || '');
        if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return json({ message: 'Bad session' }, 400, cors);
        const s = await stripe(env, 'GET', '/checkout/sessions/' + id);
        return json({ status: s.status, paid: s.payment_status === 'paid', email: s.customer_details && s.customer_details.email || '' }, 200, cors);
      }

      return json({ message: 'Not found' }, 404, cors);
    } catch (e) {
      return json({ message: e.message || 'Shop helper error' }, 502, cors);
    }
  }
};

/* ---- a paid order becomes a Printful order ---- */
// Every webhook goes through here, so anything that goes wrong after a customer
// has paid reaches Joe: a push to his phone (ntfy) and an email (Resend).
async function webhook(req, env) {
  const body = await req.text();
  let ev = null; try { ev = JSON.parse(body); } catch (e) {}
  let res;
  try { res = await webhookInner(body, req, env); }
  catch (e) { res = new Response('error: ' + (e && e.message), { status: 500 }); }
  // Stripe retries a failed webhook for three days; only the first attempt
  // (within 15 minutes of the payment) raises the alarm, so it isn't repeated
  const fresh = ev && ev.created && (Date.now() / 1000 - ev.created) < 900;
  if (res.status >= 500 && fresh && ev.data && ev.data.object) {
    const s = ev.data.object, why = await res.clone().text();
    const who = (s.customer_details && (s.customer_details.name || s.customer_details.email)) || 'a customer';
    await alertJoe(env, 'Paid order did NOT reach Printful',
      who + ' paid £' + ((s.amount_total || 0) / 100).toFixed(2) + ' for ' + ((s.metadata && (s.metadata.cart || (s.metadata.n + ' ' + s.metadata.size))) || 'an order') + '.\n' +
      'Reason: ' + why.slice(0, 400) + '\n\n' +
      'Stripe keeps retrying for 3 days. Fix the cause, or place the order in Printful by hand, then check Stripe → Developers → Webhooks.\n' +
      'Stripe session: ' + s.id, true);
  }
  return res;
}

async function alertJoe(env, title, text, urgent) {
  const jobs = [];
  if (env.NTFY_TOPIC) jobs.push(fetch('https://ntfy.sh/' + env.NTFY_TOPIC, { method: 'POST', body: text,
    headers: { Title: title, Priority: urgent ? 'urgent' : 'default', Tags: urgent ? 'warning' : 'shirt' } }));
  if (urgent && env.RESEND_API_KEY) jobs.push(fetch('https://api.resend.com/emails', { method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.ALERT_FROM || 'WayMark Shop <shop@waymark.it.com>', to: [env.ALERT_EMAIL || 'contact@waymark.it.com'], subject: '⚠ ' + title, text }) }));
  await Promise.allSettled(jobs);
}

async function webhookInner(body, req, env) {
  if (!(await verifyStripe(body, req.headers.get('Stripe-Signature') || '', env.STRIPE_WEBHOOK_SECRET)))
    return new Response('bad signature', { status: 400 });
  const ev = JSON.parse(body);
  if (ev.type !== 'checkout.session.completed' && ev.type !== 'checkout.session.async_payment_succeeded')
    return new Response('ignored', { status: 200 });
  const s = ev.data.object;
  if (s.payment_status !== 'paid') return new Response('not paid yet', { status: 200 });

  const cat = catalog(env);
  const cart = s.metadata.cart
    ? s.metadata.cart.split(',').map(x => { const [k, opt, q] = x.split('~'); return { k, opt, qty: +q || 1 }; })
    : [{ k: String(s.metadata.n), opt: s.metadata.size, qty: 1 }];
  const items = [];
  for (const l of cart) {
    const d = cat[l.k];
    if (!d) return new Response('unknown product ' + l.k, { status: 500 });   // Stripe retries; fix the catalog
    const variant = d.variants && d.variants[l.opt];
    if (!variant) return new Response('unknown option ' + l.opt + ' for ' + l.k, { status: 500 });
    items.push({ variant_id: +variant, quantity: l.qty,
      files: Object.entries(d.files || {}).map(([type, u]) => ({ type, url: u })),
      name: (d.name || 'WayMark') + (l.opt && l.opt !== 'One size' ? ' — ' + l.opt : ''),
      // what the customer paid for one: Printful shows it on the order and packing slip
      retail_price: (d.price / 100).toFixed(2) });
  }
  const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || {};
  const a = ship.address || (s.customer_details && s.customer_details.address) || {};
  const order = {
    // The Stripe session id is the order's external id, so a webhook that
    // arrives twice cannot print the shirt twice — Printful refuses the repeat.
    external_id: s.id.slice(-32),
    shipping: 'STANDARD',
    recipient: {
      name: ship.name || (s.customer_details && s.customer_details.name) || '',
      address1: a.line1 || '', address2: a.line2 || '', city: a.city || '',
      zip: a.postal_code || '', country_code: a.country || 'GB',
      email: s.customer_details && s.customer_details.email || '',
      phone: s.customer_details && s.customer_details.phone || ''
    },
    // retail_price is what the customer paid for the tee: Printful shows it on the
    // order's pricing breakdown and packing slip (without it, it reads as £0)
    items,
    // The packing slip: WayMark's logo (1-bit, Printful prints it mono), a
    // readable order number, the shop's contact and a short note from Joe.
    packing_slip: {
      store_name: 'WayMark',
      logo_url: (env.PUBLIC_ORIGIN || 'https://waymark.it.com') + '/print/packing-slip-logo.png',
      custom_order_id: 'WM-' + s.id.slice(-6).toUpperCase(),
      email: env.SHOP_EMAIL || 'contact@waymark.it.com',
      message: env.PACKING_MESSAGE || "Thanks for walking with WayMark. Wherever this tee ends up, snap it and tag us on Instagram @waymark.it. We'd love to see where it goes. Log every hill you climb at waymark.it.com. Wash inside out on a cool wash. Questions: contact@waymark.it.com. Joe"
    },
    retail_costs: { currency: 'GBP', subtotal: (s.amount_subtotal / 100).toFixed(2),
      discount: ((s.total_details && s.total_details.amount_discount || 0) / 100).toFixed(2),
      shipping: ((s.total_details && s.total_details.amount_shipping || 0) / 100).toFixed(2), total: (s.amount_total / 100).toFixed(2) }
  };
  const confirm = env.PRINTFUL_CONFIRM === 'true' ? '?confirm=true' : '';
  const r = await pf(env, 'POST', '/orders' + confirm, order, true);
  if (r.code === 200) {
    await alertJoe(env, 'New order · £' + ((s.amount_total || 0) / 100).toFixed(2),
      items.map(i => i.quantity + ' × ' + i.name).join('\n') + '\n' + (order.recipient.city || 'UK') +
      (+order.retail_costs.discount ? ' · £' + order.retail_costs.discount + ' off' : '') + (confirm ? '' : ' (draft — confirm it in Printful)'), false);
    return new Response('ok', { status: 200 });
  }
  // already made for this payment: fine
  if (JSON.stringify(r).toLowerCase().includes('external')) return new Response('duplicate', { status: 200 });
  // anything else: 500 so Stripe keeps retrying (for 3 days) and it shows red in the Stripe dashboard
  return new Response('printful: ' + JSON.stringify(r).slice(0, 500), { status: 500 });
}

async function verifyStripe(payload, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const t = parts.t, sigs = header.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - +t) > 600) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + payload));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => s.length === hex.length && timingSafe(s, hex));
}
function timingSafe(a, b) { let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }

function catalog(env) { return JSON.parse(env.SHOP_CATALOG || '{}'); }
// A promotion code made in Stripe (Product catalogue → Coupons → add a code).
// Codes are matched without caring about case; expired, used-up or switched-off
// codes come back as null.
async function promo(env, raw) {
  const code = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
  if (!code) return null;
  const r = await stripe(env, 'GET', '/promotion_codes?active=true&limit=1&code=' + encodeURIComponent(code));
  const pc = r && r.data && r.data[0];
  if (!pc) return null;
  let cp = pc.coupon || (pc.promotion && pc.promotion.coupon);
  if (typeof cp === 'string') cp = await stripe(env, 'GET', '/coupons/' + encodeURIComponent(cp));
  if (!cp || cp.valid === false) return null;
  const pct = cp.percent_off || 0, amt = cp.amount_off || 0;
  const min = pc.restrictions && pc.restrictions.minimum_amount || 0;
  return { id: pc.id, code: pc.code, percent: pct, amount: amt, min,
    label: pct ? pct + '% off' : amt ? '£' + (amt / 100).toFixed(amt % 100 ? 2 : 0) + ' off' : 'Discount' };
}
async function stripe(env, method, p, form) {
  const r = await fetch(STRIPE + p, { method, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
    ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? form.toString() : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe error');
  return j;
}
async function pf(env, method, p, body, raw) {
  const r = await fetch(PRINTFUL + p, { method, headers: { Authorization: 'Bearer ' + env.PRINTFUL_TOKEN,
    ...(env.PRINTFUL_STORE_ID ? { 'X-PF-Store-Id': env.PRINTFUL_STORE_ID } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({ code: r.status }));
  if (raw) return j;
  if (!r.ok) throw new Error((j.error && j.error.message) || j.result || 'Printful error');
  return j;
}
function json(o, status, h) { return new Response(JSON.stringify(o), { status, headers: { ...h, 'Content-Type': 'application/json' } }); }
