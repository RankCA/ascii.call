# Supabase Setup Guide for ASCII Video Call

This guide walks you through creating a free Supabase project and configuring it so
the [ASCII Video Call](call.html) feature works correctly.

---

## Prerequisites

- A modern browser with webcam access (Chrome ≥ 21, Firefox ≥ 17, Edge, Safari)
- An email address to create a free Supabase account

> **Cost:** Supabase's free tier is sufficient for ASCII video calls.
> No credit card is required.

---

## Step 1 — Create a Supabase account

1. Go to **<https://supabase.com>** and click **Start your project**.
2. Sign up with **GitHub**, **Google**, or your **email address**.
   - If you use email, check your inbox for a confirmation link and click it.
3. After confirming your email you will land on the **Supabase Dashboard**.

---

## Step 2 — Create a new project

1. In the dashboard click **New project**.
2. Fill in the form:
   | Field | What to enter |
   |---|---|
   | **Organization** | Your personal org (created automatically) or pick an existing one |
   | **Name** | Anything you like, e.g. `ascii-video-call` |
   | **Database Password** | A strong password (save it somewhere safe — you won't need it for calls, but it protects your database) |
   | **Region** | Pick the region closest to you or your callers for lower latency |
3. Click **Create new project**.
4. Supabase will provision your project — this takes about **1–2 minutes**.  
   Wait until the dashboard shows **"Project is ready"** before continuing.

---

## Step 3 — Find your Project URL and Anon Key

These two values are what you paste into the `call.html` lobby form.

1. In the left sidebar click **Project Settings** (the gear icon near the bottom).
2. Click the **API** tab (under *Configuration*).
3. You will see two values you need:

   | Label in Supabase | What it looks like | Which field in call.html |
   |---|---|---|
   | **Project URL** | `https://abcdefghijklmnop.supabase.co` | **Supabase Project URL** |
   | **Project API keys → anon / public** | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…` (a long JWT) | **Supabase Anon Key** |

4. Click **Copy** next to each value and keep them handy.

> **Why the anon key is safe to use in the browser:**  
> The anon key only grants access to features you explicitly allow in Supabase's
> Row-Level Security (RLS) policies. ASCII calls use only *ephemeral broadcast
> channels* — no data is ever written to your database — so there is nothing to
> protect with RLS.

---

## Step 4 — Verify that Realtime is enabled

Supabase Realtime is what the ASCII call feature uses to exchange video frames
between participants. It is **enabled by default** for all new projects, but it
is worth double-checking.

1. In the left sidebar click **Realtime**.
2. You should see the Realtime inspector page (not a "feature not enabled" notice).
3. If prompted to enable Realtime, click **Enable Realtime** and wait a moment.

You do **not** need to create any Realtime channels or publications manually —
the call code creates and joins the channel automatically at runtime.

---

## Step 5 — Join a call

1. Open **`call.html`** in your browser  
   (e.g. serve the project with `npx serve .` or any static HTTP server and navigate to it, or deploy it to a host like Netlify/Vercel/GitHub Pages).
2. Paste the values you copied into the lobby form:
   - **Supabase Project URL** → the `https://…supabase.co` URL
   - **Supabase Anon Key** → the long `eyJ…` JWT
   - **Room Name** → any short identifier, e.g. `my-room` (letters, numbers, hyphens only)
3. Click **Join Room**.
4. Allow camera access when your browser asks.
5. You should see your own ASCII feed appear and the status bar show **"Connected"**.

---

## Step 6 — Invite someone to call

Share **two things** with the person you want to call:

1. **The URL** of your deployed `call.html` page.
2. **The Room Name** you chose (e.g. `my-room`).

They will need to supply their own Supabase credentials (or you can share yours for
a quick test — the anon key is designed to be public). Both people just need to
type the **same room name** to be connected.

---

## Troubleshooting

### "Could not initialise Supabase"
- Make sure the Supabase JS library loaded (check browser DevTools → Network tab for `supabase.js`).
- You must be on **HTTPS** or **localhost** — mixed-content restrictions block the CDN script on plain HTTP pages.

### "Connection failed: Channel error"
- Double-check the **Project URL** — it must start with `https://` and end with `.supabase.co`.
- Double-check the **Anon Key** — make sure you copied the full JWT (it is very long; there is often a scroll bar in the Supabase UI).
- Make sure you copied the **anon / public** key, *not* the `service_role` key.

### "Connection timed out"
- Your network or firewall may be blocking WebSocket connections. Supabase Realtime
  uses WebSockets on port 443. Try from a different network (e.g. mobile hotspot).

### Camera not working
- Make sure you are serving the page over **HTTPS** or **localhost**; browsers block
  `getUserMedia` on insecure origins.
- Check that no other app is already using the camera.

### I can't see the remote person's feed
- Confirm both participants joined with **exactly the same room name** (case-sensitive).
- Confirm both participants used the **same Supabase Project URL**.
- Open browser DevTools → Console and look for any errors.
- The remote feed is automatically removed after 12 seconds of inactivity — if the
  other person's camera is paused or their tab is hidden, their feed may disappear.

---

## Free-tier limits

The Supabase free tier is very generous for this use case:

| Resource | Free tier limit | ASCII call usage |
|---|---|---|
| Realtime messages | 2 million / month | ~11 messages/min per person for a 3-fps broadcast |
| Concurrent connections | 200 | 1 per browser tab |
| Monthly active users | 50,000 | N/A (no auth used) |

A 30-minute call between two people uses roughly **330 Realtime messages** —
well within the free tier.
