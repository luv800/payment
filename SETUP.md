# Hungerr Station – automatic UPI confirmation (setup)

## 1. Replace files in your project
- `index.html` → your `public/index.html`
- `functions/api/[[route]].js` → same path in your project
- `wrangler.toml` → project root (removes the unused YOUPI vars)
- `schema.sql` is only for fresh installs. Your existing DB uses the migration below.

## 2. Update the database (once)
    npx wrangler d1 execute hungerr-db --remote --file=migrations/002_secure_payments.sql
This relabels old "verified" orders as `PAID_UNVERIFIED` (they were never really checked) and old
pending ones as `EXPIRED`. Review `PAID_UNVERIFIED` rows before trusting them.

## 3. Set the shared secret (never put it in wrangler.toml)
    openssl rand -hex 24          # copy the output
    npx wrangler pages secret put NOTIFY_SECRET --project-name hungerr-station
Then deploy (`npx wrangler pages deploy public`).

## 4. Configure the restaurant phone
Install any SMS / notification forwarder that can send a custom HTTP POST, on the spare Android
phone that has the BharatPe app. Set it to forward the "payment received" alert (BharatPe app
notification or the SMS, whichever shows the amount) as:

    POST https://creditpay.pages.dev/api/payments/notify
    Header:  Authorization: Bearer <your NOTIFY_SECRET>
             Content-Type: application/json
    Body:    {"sender":"<sender/app name>","text":"<full alert text>","ts":"<time>"}

Use your app's placeholders for sender / text / time. Turn off battery optimisation for both
apps, keep the phone charging and on Wi-Fi/data, and don't let it sleep the apps.

## 5. Test with ₹1 (before real customers)
1. Add a dish, apply coupon LOVE99 (total becomes ₹1), choose UPI, enter name + phone.
2. Pay the exact amount shown (e.g. ₹1.00) from another phone.
3. The page should flip to "Order Confirmed" within seconds.
4. If not, look at what the phone sent:
       npx wrangler d1 execute hungerr-db --remote --command "SELECT outcome, amount_paise, body FROM bank_alerts ORDER BY id DESC LIMIT 10"
   - `UNPARSED`: the alert text has no ₹/Rs/INR amount → tell me the exact format and I'll adjust the parser.
   - `IGNORED_SOURCE`: ALERT_MATCH_PATTERN doesn't match sender/text.
   - `UNMATCHED`: amount didn't equal a pending order (paid after 15 min + 30 min grace, or wrong amount).

## 6. Afterwards
- Set `ALERT_MATCH_PATTERN` in wrangler.toml (e.g. `bharatpe`) once you've seen a real alert.
- Keep `MENU` in `[[route]].js` identical to `DISHES` in `index.html` (prices must match).
- LOVE99 (99% off) is shown as the placeholder in the promo box. Remove or change it before launch.
