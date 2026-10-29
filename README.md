# TFPD Off Duty — shift filler (v1)

Phone-friendly Off Duty interest + rotation award for Tinton Falls PD.

## Flow

1. Admin logs in, posts a shift (default 20-minute interest window).
2. Officers who have a phone on file are texted the interest link. The shareable link can still be copied.
3. Officers open /s/:id, pick badge/name, tap Interested (no rotation standings shown). They can withdraw before the window closes and before the shift is awarded. If they already have an awarded job the same Sunday–Saturday week, the confirmation page reminds them and still keeps the interest.
4. After the window (or Close now), if anyone is interested, suggest the officer highest on the rotation (top = waiting longest). On a multi-day job the suggestion walks the list from the top and gives each interested officer their highest-ranked day that still has an open spot. One day per officer in that round. A day can take more than one officer when the job says so.
5. If the window ends with nobody interested, the shift stays open: a new interest window starts and officers with a phone are texted that it is still open. That repeats up to `SMS_UNFILLED_RESEND_MAX` times (default **1**). Then the shift closes unfilled. Close now does not resend.
6. Confirm award texts everyone with a phone that the job was filled and who got it, then moves the winner to the bottom of the rotation (saves prior spot). A multi-day confirm texts every day and who has each spot (or that a spot is still open). Each officer who received a day in that round moves to the bottom once, in the list order from the start of the round.
7. Cancel within ~14 days restores the officer to their prior list position. On a multi-day job, cancel is per awarded spot. The list moves back only when that officer's last day from that round is cancelled.

### Multi-day jobs

When posting, check **This job covers more than one day**, set how many days (2–60), and set **Officers per day** (1–10, default 1). Each day is numbered 1..N and can have its own date and a short label.

Officers open the same interest link, pick their name, and tap days in the order they want them. The order is shown and can be changed with Up, Down, or Remove, or by editing the preference box (`1, 3, 5, 4`). Submitting again before the award updates that order. Withdraw still removes them from consideration.

- **Round 1:** top of the rotation first. Each officer gets their highest-ranked day that still has an open spot. One day each. A day with 2 officers per day stays open until both spots are filled.
- **Round 2:** open spots are the existing still-open resend. Officers who already have a day on this job wait. Same one-day rule for everyone else. It uses the same `SMS_UNFILLED_RESEND_MAX` cap as a shift nobody wanted. If that resend was already used, or the cap is 0, the leftover spots stay unfilled and round 3 does not run. Close window now does not send the text by itself; confirming a partial round 1 award does, when a resend is still allowed.
- **Round 3:** only after that second request, if spots are still open. There is no third text. The admin confirms another pass over the preferences already saved. Officers who already hold a day can take one extra day per pass, from the top of the list, until a pass assigns nothing. Nobody gets two spots on the same day.

The same-week reminder uses each day's own date. An awarded day counts in that day's Sunday–Saturday week. A single-day job is unchanged. Older multi-day jobs saved with one officer on a day still load.

Storage: with `DATABASE_URL` set, one Postgres table `app_kv` (`key` text, `value` jsonb) holds `store` (shifts, roster, phones, awards) and `cfg` (admin code hash). Without `DATABASE_URL`, the same data stays in `data/store.json` and `data/cfg.json`. Admin login sessions stay in memory and are dropped on restart; the admin code itself is kept.

## Admin access

- Only the administrator can post jobs or see the rotation list / standings / awards.
- First visit to `/` with no admin code set → **/setup** (choose a code, min 4 chars).
- Later visits → **/login**, then a session cookie (`od_a`).
- Officers never need the admin code; they only use `/s/<shiftId>`.
- To reset the admin code in file mode: delete `data/cfg.json` and restart, then open `/setup` again.
- To reset it when `DATABASE_URL` is set: `DELETE FROM app_kv WHERE key = 'cfg';` and restart, then open `/setup` again.

## Database (Render)

The free web service disk is wiped on sleep and redeploy. Set `DATABASE_URL` to the **internal** connection string of the Render Postgres instance (same region). The app creates `app_kv` if it is missing. The first boot copies `data/store.json` and `data/cfg.json` into the database when those rows are empty, then uses Postgres from then on. Local runs without `DATABASE_URL` keep using the files.

Internal hostnames connect without SSL. External hostnames use SSL with `rejectUnauthorized: false`. If the first attempt fails, the app tries the other way.

On startup the app replays elapsed interest windows from the saved `closesAt` times: a shift with interested officers closes so it can be awarded, and an unfilled shift reopens and sends the still-open text (same rules as while the process is running). Confirming the award is still an admin action.

Render free Postgres expires 30 days after it was created (**2026-11-28**) unless the database is upgraded. After that date the service cannot save shifts until the database is replaced and `DATABASE_URL` is updated.

`pg` is vendored in the repo because the Render build command is `true` and does not run `npm install`. `node server.js` works from a fresh clone. Changing the build command to `npm install` is optional and not required for this deploy.

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

Everyone with a phone, including the officer who got the job, receives a short text: `TFPD Off Duty: [title — when] filled by [name] (badge #).` A multi-day award lists each day and who got it, or `unfilled`. If Twilio is not configured, the award still stands and the award section says texts were not sent.

### Still open

When the interest clock runs out and nobody has tapped in, the shift does not close. It opens another interest window and texts: `TFPD Off Duty: [title — when] still open. Tap to show interest: [url]`. Officers can tap in during that new window. If someone is already interested, the window closes for award instead of resending.

- `SMS_UNFILLED_RESEND_MAX` — how many extra windows/texts an unfilled shift gets. Default **1** (the original window, plus one still-open text). `0` closes with no resend. Values above 24 are treated as 24.
- `SMS_UNFILLED_RESEND_MINUTES` — length of each restarted window. Default is that shift's own interest window (20 minutes unless the admin chose another length).

The server checks about every 30 seconds, and also when someone opens the shift. A manual **Close window now** leaves the shift closed and does not send the still-open text. Missing Twilio config skips the text and leaves the new window open.

### Same week reminder

Set **Shift date** when posting. That date is the job's calendar day in America/New_York. A week is Sunday through Saturday of that date, not the moment someone taps Interested.

If an officer taps in and already has an active award whose shift date is in that same week, the confirmation page names those jobs (title and when only) and says they may want to leave room for others. Interest is still saved. A cancelled award does not count. Shifts with no date are skipped, because the week cannot be known.

If that officer has a phone and Twilio is configured, they also get one short text for that tap. It is not sent to the rest of the roster.

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
