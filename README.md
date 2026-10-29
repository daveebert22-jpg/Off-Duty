# TFPD Off Duty — shift filler (v1)

Phone-friendly Off Duty interest + rotation award for Tinton Falls PD.

## Flow

1. Admin logs in, posts a shift (default 20-minute interest window).
2. Officers who have a phone on file are texted the interest link. The shareable link can still be copied.
3. Officers open /s/:id, pick badge/name, tap Interested (no rotation standings shown). They can withdraw before the window closes and before the shift is awarded.
4. After the window (or Close now), if anyone is interested, suggest the officer highest on the rotation (top = waiting longest).
5. If the window ends with nobody interested, the shift stays open: a new interest window starts and officers with a phone are texted that it is still open. That repeats up to `SMS_UNFILLED_RESEND_MAX` times (default **1**). Then the shift closes unfilled. Close now does not resend.
6. Confirm award texts everyone with a phone that the job was filled and who got it, then moves the winner to the bottom of the rotation (saves prior spot).
7. Cancel within ~14 days restores the officer to their prior list position.

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

On Render: open the service → **Environment** → add the three variables → save and redeploy. Do not commit the values. `render.yaml` lists the keys with `sync: false` so a new Blueprint can prompt for them; an existing service needs the values entered in the Dashboard (that flag does not push secrets onto a service that already exists). A US 10-digit number entered in the roster is stored as `+1`. One bad number does not cancel the shift, the award, or the other texts; the shift page shows sent and failed counts.

### When a shift is awarded

Everyone with a phone, including the officer who got the job, receives a short text: `TFPD Off Duty: [title — when] filled by [name] (badge #).` If Twilio is not configured, the award still stands and the award section says texts were not sent.

### Still open

When the interest clock runs out and nobody has tapped in, the shift does not close. It opens another interest window and texts: `TFPD Off Duty: [title — when] still open. Tap to show interest: [url]`. Officers can tap in during that new window. If someone is already interested, the window closes for award instead of resending.

- `SMS_UNFILLED_RESEND_MAX` — how many extra windows/texts an unfilled shift gets. Default **1** (the original window, plus one still-open text). `0` closes with no resend. Values above 24 are treated as 24.
- `SMS_UNFILLED_RESEND_MINUTES` — length of each restarted window. Default is that shift's own interest window (20 minutes unless the admin chose another length).

The server checks about every 30 seconds, and also when someone opens the shift. A manual **Close window now** leaves the shift closed and does not send the still-open text. Missing Twilio config skips the text and leaves the new window open.

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
