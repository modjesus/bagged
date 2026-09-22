# Camp Supplies shop — setup

How it works: a tee's page on waymark.it.com shows the price and sizes. Tapping
**Buy** opens Stripe's checkout inside WayMark (card, Apple Pay, Google Pay).
When the payment lands, Stripe tells the **shop helper** (a Cloudflare Worker,
like the Strava one), and the helper sends the order to **Printful**, who print
it and post it. You never touch an order unless you want to.

Nothing is on sale until you add it to the helper's catalogue (step 5), so all
of this can be set up quietly first.

---

## 1. Stripe (payments)

1. Sign up at stripe.com as a UK business (sole trader is fine).
2. Stay in **Test mode** (toggle top right) for everything below until step 7.
3. Developers → API keys: copy the **Publishable key** (`pk_test_…`) and the
   **Secret key** (`sk_test_…`).
4. Settings → Payment methods: make sure Cards, Apple Pay and Google Pay are on.
5. Settings → Payment methods → **Payment method domains** → add `waymark.it.com`.
   If Apple Pay asks for a verification file, send it to me and I'll add it to
   the repo (plus an empty `.nojekyll`).

## 2. Printful (printing and posting)

1. Sign up at printful.com. Add a card under Billing: Printful charges you the
   wholesale cost when each order goes to print.
2. Stores → **Add store** → **Manual order platform / API**. Name it WayMark.
   Note its **store ID** (in the URL or store settings).
3. Go to developers.printful.com → **Your tokens** → create a private token for
   that store with scopes: orders, file library, webhooks. Copy it (you only
   see it once).
4. Pick the garment. For UK printing, choose a tee Printful makes in its UK
   or EU facility and in colours closest to cream, sand and pine. Note its
   catalogue **product ID**; once the helper is running, open
   `https://<your-shop-helper>/printful/variants?product=<ID>` to see every
   size/colour with its **variant ID**.

## 3. Print files

Printful needs a PNG per printed side, transparent background, at print size
(about 30 × 40 cm, 150–300 dpi). I'll export these from the tee SVGs for the
designs you choose and put them in the repo under `print/` so they live at
`https://waymark.it.com/print/13-back.png` etc. Tell me which designs.

## 4. The shop helper (Cloudflare Worker)

1. Cloudflare → Workers & Pages → Create → **Hello World** worker, name it
   `waymark-shop`. Deploy, then Edit code, paste in all of `shop-worker.js`,
   Deploy.
2. Settings → Variables and Secrets:

   | Name | Type | Value |
   |---|---|---|
   | STRIPE_SECRET_KEY | Secret | `sk_test_…` |
   | STRIPE_WEBHOOK_SECRET | Secret | from step 4.3 |
   | PRINTFUL_TOKEN | Secret | Printful private token |
   | PRINTFUL_STORE_ID | Text | store ID |
   | PRINTFUL_CONFIRM | Text | `false` (orders land as drafts for you to approve) |
   | SHIPPING_PENCE | Text | e.g. `399` for £3.99 |
   | ALLOWED_ORIGIN | Text | `https://waymark.it.com` |
   | SHOP_CATALOG | Text | see step 5 |

3. Stripe → Developers → **Webhooks** → Add endpoint:
   `https://waymark-shop.<you>.workers.dev/stripe-webhook`, events
   `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
   Copy its **Signing secret** (`whsec_…`) into STRIPE_WEBHOOK_SECRET.
4. Open `https://waymark-shop.<you>.workers.dev/health` — every value should be
   `true`, and `onSale` shows how many tees are listed.

## 5. What is on sale (SHOP_CATALOG)

One line of JSON. Key = the design number from Camp Supplies; price in pence;
one Printful variant ID per size (for that design's shirt colour); the print
files by side.

```json
{"13":{"name":"Mark Your Journeys","price":2800,
  "variants":{"S":11546,"M":11547,"L":11548,"XL":11549},
  "files":{"back":"https://waymark.it.com/print/13-back.png",
           "front":"https://waymark.it.com/print/13-front.png"}}}
```

Add a design → it shows a price and a Buy button on the site within two
minutes. Remove it → back to "Not for sale yet". No new release needed.

## 6. Add two lines to firebase-config.js

```js
window.SHOP_WORKER = "https://waymark-shop.<you>.workers.dev";
window.STRIPE_PUBLISHABLE_KEY = "pk_test_…";
```

## 7. Test, then go live

1. Buy a tee with Stripe's test card `4242 4242 4242 4242`, any future date,
   any CVC. A **draft** order should appear in Printful. Delete it.
2. Before switching to live, the legal pages must exist (on the backlog):
   your name and a geographic address, returns wording, and a privacy page
   naming Stripe and Printful.
3. Live: swap both Stripe keys to `sk_live_…` / `pk_live_…`, make a live
   webhook (new `whsec_…`), and when you trust it, set PRINTFUL_CONFIRM to
   `true` so paid orders go straight to print.

## Safety built in

- Prices come only from the helper's catalogue; the page can't change them.
- Stripe's webhook is signature-checked; nobody can fake a paid order.
- Each Printful order carries the Stripe session ID as its external ID, so a
  repeated webhook can't print the same order twice.
- If Printful rejects an order, the helper answers Stripe with an error, so
  Stripe retries for up to three days and shows the failure in red on the
  Webhooks page. (Email alerts for that are on the backlog.)


---

## 8. Selling more than tees (v191)

Every entry in SHOP_CATALOG is a product. Tees keep their design number as
the key. Anything else gets its own key and a `kind`, and shows up in the shop
under **Kit for the hill** as soon as it has a picture:

```json
"sticker-trig":{"name":"The Trig sticker","kind":"sticker","price":400,
  "opt":"Size","variants":{"3″":<variant id>,"4″":<variant id>},
  "files":{"default":"https://waymark.it.com/print/sticker-trig.png"},
  "img":["https://waymark.it.com/shop/sticker-trig.jpg"],
  "blurb":"Waterproof kiss-cut vinyl",
  "details":["Die-cut to the design","Waterproof and UV-resistant"]}
```

- `kind`: sticker, patch, cap, beanie, bottle, gaiter (or anything; it is shown as written).
- `opt`: what the choice is called (Size, Colour, Pack). One variant called
  `"One size"` means there is no choice to make.
- `files`: the Printful placement names for that product (Printful's product
  page lists them — e.g. `embroidery_front` for caps, `default` for stickers).
- `img`: one or more pictures for the shop (square works best).

Find variant ids the same way as for tees:
`/printful/variants?product=<Printful product id>`.

## 9. The basket and discount codes

- People add as many things as they like; one checkout, one delivery charge.
- **Discount codes** are made in Stripe: Product catalogue → **Coupons** →
  New (e.g. 10% off, or £5 off, optional expiry and minimum spend) → add a
  **promotion code** (the word people type, e.g. `SUMMIT10`). It works straight
  away: the basket checks it and shows the saving, and Stripe applies it at
  checkout. Switch the code off in Stripe to end it.
- Printful's order shows the discount, so the packing slip matches what was paid.

## 10. v192: Basecamp, free delivery and "tell me when it's printed"

**Free delivery over a threshold.** In Cloudflare, go to the shop helper → Settings → Variables and add:

- `FREE_OVER_PENCE` = `5000` (plain text). Orders whose goods total £50 or more ship free. The app reads this from `/catalog`, so the progress bar in the backpack and the checkout always agree. Leave it out to charge `SHIPPING_PENCE` on every order.

Then deploy the new `shop-worker.js`.

**Apple Pay and Google Pay.** Stripe's checkout shows these by itself once they're switched on (§1, step 4) and `waymark.it.com` is added under Payment method domains. There's nothing to add in the app.

**Who asked to be told.** When someone votes yes on the drawing board and taps "Tell me when it's printed", their choice is saved in Firestore under `supplyVotes/<uid>`:

- `tell` is a map of design number → `app`, `email` or `both`.
- `tellEmail` holds their address, if they're signed in and chose email.
- `patchTell: true` means they want to hear when real embroidered patches exist.

"In the app" needs nothing from you. The day a design goes on sale, anyone who asked sees a "It's printed" note at the top of the shop row on Home. Emails you send yourself for now. Firestore console → `supplyVotes` → filter on `tell.<number>`.
