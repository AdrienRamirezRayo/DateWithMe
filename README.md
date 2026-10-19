# ⚡ LeadRush

Inbound lead and call system for life insurance agents. Ads drive people to a quote page or phone number, and LeadRush routes each lead or call in real time to an online agent licensed in that state. Every lead is tracked from the first touch to the sold policy.

## What's in it

| Page | Who uses it | What it does |
|---|---|---|
| `/` | Agents you're recruiting | Marketing site: features, how it works, pricing |
| `/quote` | Consumers (ad traffic) | 4-step quote form with TCPA consent and UTM tracking |
| `/signup`, `/login` | Agents | Agent accounts (new agents wait for admin approval) |
| `/dashboard` | Agents and admins | Live leads, pipeline, stats, campaigns, settings |

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
- Calls to your Twilio number ring every online agent licensed in the caller's state at the same time
- The agent has to **press a key to accept**, so a personal voicemail can't "answer" the call
- If no one answers, the caller leaves a voicemail. The voicemail is attached to the lead, which goes to the next agent in rotation for a callback.
- SMS alert to the agent for every new lead

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
- With demo data, log in as `admin@leadrush.test` / `password123`.
- Without demo data, the **first account you create becomes the admin**.

## Put it online

Any Node host with a persistent disk will work. **Render** is the easiest:

1. Push this repo to GitHub (already done).
2. On [render.com](https://render.com), choose **New → Blueprint** and pick this repo. `render.yaml` sets up the server and a disk for the database.
3. In the service's **Environment** settings, fill in `PUBLIC_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
4. Point your domain at it.

The database is a single SQLite file at `DATABASE_PATH`. Back up that file to back up everything.

## Turn on live calls and SMS (Twilio)

1. Create a [Twilio](https://twilio.com) account and buy a phone number. Give that number to your ad guy for call ads.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` in your environment.
3. In Twilio, go to **Phone Numbers → your number → Voice → "A call comes in"** and set it to Webhook, `https://YOUR-DOMAIN/api/twilio/voice`, method **POST**.
4. Make sure each agent has their mobile number in **Settings** and flips on **Receiving leads**.

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
src/notify.js      live dashboard events + SMS
src/twilio.js      inbound call flow
public/            landing, quote, login, signup, dashboard
scripts/seed.js    demo data
```

## Ideas for next upgrades

- Billing: Stripe pay-per-lead or call, with agent wallets and daily caps
- Lead pricing and filters per agent (age range, coverage type, daily max)
- Call recording playback for every call, plus call-length billing (for example, a 90-second qualifier)
- Email alerts and a mobile app (PWA) with push notifications
- Appointment calendar plus SMS follow-up sequences
- DNC list scrubbing and duplicate lead detection across sources
