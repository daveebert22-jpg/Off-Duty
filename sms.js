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

function shiftDetail(shift) {
  const title = String((shift && shift.title) || "Off Duty").replace(/\s+/g, " ").trim() || "Off Duty";
  const when = String((shift && shift.whenText) || "").replace(/\s+/g, " ").trim();
  return { title, when, detail: when ? title + " — " + when : title };
}

function isMulti(shift) {
  return !!(shift && Array.isArray(shift.days) && shift.days.length > 1);
}

function unfilledDayNums(shift) {
  if (!isMulti(shift)) return [];
  const assigned = shift.assignments || {};
  return shift.days.map((d) => d.n).filter((n) => {
    const slot = assigned[String(n)] || assigned[n];
    return !(slot && slot.badge);
  });
}

function interestUrl(shift, base) {
  const root = String(base || "").replace(/\/$/, "");
  return root + "/s/" + shift.id;
}

function messageFor(shift, base) {
  const d = shiftDetail(shift);
  const url = interestUrl(shift, base);
  const tail = isMulti(shift)
    ? ". " + shift.days.length + "-day job. Tap to show interest: " + url
    : ". Tap to show interest: " + url;
  let body = "TFPD Off Duty: " + d.detail + tail;
  if (body.length > 300) body = "TFPD Off Duty: " + d.title.slice(0, 80) + tail;
  return body;
}

function messageAwarded(shift) {
  const d = shiftDetail(shift);
  if (isMulti(shift)) {
    const assigned = shift.assignments || {};
    const parts = shift.days.slice().sort((a, b) => a.n - b.n).map((day) => {
      const slot = assigned[String(day.n)] || assigned[day.n];
      const who = slot && slot.badge
        ? String(slot.name || "Officer").replace(/\s+/g, " ").trim() + " #" + String(slot.badge).trim()
        : "unfilled";
      const label = String(day.label || "").replace(/\s+/g, " ").trim();
      const extra = label || (day.date ? String(day.date) : "");
      return "Day " + day.n + (extra ? " " + extra : "") + ": " + who;
    });
    let body = "TFPD Off Duty: " + d.detail + " filled. " + parts.join("; ") + ".";
    if (body.length > 1400) body = body.slice(0, 1397) + "...";
    return body;
  }
  const name = String((shift && shift.winnerName) || "an officer").replace(/\s+/g, " ").trim();
  const badge = String((shift && shift.winnerBadge) || "").replace(/\s+/g, " ").trim();
  let body = "TFPD Off Duty: " + d.detail + " filled by " + name + " (badge #" + badge + ").";
  if (body.length > 300) body = "TFPD Off Duty: " + d.title.slice(0, 80) + " filled by " + name + " (badge #" + badge + ").";
  return body;
}

function messageStillOpen(shift, base) {
  const d = shiftDetail(shift);
  const url = interestUrl(shift, base);
  const openDays = unfilledDayNums(shift);
  const dayNote = openDays.length ? " for days " + openDays.join(", ") : "";
  let body = "TFPD Off Duty: " + d.detail + " still open" + dayNote + ". Tap to show interest: " + url;
  if (body.length > 300) body = "TFPD Off Duty: " + d.title.slice(0, 80) + " still open" + dayNote + ". Tap to show interest: " + url;
  if (body.length > 300) body = "TFPD Off Duty: " + d.title.slice(0, 60) + " still open. Tap to show interest: " + url;
  return body;
}

const PURPOSE = {
  create: {
    missing: MISSING,
    badFrom: "Texts were not sent (TWILIO_FROM_NUMBER must be E.164, e.g. +15551234567). The shift was still created.",
    noClient: "Texts were not sent (SMS client unavailable). The shift was still created.",
  },
  award: {
    missing: "Texts were not sent (Twilio config missing). The award was saved.",
    badFrom: "Texts were not sent (TWILIO_FROM_NUMBER must be E.164, e.g. +15551234567). The award was saved.",
    noClient: "Texts were not sent (SMS client unavailable). The award was saved.",
  },
  resend: {
    missing: "Texts were not sent (Twilio config missing). The shift is still open.",
    badFrom: "Texts were not sent (TWILIO_FROM_NUMBER must be E.164, e.g. +15551234567). The shift is still open.",
    noClient: "Texts were not sent (SMS client unavailable). The shift is still open.",
  },
};

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

async function deliver(text, opts, purpose) {
  opts = opts || {};
  const notes = PURPOSE[purpose] || PURPOSE.create;
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
      note: notes.missing,
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
      note: notes.badFrom,
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
      note: notes.noClient,
      failures,
    };
  }

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

  return {
    configured: true,
    sent,
    failed: failures.length,
    skipped,
    note: "Texts: " + sent + " sent, " + failures.length + " failed, " + skipped + " skipped (no phone).",
    failures,
  };
}

async function notifyShift(shift, base, opts) {
  return deliver(messageFor(shift, base), opts, "create");
}

async function notifyAwarded(shift, opts) {
  return deliver(messageAwarded(shift), opts, "award");
}

async function notifyStillOpen(shift, base, opts) {
  const full = (shift && shift.id && db.getShift(shift.id)) || shift;
  return deliver(messageStillOpen(full, base), opts, "resend");
}

function messageSameWeek(shift, jobs) {
  const d = shiftDetail(shift);
  const label = (j) => {
    const when = [j.whenText, j.whenDate].filter(Boolean).join(" ");
    const title = String(j.title || "Off Duty").replace(/\s+/g, " ").trim();
    return when ? title + " (" + when.replace(/\s+/g, " ").trim() + ")" : title;
  };
  const first = label(jobs[0] || {});
  const more = jobs.length > 1 ? " +" + (jobs.length - 1) + " more" : "";
  let body = "TFPD Off Duty: You already have " + first + more +
    " this week. You can still take " + d.detail + ", or leave it for someone else.";
  if (body.length > 300) {
    body = "TFPD Off Duty: You already have " + first.slice(0, 80) +
      " this week. You can still take " + d.title.slice(0, 40) + ", or leave it for someone else.";
  }
  return body;
}

// One text to the officer who just tapped in. Never the whole roster.
async function notifySameWeek(shift, interest, jobs, opts) {
  opts = opts || {};
  if (!jobs || !jobs.length || !interest) return { sent: false, reason: "none" };
  if (!twilioConfigured()) return { sent: false, reason: "config" };
  const from = normalizePhone(twilioConfig().from);
  if (!from) return { sent: false, reason: "from" };
  const officer = db.getRoster().find((o) => o.badge === String(interest.badge));
  const phone = normalizePhone(officer && officer.phone);
  if (!phone) return { sent: false, reason: "nophone" };
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") return { sent: false, reason: "noclient" };
  try {
    await sendOne(Object.assign({}, twilioConfig(), { from }), phone, messageSameWeek(shift, jobs), fetchImpl);
    return { sent: true, reason: "sent" };
  } catch (err) {
    return { sent: false, reason: "failed" };
  }
}

module.exports = {
  twilioConfigured,
  twilioConfig,
  messageFor,
  messageAwarded,
  messageStillOpen,
  notifyShift,
  notifyAwarded,
  notifyStillOpen,
  messageSameWeek,
  notifySameWeek,
  MISSING,
};
