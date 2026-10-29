# TFPD Off Duty — shift filler (v1)

Phone-friendly Off Duty interest + rotation award for Tinton Falls PD.

## Flow

1. Admin logs in, posts a shift (default 20-minute interest window).
2. Officers who have a phone on file are texted the interest link. The shareable link can still be copied.
3. Officers open /s/:id, pick badge/name, tap Interested (no rotation standings shown). They can withdraw before the window closes and before the shift is awarded.
4. After window (or Close now), suggest interested officer highest on rotation (top = waiting longest).
5. Confirm award moves winner to bottom of rotation (saves prior spot).
6. Cancel within ~14 days restores officer to prior list position.

Storage: `data/store.json` (shifts/roster). Admin code hash: `data/cfg.json` (created on first setup; not plaintext).

## Admin access

- Only the administrator can post jobs or see the rotation list / standings / awards.
- First visit to `/` with no admin code set → **/setup** (choose a code, min 4 chars).
- Later visits → **/login**, then a session cookie (`od_a`).
- Officers never need the admin code; they only use `/s/<shiftId>`.
- To reset the admin code: delete `data/cfg.json` and restart, then open `/setup` again.

## Text alerts (Twilio)

When an admin creates a shift, the app texts every officer who has a phone number saved on the rotation list. The message is short and includes the shift title/when plus the public interest link (`/s/<id>`).

On Render, the link uses `RENDER_EXTERNAL_URL` when that is set, so texts point at the public site. Locally it uses the host of the admin request.

Empty phone = that officer is skipped. Add or clear phones on the admin home rotation list (admin login required). Do not put phone numbers in `roster.js`; leave them blank until an admin saves them.

Set these environment variables. If any are missing, the shift is still created and the admin shift page says texts were not sent.

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER` (E.164, e.g. `+15551234567`)

On Render: open the service → **Environment** → add the three variables → save and redeploy. Do not commit the values. `render.yaml` lists the keys with `sync: false` so a new Blueprint can prompt for them; an existing service needs the values entered in the Dashboard (that flag does not push secrets onto a service that already exists). A US 10-digit number entered in the roster is stored as `+1`. One bad number does not cancel the shift or the other texts; the shift page shows sent and failed counts.

## Start

    cd /workspace/off-duty-app
    npm start

Listens on http://localhost:3847 (`PORT` env overrides).

- Admin (login required): `/`
- Officer (public): `/s/<shiftId>`

## Verify

    npm test

Expects winner #54 Pierson when Melia (#84), Reyes (#80), and Pierson (#54) are interested.

## Roster

Seeded in roster.js from TFPD Off Duty List. PDF: docs/tfpd-off-duty-list.pdf
