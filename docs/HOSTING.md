# Hosting NoemaBoard for your team (free)

NoemaBoard is hosted on **Cloudflare's free Workers plan**. One deployment provides:

- **The web app**, so teammates can join from any browser without installing anything:
  `https://app.<your-subdomain>.workers.dev/app/` (the front page is at the bare address)
- **An always-on sync server** at `…/relay`, so shared boards stay available even when nobody
  else is online.
  - Board contents are end-to-end encrypted with the key in each invite link, so Cloudflare
    stores only data it cannot read.

## Your money is never touched

- **No card needed.** The deployment uses only features included in the **Workers Free** plan:
  Workers, static assets, and SQLite-backed Durable Objects. None of them needs a payment method.
- **Hard limits, not overage charges.** If the team ever reached the free plan's daily limits,
  Cloudflare would temporarily *refuse* further sync-server requests until the next day (UTC). It
  never bills. During that time the app keeps working peer-to-peer and saves everything locally.
  - The free daily limits are roughly 100,000 requests and 100,000 storage writes. They
    comfortably cover a team of about 10–40 people editing during the day.
- **Optional logging is switched off** (`observability: false`).
- **To keep it free forever:**
  - Don't upgrade the account to *Workers Paid*.
  - Don't enable paid products (R2, Logpush, etc.) for this Worker.
  - Nothing in this project ever asks you to.

## Update the hosted app

From the project folder:

```bash
npm run deploy:cloudflare
```

This builds the web app and uploads it together with the sync server. The first time on a new
computer, run `npx wrangler login` in `relay/cloudflare` and approve the sign-in in your browser.

## Keep strangers off your sync server (optional)

The sync server can't read your boards, but anyone who knows its address could use some of your
free quota. To require a key, run this in `relay/cloudflare`:

```bash
npx wrangler secret put ACCESS_KEY -c wrangler.app.jsonc
```

Then rebuild the apps with the key added to the relay address
(`…/relay?key=YOUR_KEY` in `VITE_DEFAULT_RELAY`).

## Use your own domain (optional, costs money)

A domain is the only part of this setup that costs money: about $10–15 a year, for example from
Cloudflare (*Domain Registration → Register Domains*), which sells at cost. NoemaBoard's own copy
uses `noemaboard.app`:

1. In `relay/cloudflare/wrangler.app.jsonc`, list the domain under `routes` and keep the
   workers.dev address on. Without `"workers_dev": true`, listing routes switches it off:
   ```jsonc
   "routes": [{ "pattern": "example.com", "custom_domain": true }],
   "workers_dev": true,
   ```
2. Run `npm run deploy:cloudflare`. Cloudflare creates the DNS record and the certificate.
3. Optional: `www.example.com` → `example.com` with the small redirect Worker in
   `relay/cloudflare/wrangler.www.jsonc` (change the address in it and in `src/www.ts`).
4. Point the desktop apps at the new address (see below) and publish a new release.

Browsers keep boards separately for each address, so people who used the old address keep their
boards there until they move them with a backup (*Export a full backup*, then *Import a backup*).
NoemaBoard's own copy also sends new visitors from its old address to the new one
(`public/moved.js`; it does nothing at any other address).

## Desktop app

Local desktop builds read `.env.production.local`, which is not committed:

```
VITE_PUBLIC_URL=https://app.<your-subdomain>.workers.dev/app/
VITE_DEFAULT_RELAY=https://app.<your-subdomain>.workers.dev/relay
```

(With your own domain: `https://example.com/app/` and `https://example.com/relay`.)

For installers built by GitHub Actions, set the same two values as repository variables:
*Settings → Secrets and variables → Actions → Variables*, named `PUBLIC_URL` and `DEFAULT_RELAY`.

## Remove the hosting

In `relay/cloudflare`, run:

```bash
npx wrangler delete -c wrangler.app.jsonc
```

Boards stay on everyone's devices and keep syncing peer-to-peer.
