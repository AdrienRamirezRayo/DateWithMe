# ⚡ LeadRush

Pay-per-call marketplace for insurance agents, modeled on BESO Connect. Suppliers (your ad guy, lead vendors) run call campaigns on tracking numbers. Agents fund a wallet, pick the campaigns they want, set their states, hours, and daily caps, and go live. Each inbound call rings the next eligible agent. If the call lasts past the campaign's billable time, the agent's wallet is charged. No subscriptions, no minimums.

Verticals: Final Expense, Medicare, ACA / Health, Term Life, Mortgage Protection.

## What's in it

| Page | Who uses it | What it does |
|---|---|---|
| `/` | Agents you're recruiting | Marketing site: features, how it works, pricing |
| `/quote` | Consumers (ad traffic) | 4-step quote form with TCPA consent and UTM tracking |
| `/signup`, `/login` | Agents | Agent accounts (new agents wait for admin approval) |
| `/dashboard` | Agents and admins | Live leads, pipeline, stats, campaigns, settings |

**Pay-per-call**
- **Marketplace:** every campaign shows its vertical, supplier, price per call, billable time, and states. Agents switch campaigns on and off and set days, hours (in their own time zone), and a daily cap for each one.
- **Wallet:** prepaid balance with card top-ups through Stripe, or admin credits. A full ledger records every deposit, call charge, and refund.
- **Billing:** a call is charged only after it passes the campaign's billable time, for example 90 seconds. Billing never double-charges, even if Twilio sends the same update twice.
- **Calls:** a call log with recordings, duration, cost, and status. Agents can request a return within 72 hours, and admins approve (which refunds the wallet) or deny.
- **Smart routing:** a call only rings agents who are online, licensed in the caller's state, inside their hours, under their daily cap, not already on a call, and able to cover the price. Agents are rung one at a time in rotation.

**Agent dashboard**
- **Receiving leads** switch: only agents who are online get leads and calls
- Live feed with a sound, a pop-up, and a browser notification when a lead arrives
- Pipeline: New → Contacted → Appointment → Sold / Lost, with annual premium on sold policies
- One-tap call button, notes, and an activity timeline on every lead
- Stats: contact rate, appointments, close rate, premium, and **speed to lead**

**Admin**
- Approve or disable agents, set their licensed states, make other admins
- Leads round-robin to online agents licensed in the lead's state
- Unassigned pool and manual reassignment
- **Campaigns**: leads, appointments, sales, and premium for each ad source and campaign, plus a link builder for your ad guy
- CSV export
- Lead webhook for Facebook Lead Ads, Zapier, or lead vendors

**Inbound calls (Twilio)**
- Each campaign has its own Twilio tracking number
- The agent has to **press a key to accept**, so a personal voicemail can't "answer" the call (or get billed for it)
- Calls are recorded from the moment the agent accepts
- If no one answers, the caller leaves a voicemail. The voicemail is attached to the lead, which goes to the next agent in rotation for a callback.
- SMS alert to the agent for every new web lead

## Run it on your computer

You need [Node.js 22.13 or newer](https://nodejs.org).

```bash
git clone https://github.com/adrienramirezrayo/datewithme.git leadrush
cd leadrush
git checkout claude/upload-code-to-computer-f2ft4k
npm install
npm run seed     # optional: demo agents + 140 demo leads
npm start
```

Open http://localhost:3000.
- With demo data, log in as `admin@leadrush.test` / `password123`. For an agent's view, use `jasmine@leadrush.test`. `marcus@leadrush.test` has a low balance, so you can see the warnings.
- Without demo data, the **first account you create becomes the admin**.

## Put it online

Any Node host with a persistent disk will work. **Render** is the easiest:

1. Push this repo to GitHub (already done).
2. On [render.com](https://render.com), choose **New → Blueprint** and pick this repo. `render.yaml` sets up the server and a disk for the database.
3. In the service's **Environment** settings, fill in `PUBLIC_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
4. Point your domain at it.

The database is a single SQLite file at `DATABASE_PATH`. Back up that file to back up everything.

## Turn on live calls and SMS (Twilio)

1. Create a [Twilio](https://twilio.com) account and buy one phone number per campaign. Give each number to the supplier or ad guy running that campaign.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` (used for SMS) in your environment.
3. In Twilio, go to **Phone Numbers → each number → Voice → "A call comes in"** and set it to Webhook, `https://YOUR-DOMAIN/api/twilio/voice`, method **POST**.
4. In the dashboard, open **Marketplace → + New campaign**, enter the number, the price per call, and the billable seconds.
5. Agents add their mobile number in **Settings**, fund their wallet, switch on campaigns, and flip on **Receiving leads**.

## Turn on card payments (Stripe)

1. In [Stripe](https://dashboard.stripe.com), copy your secret key into `STRIPE_SECRET_KEY`.
2. Go to **Developers → Webhooks → Add endpoint** and enter `https://YOUR-DOMAIN/api/stripe/webhook` with the event `checkout.session.completed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Agents can now top up from **Wallet**. Until Stripe is set up, admins can add funds from **Agents → ± Funds**.

Optional settings: `MIN_DEPOSIT_CENTS` (default 2500, which is $25) and `DISPUTE_WINDOW_HOURS` (default 72).

Twilio requests are verified with your auth token, so `PUBLIC_URL` must exactly match the domain Twilio calls.

## Hooking up ads

- **Landing page ads:** in the dashboard, open **Campaigns**, build a link (for example `/quote?utm_source=facebook&utm_campaign=final-expense-oct`), and give it to your ad guy. Every lead is tagged with that campaign. The quote page also fires `fbq('track','Lead')` and `gtag('event','generate_lead')` if those pixels are on the page.
- **Facebook Lead Ads / vendors:** POST JSON to `/api/leads/webhook` with the header `x-api-key: <key from Settings>`.
- **Call ads:** use your Twilio number.

## Tech

Node 22 + Express 5 + built-in SQLite (`node:sqlite`). The frontend is plain HTML, CSS, and JS with no build step. Run the tests with `npm test`.

```
server.js          API routes + pages
src/db.js          schema
src/auth.js        passwords, sessions
src/leads.js       lead intake + round-robin routing
src/campaigns.js   call campaigns + buyer eligibility (hours, caps, balance)
src/wallet.js      wallet ledger, call billing, returns, Stripe
src/notify.js      live dashboard events + SMS
src/twilio.js      inbound call flow
public/            landing, quote, login, signup, dashboard
scripts/seed.js    demo data
```

## Ideas for next upgrades

- Supplier portal: let vendors log in, create their own campaigns, and see payouts
- Auto-recharge: top up the wallet automatically when it drops below a set amount
- Bids and priority: agents pay more per call to be rung first
- Email alerts and a mobile app (PWA) with push notifications
- Appointment calendar plus SMS follow-up sequences
- DNC list scrubbing and duplicate lead detection across sources
