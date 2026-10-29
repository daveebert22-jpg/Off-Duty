# TFPD Off Duty — shift filler (v1)

Phone-friendly Off Duty interest + rotation award for Tinton Falls PD.

## Flow

1. Admin logs in, posts a shift (default 20-minute interest window).
2. Copy shareable link and text the squad.
3. Officers open /s/:id, pick badge/name, tap Interested (no rotation standings shown).
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
