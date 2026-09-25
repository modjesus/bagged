// WayMark — Camp Supplies shop helper (Cloudflare Worker)
//
// Takes the money with Stripe (embedded checkout, so nobody leaves
// waymark.it.com) and sends each paid order to Inkthreadable to be printed
// and posted. It stores nothing itself: Stripe holds the payment,
// Inkthreadable holds the order, and the Stripe session id links the two.
//
// Moved from Printful on 24 Sep 2026. The previous file is kept beside this
// one as shop-worker-printful.js, so reverting is a re-upload, not a rewrite.
//
//   GET  /catalog               → what is on sale: name, kind, price, options (public)
//   POST /checkout {items:[{k, opt, qty}], code}
//                               → a Stripe embedded-checkout session for a basket;
//                                 returns client_secret. {n, size} still works for one tee.
//   GET  /code?c=SUMMIT10       → is this discount code live, and what is it worth
//   GET  /status?session=cs_…   → paid or not, for the thank-you screen
//   POST /stripe-webhook        → Stripe calls this when a payment completes
//   GET  /orders/recent?key=…    → the last 10 orders at Inkthreadable and their status
//   GET  /order?id=…&key=…      → one order AS INKTHREADABLE STORED IT, including the
//                                 designs attached to each line. Their dashboard draws
//                                 its preview from `mockups`, which we do not send, so
//                                 an empty preview there proves nothing.
//   GET  /health                → is everything set?
//
// Settings → Variables and Secrets:
//   STRIPE_SECRET_KEY      (secret)  sk_test_… first, sk_live_… when ready
//   STRIPE_WEBHOOK_SECRET  (secret)  whsec_… from the webhook you add in Stripe
//   INKTHREADABLE_APP_ID   (plain)   AppId from Inkthreadable → Your account → Integrations → API settings
//   INKTHREADABLE_SECRET   (secret)  the Secret key from that same page. Type it straight into
//                                    Cloudflare; it must never land in a file or a screenshot.
//   INKTHREADABLE_BRAND    (plain)   optional, the Brand Profile name to print on the invoice
//   SHOP_ADMIN_KEY         (secret)  optional, guards /orders/recent
//   (Inkthreadable has no draft mode: an order posted is an order placed.)
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
const INK = 'https://www.inkthreadable.co.uk';

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
        /* ?refresh=1 drops the cached catalogue, so a fix can be proved to have
           landed without waiting out a TTL or redeploying. */
        if (url.searchParams.get('refresh')) catalogForget();
        let cat = null; try { cat = await catalog(env); } catch (e) {}
        /* what artwork WOULD be sent for the first sticker: the one thing that
           could not be checked without spending a real order. */
        let sample = null;
        try {
          const e0 = Object.entries(cat || {}).find(([k, v]) => v && v.kind === 'sticker');
          if (e0) {
            const opt = Object.keys(e0[1].optFiles || {})[0] || '';
            sample = { key: e0[0], opt, designs: designsFor(env, e0[1], opt) };
          }
        } catch (e) { sample = { error: String(e && e.message || e).slice(0, 80) }; }
        return json({ waymark: 'shop-helper', ok: true,
          stripe: !!env.STRIPE_SECRET_KEY, stripeMode: (env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live' : 'test',
          webhook: !!env.STRIPE_WEBHOOK_SECRET, inkthreadable: !!env.INKTHREADABLE_SECRET, appId: !!env.INKTHREADABLE_APP_ID,
          brand: env.INKTHREADABLE_BRAND || null,
          catalogSource: env.SHOP_CATALOG_URL ? 'url' : 'variable',
          catalogAgeSec: CAT_AT ? Math.round((Date.now() - CAT_AT) / 1000) : null,
          sampleSticker: sample,
          /* Proof the LIVE catalogue carries what v213 needs, so a stale
             SHOP_CATALOG fallback cannot pass for the real thing. */
          withOptImg: cat ? Object.values(cat).filter(d => d && d.optImg).length : 0,
          withSizeShot: cat ? Object.values(cat).filter(d => (d && d.img || []).some(u => /-sizes-shop\.webp$/.test(u))).length : 0, alertPush: !!env.NTFY_TOPIC, alertEmail: !!env.RESEND_API_KEY, version: 'v217', onSale: cat ? Object.keys(cat).length : 'SHOP_CATALOG is not valid JSON'
        }, 200, { ...cors, 'Access-Control-Allow-Origin': '*' });
      }

      if (req.method === 'GET' && path === '/catalog') {
        const cat = await catalog(env), out = {};
        for (const [n, d] of Object.entries(cat)) out[n] = { price: d.price, sizes: Object.keys(d.variants || {}),
          /* which sides this product is actually printed on. The shop used to
             assume every tee had a front and a back and offered a flip to a
             blank shirt for the front-only ones. */
          sides: Object.keys(d.files || (d.optFiles && d.optFiles[Object.keys(d.optFiles)[0]]) || {}),
          post: d.post || '',
          /* A product may choose along two axes - a summit plate is a size AND
             a colour. The second axis is optional; everything else has one. */
          opt2: d.opt2 || '', opts2: d.opts2 || [],
          /* One shop picture per value of the second axis, so choosing Rust
             shows a rust plate instead of leaving the pine one up. Only the
             pictures travel here - the file that actually goes to print is
             still chosen by optFiles, worker-side. */
          optImg: d.optImg || null,
          kind: d.kind || 'tee', name: d.name || '', img: d.img || [], blurb: d.blurb || '', opt: d.opt || (d.kind && d.kind !== 'tee' ? 'Option' : 'Size'),
          details: d.details || [],
          // A donation has no size and no fixed price: the buyer names the amount.
          // `min` is published so the app can stop them before the request, and
          // enforced again below so a hand-made request cannot get under it.
          custom: !!d.custom, min: d.custom ? (+d.min || 100) : 0 };
        return json({ currency: 'gbp', shipping: +env.SHIPPING_PENCE || 0,
          letterShipping: +env.LETTER_SHIPPING_PENCE || 150,
          freeOver: +env.FREE_OVER_PENCE || 0, items: out }, 200,
          { ...cors, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=120' });
      }

      /* Did the order actually reach the printer, and what is it doing? The
         Printful build had a variant-id lookup here, which Inkthreadable does
         not need — its SKUs are readable (GD05-NAT-L). This is more use. */
      if (req.method === 'GET' && path === '/orders/recent') {
        if (env.SHOP_ADMIN_KEY && url.searchParams.get('key') !== env.SHOP_ADMIN_KEY)
          return json({ message: 'no' }, 403, cors);
        const r = await ink(env, 'GET', '/api/orders.php?limit=10', null, true);
        const list = (Array.isArray(r.body) ? r.body : (r.body && r.body.orders) || []).map(o => ({
          id: o.id, external_id: o.external_id, status: o.status, created: o.created_at,
          items: (o.items || []).map(i => i.quantity + ' x ' + i.pn).join(', ') }));
        return json({ ok: r.ok, count: list.length, orders: list }, r.ok ? 200 : 502, cors);
      }

      /* What did Inkthreadable actually STORE for an order? Their dashboard
         draws its preview from the optional `mockups` we do not send, so an
         empty preview proves nothing either way. This asks them directly and
         reports the designs attached to each line. Read-only, key-guarded. */
      if (req.method === 'GET' && path === '/order') {
        if (env.SHOP_ADMIN_KEY && url.searchParams.get('key') !== env.SHOP_ADMIN_KEY)
          return json({ message: 'no' }, 403, cors);
        const id = url.searchParams.get('id') || '';
        if (!id) return json({ message: 'pass ?id=<inkthreadable order id>' }, 400, cors);
        const r = await ink(env, 'GET', '/api/order.php?id=' + encodeURIComponent(id), null, true);
        const o = (r.body && (r.body.order || r.body)) || {};
        return json({ ok: r.ok, id: o.id, external_id: o.external_id, status: o.status,
          brand: o.brand,
          shipTo: o.shipping_address ? ((o.shipping_address.firstName || '') + ' ' + (o.shipping_address.lastName || '') + ', ' + (o.shipping_address.city || '')) : null,
          items: (o.items || []).map(i => ({ pn: i.pn, qty: i.quantity, title: i.title,
            description: i.description,
            designs: (i.designs || []).map(d => ({ title: d.title, src: d.src })),
            mockups: (i.mockups || []).length })),
          raw: url.searchParams.get('raw') ? r.body : undefined }, r.ok ? 200 : 502, cors);
      }

      if (!okOrigin) return json({ message: 'Not allowed from ' + (origin || 'no origin') }, 403, cors);

      if (req.method === 'GET' && path === '/code') {
        const raw = url.searchParams.get('c');
        const c = await promo(env, raw);
        if (!c) return json({ ok: false, message: 'That code isn\u2019t valid.' }, 200, cors);
        return json({ ok: true, code: c.code, percent: c.percent || 0, amount: c.amount || 0, min: c.min || 0,
          label: c.label, teeOnly: teeOnlyCode(c.code) }, 200, cors);
      }

      if (req.method === 'POST' && path === '/checkout') {
        const body = await req.json();
        const cat = await catalog(env);
        // a basket, or one tee from an older page
        const want = Array.isArray(body.items) ? body.items : [{ k: body.n, opt: body.size, qty: 1 }];
        const lines = [];
        for (const w of want.slice(0, 12)) {
          const k = String(w.k), d = cat[k];
          if (!d) return json({ message: 'Something in your backpack is no longer on sale.' }, 404, cors);
          const qty = Math.max(1, Math.min(10, Math.floor(+w.qty || 1)));
          if (d.custom) {
            /* The amount travels in `opt`, which is the one per-line field that
               already survives the round trip through Stripe's cart metadata.
               Never trust it: the app is not the only thing that can POST here. */
            const min = +d.min || 100, max = +d.max || 100000;
            const amt = Math.floor(+w.opt || 0);
            if (!(amt >= min && amt <= max))
              return json({ message: 'Choose an amount between \u00a3' + (min / 100).toFixed(2) +
                ' and \u00a3' + (max / 100).toFixed(2) + '.' }, 400, cors);
            lines.push({ k, opt: String(amt), qty, d, variant: null, price: amt });
            continue;
          }
          /* "Large|Pine" is one choice along two axes. The SKU hangs off the
             first; the second only decides which artwork is printed. Both are
             checked against the catalogue so a hand-made request cannot invent
             a colour that does not exist. */
          const parts = String(w.opt == null ? '' : w.opt).split('|');
          const a1 = parts[0], a2 = parts[1] || '';
          const variant = d.variants && d.variants[a1];
          if (!variant) return json({ message: 'Choose a ' + (d.opt || 'size').toLowerCase() + ' for ' + (d.name || 'that item') + '.' }, 400, cors);
          if (d.opts2 && d.opts2.length && d.opts2.indexOf(a2) < 0)
            return json({ message: 'Choose a ' + (d.opt2 || 'colour').toLowerCase() + ' for ' + (d.name || 'that item') + '.' }, 400, cors);
          const same = lines.find(l => l.k === k && l.opt === w.opt);
          if (same) same.qty = Math.min(10, same.qty + qty); else lines.push({ k, opt: String(w.opt), qty, d, variant, price: d.price });
        }
        if (!lines.length) return json({ message: 'Your backpack is empty.' }, 400, cors);
        // free delivery is judged on the goods, before any code — the same rule the app shows
        const goods = lines.reduce((a, l) => a + l.price * l.qty, 0);
        const freeOver = +env.FREE_OVER_PENCE || 0;
        /* An order of nothing but donations has nothing to post, so it is not
           charged postage — and the free-delivery threshold is judged on the
           goods alone, so a donation cannot buy someone free delivery either. */
        const ship = lines.filter(l => !l.d.custom).reduce((a, l) => a + l.price * l.qty, 0);
        /* Everything in the basket light enough to go in an envelope? Then it
           is posted as a letter, not a parcel. Judged on the catalogue's own
           `post` band, so adding a product decides its own postage. */
        const light = lines.filter(l => !l.d.custom).every(l => (l.d.post || '') === 'letter');
        const rate = light ? (+env.LETTER_SHIPPING_PENCE || 150) : (+env.SHIPPING_PENCE || 0);
        const post = !ship || (freeOver && ship >= freeOver) ? 0 : rate;
        const f = new URLSearchParams({
          'ui_mode': 'embedded_page',   // Stripe renamed 'embedded' in API 2026-03-25 (dahlia)
          'mode': 'payment',
          'redirect_on_completion': 'never',
          'phone_number_collection[enabled]': 'true',
          // the basket, compact: key~option~qty per line (Stripe metadata holds 500 characters)
          'metadata[cart]': lines.map(l => [l.k, l.opt, l.qty].map(x => String(x).replace(/[~,]/g, '')).join('~')).join(',').slice(0, 500)
        });
        /* Only ask for an address when something is being posted. A donation on
           its own has nowhere to go, and Checkout would otherwise demand a
           delivery address for a payment that will never be shipped. */
        if (ship) {
          f.set('shipping_address_collection[allowed_countries][0]', 'GB');
          f.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
          f.set('shipping_options[0][shipping_rate_data][display_name]', post ? 'UK delivery' : 'Free UK delivery');
          f.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(post));
          f.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'gbp');
          f.set('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]', 'business_day');
          f.set('shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]', '4');
          f.set('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]', 'business_day');
          f.set('shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]', '10');
        }
        lines.forEach((l, i) => {
          f.set('line_items[' + i + '][quantity]', String(l.qty));
          f.set('line_items[' + i + '][price_data][currency]', 'gbp');
          f.set('line_items[' + i + '][price_data][unit_amount]', String(l.price));
          const nm = l.d.name || ('WayMark ' + (l.d.kind || 'tee'));
          // a donation's `opt` is its amount, which is already the price — tacking
          // it onto the name would read "Donation — 500"
          f.set('line_items[' + i + '][price_data][product_data][name]',
            nm + (!l.d.custom && l.opt && l.opt !== 'One size' ? ' \u2014 ' + l.opt : ''));
        });
        /* The donor asked not to be credited. Recorded on the payment so any
           supporters list can honour it; the failure alert still names them,
           because a payment that did not reach the printer has to be traceable. */
        if (body.anon && lines.some(l => l.d.custom)) f.set('metadata[anon]', '1');
        // a code typed in the basket is applied here; otherwise Stripe's own box is offered
        const code = body.code ? await promo(env, body.code) : null;
        if (body.code && !code) return json({ message: 'That discount code isn\u2019t valid any more.' }, 400, cors);
        if (code) {
          const blocked = teeOnlyBlocks(code.code, lines);
          if (blocked) return json({ message: blocked }, 400, cors);
        }
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

/* ---- a paid order becomes an Inkthreadable order ---- */
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
    await alertJoe(env, 'Paid order did NOT reach Inkthreadable',
      who + ' paid £' + ((s.amount_total || 0) / 100).toFixed(2) + ' for ' + ((s.metadata && (s.metadata.cart || (s.metadata.n + ' ' + s.metadata.size))) || 'an order') + '.\n' +
      'Reason: ' + why.slice(0, 400) + '\n\n' +
      'Stripe keeps retrying for 3 days. Fix the cause, or place the order in Inkthreadable by hand, then check Stripe → Developers → Webhooks.\n' +
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

  const cat = await catalog(env);
  const cart = s.metadata.cart
    ? s.metadata.cart.split(',').map(x => { const [k, opt, q] = x.split('~'); return { k, opt, qty: +q || 1 }; })
    : [{ k: String(s.metadata.n), opt: s.metadata.size, qty: 1 }];
  const items = [];
  /* The customer-facing order number. Printful printed this on its packing
     slip from a field on the order; Inkthreadable's Brand Profile is static
     and holds no per-order fields, so it travels on each line instead and
     shows against the item. Same six characters the Stripe receipt ends in,
     so a customer quoting either can be found. */
  const ref = 'WM-' + s.id.slice(-6).toUpperCase();
  for (const l of cart) {
    const d = cat[l.k];
    if (!d) return new Response('unknown product ' + l.k, { status: 500 });   // Stripe retries; fix the catalog
    /* A donation is money, not an object. It has no variant and nothing to
       print, so it never reaches the printer — without this the webhook would
       fail on `unknown option` looking for a variant that does not exist, and
       Stripe would retry a paid order forever. */
    if (d.custom) continue;
    /* "Large|Pine" is one choice along two axes; the SKU hangs off the first.
       Checkout already splits it - the webhook has to as well, or a plate
       would be sold and then never printed. */
    const a1 = String(l.opt == null ? '' : l.opt).split('|')[0];
    const variant = d.variants && d.variants[a1];
    if (!variant) return new Response('unknown option ' + l.opt + ' for ' + l.k, { status: 500 });
    /* Inkthreadable takes the SKU itself as `pn` (e.g. GD05-NAT-L) rather than
       a numeric variant id. The artwork is an ARRAY of {title, src} - see
       designsFor - not the map the catalogue stores it as. */
    items.push({ pn: String(variant), quantity: String(l.qty),
      designs: designsFor(env, d, l.opt),
      title: (d.name || 'WayMark') + (l.opt && l.opt !== 'One size' ? ' — ' + String(l.opt).split('|').join(' · ') : ''),
      description: 'Order ' + ref,
      // what the customer paid for one: printed on the invoice that goes in the parcel
      retailPrice: (d.price / 100).toFixed(2) });
  }
  const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || {};
  const a = ship.address || (s.customer_details && s.customer_details.address) || {};
  /* Nothing but donations: the money is banked and there is nothing to make.
     Return 200 so Stripe marks the webhook handled rather than retrying. */
  if (!items.length) return new Response('donation only, nothing to print', { status: 200 });
  /* Stripe gives one `name`; Inkthreadable wants it split. Everything before
     the last space is the first name, so "Mary Jane Watson" keeps "Mary Jane"
     together. A single word becomes the first name and the surname is left
     empty rather than guessed. */
  const discountPence = (s.total_details && s.total_details.amount_discount) || 0;
  const whole = (ship.name || (s.customer_details && s.customer_details.name) || '').trim();
  const cut = whole.lastIndexOf(' ');
  const firstName = cut > 0 ? whole.slice(0, cut) : whole;
  const lastName = cut > 0 ? whole.slice(cut + 1) : '';
  const order = {
    // The Stripe session id is the order's external id, so a webhook that
    // arrives twice cannot print the shirt twice — the repeat is refused.
    external_id: s.id.slice(-32),
    ...(env.INKTHREADABLE_BRAND ? { brand: env.INKTHREADABLE_BRAND } : {}),
    /* Inkthreadable keeps these apart and it matters: `shipping_address` is
       where the parcel goes, `shipping` is the carrier and tracking. Posting
       the address as `shipping` meant no shipping_address arrived at all, and
       firstName is required - hence "Name is not defined". */
    buyer_email: (s.customer_details && s.customer_details.email) || '',
    shipping_address: {
      firstName, lastName,
      address1: a.line1 || '', address2: a.line2 || '',
      city: a.city || '', county: a.state || '',
      postcode: a.postal_code || '', country: a.country || 'GB',
      phone1: (s.customer_details && s.customer_details.phone) || ''
    },
    items,
    /* The packing slip does NOT travel in the order any more. Printful took the
       store name, logo, order number and Joe's note as fields on every order;
       Inkthreadable holds all of that once, on the Brand Profile in the
       account, and just needs `brand` naming above. The note that used to ride
       along is kept here so it is not lost when the profile gets set up:

         "Thanks for walking with WayMark. Wherever this tee ends up, snap it
          and tag us on Instagram @waymark.it. We'd love to see where it goes.
          Log every hill you climb at waymark.it.com. Wash inside out on a cool
          wash. Questions: contact@waymark.it.com. Joe"

       The customer-facing order number DOES travel: WM- plus the last six of
       the Stripe session id, on each item's `description` (set above). The
       Brand Profile is static and could not carry a per-order value.

       `summary` (subtotal, shipping, total, tax) is readonly at Inkthreadable
       — they work it out — so nothing to send. */
  };
  /* Printful had ?confirm=true to send an order straight to print, and the
     live worker already ran with it on, so there was never an approval step
     to lose. Inkthreadable has no equivalent flag — an order posted here is
     an order placed. */
  const r = await ink(env, 'POST', '/api/orders.php', order, true);
  if (r.ok) {
    await alertJoe(env, 'New order · £' + ((s.amount_total || 0) / 100).toFixed(2),
      items.map(i => i.quantity + ' × ' + i.title).join('\n') + '\n' + (order.shipping_address.city || 'UK') +
      (discountPence ? ' · £' + (discountPence / 100).toFixed(2) + ' off' : ''), false);
    return new Response('ok', { status: 200 });
  }
  // already made for this payment: fine
  if (JSON.stringify(r).toLowerCase().includes('external')) return new Response('duplicate', { status: 200 });
  // anything else: 500 so Stripe keeps retrying (for 3 days) and it shows red in the Stripe dashboard
  return new Response('inkthreadable: ' + JSON.stringify(r).slice(0, 500), { status: 500 });
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

/* The catalogue outgrew where it used to live: a Cloudflare environment
   variable is capped at 5 KB and the range is well past that. It is now a file
   on the site, so it ships in the same upload as the artwork it points at and
   is versioned with it. Held in memory between requests, and a stale copy is
   always preferred to an empty one - an empty catalogue would refuse every
   order in the basket. SHOP_CATALOG stays as the last resort. */
let CAT = null, CAT_AT = 0;
function catalogForget() { CAT = null; CAT_AT = 0; }
async function catalog(env) {
  const url = env.SHOP_CATALOG_URL || '';
  const ttl = (+env.SHOP_CATALOG_TTL || 300) * 1000;
  if (url) {
    if (CAT && Date.now() - CAT_AT < ttl) return CAT;
    try {
      const r = await fetch(url, { cf: { cacheTtl: 0 } });
      if (r.ok) {
        const j = await r.json();
        if (j && typeof j === 'object' && Object.keys(j).length) {
          CAT = j; CAT_AT = Date.now(); return j;
        }
      }
    } catch (e) { /* fall through to whatever we already have */ }
    if (CAT) return CAT;
  }
  try { return JSON.parse(env.SHOP_CATALOG || '{}'); } catch (e) { return {}; }
}

/* Inkthreadable names each print position as the decoration name and the side
   run together - "Printing Front", "Printing Back" - and their API takes those
   as an array of {title, src}, NOT a map keyed by side. Their own spec shows
   "DTG Printing Front Side" and "Embroidery Left chest"; the Gildan product
   carries decoration "Printing" with sides Front, Back, Centre Chest and Left
   Chest, so this product wants "Printing Front" and "Printing Back".
   The names are data, not code: a product can carry its own `pos` map, or
   INKTHREADABLE_POS can set a default for everything, so a wrong guess is one
   variable away from fixed rather than a redeploy. */
function designsFor(env, d, opt) {
  /* The product's own names come first, then INKTHREADABLE_POS on top. The
     variable wins deliberately: when a position name turns out to be wrong,
     the fix is a Cloudflare field rather than a file upload and a cache wait. */
  let env_map = {};
  try { env_map = JSON.parse(env.INKTHREADABLE_POS || '{}'); } catch (e) { env_map = {}; }
  const map = Object.assign({}, d.pos || {}, env_map);
  const deco = env.INKTHREADABLE_DECORATION || 'Printing';
  /* Setting a side to "" in `pos` omits the title entirely. That was tried for
     stickers and Inkthreadable REJECTED the order - every design needs a
     position name. A sticker's position is named after its size, not a side:
     "Printing 7.5cm x 7.5cm". Leave this path in, but assume a title is
     required until a product proves otherwise. */
  const title = side => side in map ? map[side]
    : deco + ' ' + side.charAt(0).toUpperCase() + side.slice(1);
  /* A product may carry one artwork set per option. Stickers use it: Large and
     Small are the same SKU at the same price, cut from different files. Falls
     back to `files` when a product has no per-option artwork, which is every
     tee. */
  const files = (d.optFiles && d.optFiles[opt]) || d.files || {};
  return Object.entries(files).map(([side, src]) => {
    const t = title(side);
    return t ? { title: t, src } : { src };
  });
}
// A promotion code made in Stripe (Product catalogue → Coupons → add a code).
// Codes are matched without caring about case; expired, used-up or switched-off
// codes come back as null.
/* A code whose name starts TEE only discounts tees.

   Stripe cannot enforce this for us: each basket line is sent as a one-off
   price invented at checkout, not picked from Stripe's product catalogue, and
   a coupon can only be restricted to catalogue products. So the rule lives
   here. Without it a 25% tee code also takes 25% off a sticker, and a sticker
   at 2.25 costs 2.40 - every one sold at a loss.

   The prefix is the whole rule, deliberately: it is visible in the code the
   customer types, so nobody has to remember a setting somewhere else. */
const teeOnlyCode = c => /^TEE/i.test(String(c || '').trim());
function teeOnlyBlocks(codeText, lines){
  if (!teeOnlyCode(codeText)) return '';
  const others = lines.filter(l => (l.d.kind || 'tee') !== 'tee');
  if (!others.length) return '';
  const what = others.length === 1 ? others[0].d.name : others.length + ' other things';
  return 'That code is for tees only. Take ' + what + ' out of your backpack, or order separately.';
}
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
/* Inkthreadable does not use a bearer token. Every request carries the AppId
   as a query parameter and a Signature, which is SHA1(request body + secret)
   as lower-case hex. Confirmed against the live endpoint: the parameter is
   spelled `AppId` exactly — `appid` and `AppID` are both read as empty.
   Workers have SHA-1 in crypto.subtle, so there is nothing to install. */
async function sha1hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function ink(env, method, p, body, raw) {
  const payload = body ? JSON.stringify(body) : '';
  const [route, qs = ''] = p.split('?');
  const params = 'AppId=' + encodeURIComponent(env.INKTHREADABLE_APP_ID || '') + (qs ? '&' + qs : '');
  /* POST signs the body. GET has no body, so it signs everything after the ?
     except the Signature itself — which means the query has to be assembled
     first and signed exactly as it will be sent. */
  const signed = method === 'GET' ? params : payload;
  const sig = await sha1hex(signed + (env.INKTHREADABLE_SECRET || ''));
  const url = INK + route + '?' + params + '&Signature=' + sig;
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' },
    body: payload || undefined });
  const j = await r.json().catch(() => ({ error: 'non-JSON reply', status: r.status }));
  if (raw) return { ok: r.ok, status: r.status, body: j };
  if (!r.ok) throw new Error(j.error || 'Inkthreadable error');
  return j;
}
function json(o, status, h) { return new Response(JSON.stringify(o), { status, headers: { ...h, 'Content-Type': 'application/json' } }); }
