const { normalizePhone } = require("./util2");
const db = require("./db");

const MISSING =
  "Texts were not sent (Twilio config missing). Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.";

function twilioConfigured() {
  return !!(
    String(process.env.TWILIO_ACCOUNT_SID || "").trim() &&
    String(process.env.TWILIO_AUTH_TOKEN || "").trim() &&
    String(process.env.TWILIO_FROM_NUMBER || "").trim()
  );
}

function twilioConfig() {
  return {
    accountSid: String(process.env.TWILIO_ACCOUNT_SID || "").trim(),
    authToken: String(process.env.TWILIO_AUTH_TOKEN || "").trim(),
    from: String(process.env.TWILIO_FROM_NUMBER || "").trim(),
    configured: twilioConfigured(),
  };
}

function messageFor(shift, base) {
  const root = String(base || "").replace(/\/$/, "");
  const url = root + "/s/" + shift.id;
  const title = String(shift.title || "Off Duty").replace(/\s+/g, " ").trim() || "Off Duty";
  const when = String(shift.whenText || "").replace(/\s+/g, " ").trim();
  const detail = when ? title + " — " + when : title;
  let body = "TFPD Off Duty: " + detail + ". Tap to show interest: " + url;
  if (body.length > 300) {
    body = "TFPD Off Duty: " + title.slice(0, 80) + ". Tap to show interest: " + url;
  }
  return body;
}

function briefError(err) {
  let s = String((err && err.message) || err || "send failed");
  s = s.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  s = s.replace(/Basic\s+\S+/gi, "Basic [redacted]");
  if (s.length > 160) s = s.slice(0, 157) + "...";
  return s;
}

async function sendOne(cfg, to, body, fetchImpl) {
  const url =
    "https://api.twilio.com/2010-04-01/Accounts/" +
    encodeURIComponent(cfg.accountSid) +
    "/Messages.json";
  const auth = Buffer.from(cfg.accountSid + ":" + cfg.authToken).toString("base64");
  const params = new URLSearchParams({ To: to, From: cfg.from, Body: body });
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch (e) { detail = ""; }
    throw new Error("Twilio " + res.status + (detail ? ": " + detail.slice(0, 180) : ""));
  }
  try { await res.text(); } catch (e) { /* ignore body */ }
}

async function eachLimited(items, limit, fn) {
  if (!items.length) return;
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function notifyShift(shift, base, opts) {
  opts = opts || {};
  const cfg = twilioConfig();
  const roster = db.getRoster();
  let skipped = 0;
  const targets = [];
  const failures = [];

  if (!cfg.configured) {
    roster.forEach((o) => {
      if (!String(o.phone || "").trim()) skipped++;
    });
    return {
      configured: false,
      sent: 0,
      failed: 0,
      skipped,
      note: MISSING,
      failures: [],
    };
  }

  const from = normalizePhone(cfg.from);
  roster.forEach((o) => {
    const raw = o.phone == null ? "" : String(o.phone).trim();
    if (!raw) {
      skipped++;
      return;
    }
    const phone = normalizePhone(raw);
    if (!phone) {
      failures.push({ badge: o.badge, name: o.name, error: "Invalid phone number" });
      return;
    }
    targets.push({ badge: o.badge, name: o.name, phone });
  });

  if (!from) {
    return {
      configured: true,
      sent: 0,
      failed: failures.length,
      skipped,
      note: "Texts were not sent (TWILIO_FROM_NUMBER must be E.164, e.g. +15551234567). The shift was still created.",
      failures,
    };
  }

  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    targets.forEach((t) => {
      failures.push({ badge: t.badge, name: t.name, error: "SMS client unavailable" });
    });
    return {
      configured: true,
      sent: 0,
      failed: failures.length,
      skipped,
      note: "Texts were not sent (SMS client unavailable). The shift was still created.",
      failures,
    };
  }

  const text = messageFor(shift, base);
  const sending = Object.assign({}, cfg, { from });
  let sent = 0;
  await eachLimited(targets, 5, async (t) => {
    try {
      await sendOne(sending, t.phone, text, fetchImpl);
      sent++;
    } catch (err) {
      failures.push({ badge: t.badge, name: t.name, error: briefError(err) });
    }
  });

  const failed = failures.length;
  return {
    configured: true,
    sent,
    failed,
    skipped,
    note: "Texts: " + sent + " sent, " + failed + " failed, " + skipped + " skipped (no phone).",
    failures,
  };
}

module.exports = {
  twilioConfigured,
  twilioConfig,
  messageFor,
  notifyShift,
  MISSING,
};
