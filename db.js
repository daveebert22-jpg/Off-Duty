const fs = require("fs");
const path = require("path");
const seedRoster = require("./roster");
const { normalizePhone } = require("./util2");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "store.json");
const RESTORE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // ~14 days

function blankStore() {
  return {
    roster: seedRoster.map((o, i) => ({ ...o, order: i })),
    shifts: [],
    interests: [],
    awards: [],
    nextShiftId: 1,
    nextAwardId: 1,
  };
}

function writeRaw(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    writeRaw(blankStore());
    return;
  }
  const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  let dirty = false;
  if (!Array.isArray(data.awards)) {
    data.awards = [];
    dirty = true;
  }
  if (data.nextAwardId == null) {
    data.nextAwardId = 1;
    dirty = true;
  }
  if (dirty) writeRaw(data);
}

function read() {
  ensure();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function write(data) {
  writeRaw(data);
}

function resetToSeed() {
  ensure();
  const data = blankStore();
  write(data);
  return data;
}

function getRoster() {
  return read().roster.slice().sort((a, b) => a.order - b.order);
}

function createShift({ title, location, whenText, notes, windowMinutes }) {
  const data = read();
  const id = String(data.nextShiftId++);
  const now = Date.now();
  const mins = Number(windowMinutes) > 0 ? Number(windowMinutes) : 20;
  const shift = {
    id,
    title: title || "Off Duty",
    location: location || "",
    whenText: whenText || "",
    notes: notes || "",
    windowMinutes: mins,
    createdAt: now,
    closesAt: now + mins * 60 * 1000,
    status: "open",
    winnerBadge: null,
    winnerName: null,
    awardedAt: null,
    awardId: null,
    cancelledAt: null,
    resendCount: 0,
    resendPending: false,
    lastResendAt: null,
  };
  data.shifts.push(shift);
  write(data);
  return shift;
}

function getShift(id) {
  return read().shifts.find((s) => s.id === String(id)) || null;
}

function listShifts() {
  return read().shifts.slice().sort((a, b) => b.createdAt - a.createdAt);
}

function getInterests(shiftId) {
  return read().interests.filter((i) => i.shiftId === String(shiftId));
}

function unfilledResendMax() {
  const raw = process.env.SMS_UNFILLED_RESEND_MAX;
  if (raw == null || String(raw).trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(24, Math.floor(n));
}

function resendWindowMinutes(shift) {
  const raw = process.env.SMS_UNFILLED_RESEND_MINUTES;
  const fallback = Number(shift.windowMinutes) > 0 ? Number(shift.windowMinutes) : 20;
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(24 * 60, n);
}

// When an open window has elapsed: close if anyone is interested (ready to award)
// or the resend cap is hit. Otherwise start another interest window and flag SMS.
function rollInterestWindow(shiftId, now) {
  now = now || Date.now();
  const data = read();
  const shift = data.shifts.find((s) => s.id === String(shiftId));
  if (!shift) return { error: "Shift not found", status: 404 };
  if (shift.status !== "open") return { action: "none", shift: getShift(shiftId) };
  if (now <= shift.closesAt) return { action: "open", shift: getShift(shiftId) };

  const interested = data.interests.some((i) => i.shiftId === String(shiftId));
  if (interested) {
    shift.status = "closed";
    shift.closesAt = Math.min(shift.closesAt, now);
    shift.resendPending = false;
    write(data);
    return { action: "closed", reason: "interested", shift: getShift(shiftId) };
  }

  const count = Number(shift.resendCount) || 0;
  if (count >= unfilledResendMax()) {
    shift.status = "closed";
    shift.closesAt = Math.min(shift.closesAt, now);
    shift.resendPending = false;
    write(data);
    return { action: "closed", reason: "cap", shift: getShift(shiftId) };
  }

  const mins = resendWindowMinutes(shift);
  shift.resendCount = count + 1;
  shift.lastResendAt = now;
  shift.closesAt = now + mins * 60 * 1000;
  shift.resendWindowMinutes = mins;
  shift.resendPending = true;
  shift.status = "open";
  write(data);
  return { action: "resend", shift: getShift(shiftId) };
}

function rollExpiredShifts(now) {
  now = now || Date.now();
  const data = read();
  const ids = data.shifts
    .filter((s) => s.status === "open" && now > s.closesAt)
    .map((s) => s.id);
  return ids.map((id) => rollInterestWindow(id, now));
}

function takePendingResends() {
  const data = read();
  const pending = [];
  data.shifts.forEach((s) => {
    if (!s.resendPending) return;
    s.resendPending = false;
    pending.push({
      id: s.id,
      title: s.title,
      whenText: s.whenText,
      location: s.location,
      resendCount: s.resendCount,
    });
  });
  if (pending.length) write(data);
  return pending;
}

function addInterest(shiftId, badge) {
  const rolled = rollInterestWindow(shiftId);
  if (rolled.error) return rolled;
  const data = read();
  const shift = data.shifts.find((s) => s.id === String(shiftId));
  if (!shift) return { error: "Shift not found", status: 404 };
  if (shift.status !== "open") return { error: "Interest window has ended", status: 400 };
  const officer = data.roster.find((o) => o.badge === String(badge));
  if (!officer) return { error: "Unknown badge", status: 400 };
  const already = data.interests.find(
    (i) => i.shiftId === String(shiftId) && i.badge === String(badge)
  );
  if (already) return { error: "Already marked interested", status: 409, interest: already };
  const interest = {
    shiftId: String(shiftId),
    badge: officer.badge,
    name: officer.name,
    at: Date.now(),
  };
  data.interests.push(interest);
  write(data);
  return { interest };
}

function removeInterest(shiftId, badge) {
  const rolled = rollInterestWindow(shiftId);
  if (rolled.error) return rolled;
  const data = read();
  const shift = data.shifts.find((s) => s.id === String(shiftId));
  if (!shift) return { error: "Shift not found", status: 404 };
  const tooLate = "Too late — the interest window is closed, so interest can no longer be withdrawn.";
  if (shift.status !== "open") return { error: tooLate, status: 400 };
  if (badge == null || String(badge).trim() === "") return { error: "Badge required", status: 400 };
  const officer = data.roster.find((o) => o.badge === String(badge));
  if (!officer) return { error: "Unknown badge", status: 400 };
  const removed = data.interests.filter(
    (i) => i.shiftId === String(shiftId) && i.badge === String(badge)
  );
  if (!removed.length) return { error: "You are not marked interested on this shift", status: 400 };
  data.interests = data.interests.filter(
    (i) => !(i.shiftId === String(shiftId) && i.badge === String(badge))
  );
  write(data);
  return { interest: removed[0], shift };
}

function setOfficerPhone(badge, phone) {
  const data = read();
  const officer = data.roster.find((o) => o.badge === String(badge));
  if (!officer) return { error: "Unknown badge", status: 404 };
  const raw = phone == null ? "" : String(phone).trim();
  if (!raw) {
    officer.phone = "";
    write(data);
    return { officer: { badge: officer.badge, name: officer.name, phone: "" } };
  }
  const normalized = normalizePhone(raw);
  if (!normalized) {
    return { error: "Enter a 10-digit US number or E.164 (+1…)", status: 400 };
  }
  officer.phone = normalized;
  write(data);
  return { officer: { badge: officer.badge, name: officer.name, phone: officer.phone } };
}

function recordSmsSummary(shiftId, summary, field) {
  const data = read();
  const shift = data.shifts.find((s) => s.id === String(shiftId));
  if (!shift) return { error: "Shift not found", status: 404 };
  const key = field === "awardSms" || field === "resendSms" ? field : "sms";
  summary = summary || {};
  const failures = Array.isArray(summary.failures) ? summary.failures : [];
  shift[key] = {
    configured: !!summary.configured,
    sent: Number(summary.sent) || 0,
    failed: Number(summary.failed) || 0,
    skipped: Number(summary.skipped) || 0,
    note: String(summary.note || "").slice(0, 300),
    failures: failures.slice(0, 8).map((f) => ({
      badge: String((f && f.badge) || ""),
      name: String((f && f.name) || ""),
      error: String((f && f.error) || "").slice(0, 160),
    })),
  };
  write(data);
  return { sms: shift[key] };
}

function closeShift(shiftId) {
  const data = read();
  const shift = data.shifts.find((s) => s.id === String(shiftId));
  if (!shift) return { error: "Shift not found", status: 404 };
  if (shift.status === "awarded") return { error: "Already awarded", status: 400 };
  if (shift.status === "cancelled") return { error: "Award was cancelled", status: 400 };
  shift.status = "closed";
  shift.closesAt = Math.min(shift.closesAt, Date.now());
  shift.resendPending = false;
  write(data);
  return { shift, suggestion: computeWinner(data, shiftId) };
}

function computeWinner(data, shiftId) {
  const interests = data.interests.filter((i) => i.shiftId === String(shiftId));
  if (!interests.length) return null;
  const interestedBadges = new Set(interests.map((i) => i.badge));
  const roster = data.roster.slice().sort((a, b) => a.order - b.order);
  const winner = roster.find((o) => interestedBadges.has(o.badge));
  return winner || null;
}

function suggestWinner(shiftId) {
  const rolled = rollInterestWindow(shiftId);
  if (rolled.error) return rolled;
  return {
    shift: getShift(shiftId),
    interests: getInterests(shiftId),
    suggestion: computeWinner(read(), shiftId),
  };
}

function confirmAward(shiftId) {
  const data = read();
  const shift = data.shifts.find((s) => s.id === String(shiftId));
  if (!shift) return { error: "Shift not found", status: 404 };
  if (shift.status === "awarded") return { error: "Already awarded", status: 400 };
  if (shift.status === "cancelled") return { error: "Award was cancelled", status: 400 };
  if (shift.status === "open") {
    shift.status = "closed";
    shift.closesAt = Math.min(shift.closesAt, Date.now());
  }
  shift.resendPending = false;
  const winner = computeWinner(data, shiftId);
  if (!winner) return { error: "No interested officers", status: 400 };

  const sorted = data.roster.slice().sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((o) => o.badge === winner.badge);
  if (idx < 0) return { error: "Winner not on roster", status: 400 };

  const priorOrder = idx;
  const priorLastAward = sorted[idx].lastAward;

  const [w] = sorted.splice(idx, 1);
  const today = new Date();
  const md = today.getMonth() + 1 + "-" + today.getDate();
  w.lastAward = md;
  sorted.push(w);
  sorted.forEach((o, i) => {
    o.order = i;
  });
  data.roster = sorted;

  const awardedAt = Date.now();
  if (data.nextAwardId == null) data.nextAwardId = 1;
  if (!Array.isArray(data.awards)) data.awards = [];
  const awardId = String(data.nextAwardId++);
  const award = {
    id: awardId,
    shiftId: String(shiftId),
    badge: winner.badge,
    name: winner.name,
    awardedAt,
    priorOrder,
    priorLastAward,
    status: "active",
    cancelledAt: null,
    restored: false,
  };
  data.awards.push(award);

  shift.status = "awarded";
  shift.winnerBadge = winner.badge;
  shift.winnerName = winner.name;
  shift.awardedAt = awardedAt;
  shift.awardId = awardId;
  shift.priorOrder = priorOrder;
  shift.priorLastAward = priorLastAward;
  shift.cancelledAt = null;
  write(data);
  return { shift, winner, award, roster: getRoster() };
}

function awardRestoreInfo(award, now) {
  now = now || Date.now();
  if (!award) return { canRestore: false, reason: "Award not found" };
  if (award.status === "cancelled") {
    return { canRestore: false, reason: "Already cancelled; roster was restored" };
  }
  const age = now - award.awardedAt;
  if (age > RESTORE_WINDOW_MS) {
    const days = Math.floor(age / (24 * 60 * 60 * 1000));
    return {
      canRestore: false,
      reason:
        "Restore unavailable — award is more than 14 days old (" +
        days +
        " days ago). Officer stays at current rotation spot.",
    };
  }
  return {
    canRestore: true,
    reason: null,
    daysLeft: Math.ceil((RESTORE_WINDOW_MS - age) / (24 * 60 * 60 * 1000)),
  };
}

function hasNewerActiveAward(data, award) {
  return (data.awards || []).some((a) => {
    if (a.badge !== award.badge || a.id === award.id || a.status !== "active") return false;
    if (a.awardedAt > award.awardedAt) return true;
    // Same ms (fast successive awards): treat higher award id as newer
    if (a.awardedAt === award.awardedAt && Number(a.id) > Number(award.id)) return true;
    return false;
  });
}

function cancelAward(shiftId) {
  const data = read();
  const shift = data.shifts.find((s) => s.id === String(shiftId));
  if (!shift) return { error: "Shift not found", status: 404 };
  if (shift.status !== "awarded") {
    return { error: "Shift is not awarded (status: " + shift.status + ")", status: 400 };
  }

  let award =
    (data.awards || []).find((a) => a.id === shift.awardId) ||
    (data.awards || []).find((a) => a.shiftId === String(shiftId) && a.status === "active");

  if (!award && shift.winnerBadge != null) {
    return {
      error:
        "Cannot restore — this award has no saved prior list position. Re-seed or re-award after this update.",
      status: 400,
    };
  }
  if (!award) return { error: "Award record not found", status: 404 };

  const info = awardRestoreInfo(award);
  if (!info.canRestore) {
    return { error: info.reason, status: 400, award };
  }

  if (hasNewerActiveAward(data, award)) {
    return {
      error:
        "Cannot restore — #" +
        award.badge +
        " " +
        award.name +
        " has a newer active award that already moved them on the list. Cancel the newer award first, or leave them where they are.",
      status: 409,
      award,
    };
  }

  const sorted = data.roster.slice().sort((a, b) => a.order - b.order);
  const curIdx = sorted.findIndex((o) => o.badge === award.badge);
  if (curIdx < 0) return { error: "Officer no longer on roster", status: 400 };

  const [officer] = sorted.splice(curIdx, 1);
  officer.lastAward = award.priorLastAward;
  const insertAt = Math.max(0, Math.min(award.priorOrder, sorted.length));
  sorted.splice(insertAt, 0, officer);
  sorted.forEach((o, i) => {
    o.order = i;
  });
  data.roster = sorted;

  award.status = "cancelled";
  award.cancelledAt = Date.now();
  award.restored = true;

  shift.status = "cancelled";
  shift.cancelledAt = award.cancelledAt;

  write(data);
  return {
    shift: getShift(shiftId),
    award,
    restored: {
      badge: officer.badge,
      name: officer.name,
      order: insertAt,
      lastAward: officer.lastAward,
    },
    roster: getRoster(),
  };
}

function listRecentAwards(opts) {
  opts = opts || {};
  const now = Date.now();
  const horizon = opts.horizonMs != null ? opts.horizonMs : RESTORE_WINDOW_MS;
  const data = read();
  return (data.awards || [])
    .slice()
    .sort((a, b) => b.awardedAt - a.awardedAt)
    .filter((a) => now - a.awardedAt <= horizon || a.status === "active")
    .map((a) => {
      const shift = data.shifts.find((s) => s.id === a.shiftId);
      const restore = awardRestoreInfo(a, now);
      const blockedByNewer = restore.canRestore && hasNewerActiveAward(data, a);
      return Object.assign({}, a, {
        shiftTitle: shift ? shift.title : "(deleted)",
        whenText: shift ? shift.whenText : "",
        canRestore: restore.canRestore && !blockedByNewer,
        restoreBlockedReason: blockedByNewer
          ? "Newer active award already moved this officer"
          : restore.reason,
        daysLeft: restore.daysLeft || null,
      });
    });
}

function getAwardById(id) {
  return (read().awards || []).find((a) => a.id === String(id)) || null;
}

module.exports = {
  resetToSeed,
  getRoster,
  createShift,
  getShift,
  listShifts,
  getInterests,
  addInterest,
  removeInterest,
  rollInterestWindow,
  rollExpiredShifts,
  takePendingResends,
  unfilledResendMax,
  setOfficerPhone,
  recordSmsSummary,
  closeShift,
  suggestWinner,
  confirmAward,
  cancelAward,
  listRecentAwards,
  getAwardById,
  awardRestoreInfo,
  RESTORE_WINDOW_MS,
  DB_PATH,
};
