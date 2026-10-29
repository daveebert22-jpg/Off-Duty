const fs = require("fs");
const path = require("path");
const seedRoster = require("./roster");
const { normalizePhone } = require("./util2");
const persist = require("./persist");
const { allocateDays, normalizeRanks, slotsPerDayOf, dayAssignees } = require("./lib/allocate");

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
  if (persist.usingPg()) return;
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

function normalizeLoaded(data) {
  let dirty = false;
  if (!data || typeof data !== "object") return { data: blankStore(), dirty: true };
  if (!Array.isArray(data.awards)) {
    data.awards = [];
    dirty = true;
  }
  if (data.nextAwardId == null) {
    data.nextAwardId = 1;
    dirty = true;
  }
  return { data, dirty };
}

function read() {
  if (persist.usingPg()) {
    const loaded = normalizeLoaded(persist.readStore() || blankStore());
    if (loaded.dirty) write(loaded.data);
    return loaded.data;
  }
  ensure();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function write(data) {
  if (persist.usingPg()) {
    persist.writeStore(data);
    return;
  }
  writeRaw(data);
}

async function bootstrap() {
  await persist.init();
  if (persist.usingPg() && !persist.hasStore()) {
    write(blankStore());
    await persist.flush();
  }
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

function isIsoDate(raw) {
  const s = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function normalizeWhenDate(raw) {
  const s = String(raw || "").trim();
  return isIsoDate(s) ? s : "";
}

// Sunday that starts the America/New_York calendar week containing this shift date.
// whenDate is the job's calendar day (not the moment someone tapped).
function weekStartKey(isoDate) {
  if (!isIsoDate(isoDate)) return "";
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const sunday = new Date(utc);
  sunday.setUTCDate(utc.getUTCDate() - utc.getUTCDay());
  const sm = String(sunday.getUTCMonth() + 1).padStart(2, "0");
  const sd = String(sunday.getUTCDate()).padStart(2, "0");
  return sunday.getUTCFullYear() + "-" + sm + "-" + sd;
}

function isMultiDay(shift) {
  return !!(shift && Array.isArray(shift.days) && shift.days.length > 1);
}

function assignedMap(shift) {
  const src = shift && shift.assignments && typeof shift.assignments === "object" ? shift.assignments : {};
  return src;
}

function assigneesFor(shift, day) {
  const src = assignedMap(shift);
  return dayAssignees(src[String(day)] || src[day]);
}

function unfilledDayNumbers(shift) {
  if (!isMultiDay(shift)) return [];
  const cap = slotsPerDayOf(shift);
  return shift.days.map((d) => d.n).filter((n) => assigneesFor(shift, n).length < cap);
}

function hasAnyAssignee(shift) {
  const src = assignedMap(shift);
  return Object.keys(src).some((k) => dayAssignees(src[k]).length > 0);
}

function cleanLabel(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function normalizeDayList(list) {
  if (!Array.isArray(list)) return null;
  const days = [];
  list.forEach((item, idx) => {
    if (days.length >= 60) return;
    const src = item && typeof item === "object" ? item : { label: String(item || "") };
    let n = Number(src.n != null ? src.n : src.day);
    if (!Number.isInteger(n) || n < 1) n = idx + 1;
    days.push({
      n,
      date: normalizeWhenDate(src.date || src.whenDate || ""),
      label: cleanLabel(src.label || ""),
    });
  });
  if (days.length < 2) return null;
  const seen = new Set();
  const contiguous = days.every((d, i) => d.n === i + 1) && days.every((d) => {
    if (seen.has(d.n)) return false;
    seen.add(d.n);
    return d.n >= 1 && d.n <= 60;
  });
  if (!contiguous) {
    return days.slice(0, 60).map((d, i) => ({ n: i + 1, date: d.date, label: d.label }));
  }
  return days;
}

function parseDays(input) {
  if (!input || typeof input !== "object") return null;
  let list = input.days;
  if (typeof list === "string" && list.trim().charAt(0) === "[") {
    try { list = JSON.parse(list); } catch (e) { list = null; }
  }
  if (Array.isArray(list) && list.length) {
    const norm = normalizeDayList(list);
    if (norm) return norm;
  }
  const flag = input.multiDay === "on" || input.multiDay === "1" || input.multiDay === "true" || input.multiDay === true || input.multiDay === "yes";
  if (!flag) return null;
  let n = Math.floor(Number(input.dayCount));
  if (!Number.isFinite(n) || n < 2) n = 5;
  if (n > 60) n = 60;
  const days = [];
  for (let i = 1; i <= n; i++) {
    days.push({
      n: i,
      date: normalizeWhenDate(input["dayDate" + i] || input["day_date_" + i] || ""),
      label: cleanLabel(input["dayLabel" + i] || input["day_label_" + i] || ""),
    });
  }
  return days;
}

function awardDates(award, shift) {
  if (award && Array.isArray(award.days) && award.days.length) {
    const dates = award.days.map((d) => {
      const explicit = award.dayDates && award.dayDates[String(d)];
      if (isIsoDate(explicit)) return explicit;
      return isIsoDate(shift && shift.whenDate) ? shift.whenDate : "";
    }).filter((d) => isIsoDate(d));
    if (dates.length) return dates;
  }
  if (award && isIsoDate(award.dayDate)) return [award.dayDate];
  if (shift && isIsoDate(shift.whenDate)) return [shift.whenDate];
  return [];
}

function sameWeekAwards(badge, whenDate, extraDates, exceptShiftId) {
  const keys = new Set();
  const primary = weekStartKey(whenDate);
  if (primary) keys.add(primary);
  (extraDates || []).forEach((d) => {
    const k = weekStartKey(d);
    if (k) keys.add(k);
  });
  if (!keys.size) return [];
  const data = read();
  const out = [];
  const seenShift = new Set();
  (data.awards || []).forEach((a) => {
    if (String(a.badge) !== String(badge) || a.status !== "active") return;
    if (exceptShiftId && String(a.shiftId) === String(exceptShiftId)) return;
    if (seenShift.has(a.shiftId)) return;
    const shift = data.shifts.find((s) => s.id === a.shiftId);
    if (!shift || shift.status === "cancelled") return;
    if (shift.status !== "awarded" && shift.status !== "open" && shift.status !== "closed") return;
    const dates = awardDates(a, shift);
    const match = dates.find((d) => keys.has(weekStartKey(d)));
    if (!match) return;
    let dayNum = null;
    if (a.dayDates && Array.isArray(a.days)) {
      a.days.forEach((d) => {
        if (dayNum == null && a.dayDates[String(d)] === match) dayNum = Number(d);
      });
    }
    const whenText = dayNum
      ? "Day " + dayNum + (shift.whenText ? " · " + shift.whenText : "")
      : (shift.whenText || "");
    seenShift.add(shift.id);
    out.push({
      shiftId: shift.id,
      title: shift.title || "Off Duty",
      whenText,
      whenDate: match || shift.whenDate || "",
    });
  });
  return out;
}

function interestDates(shift, ranks) {
  if (!isMultiDay(shift)) return { whenDate: shift.whenDate || "", extra: [] };
  const dates = (ranks || []).map((n) => {
    const meta = shift.days.find((d) => d.n === Number(n));
    if (meta && isIsoDate(meta.date)) return meta.date;
    return isIsoDate(shift.whenDate) ? shift.whenDate : "";
  }).filter((d) => isIsoDate(d));
  return { whenDate: dates[0] || "", extra: dates.slice(1) };
}

function createShift(input) {
  input = input || {};
  const data = read();
  const id = String(data.nextShiftId++);
  const now = Date.now();
  const mins = Number(input.windowMinutes) > 0 ? Number(input.windowMinutes) : 20;
  const days = parseDays(input);
  const shift = {
    id,
    title: input.title || "Off Duty",
    location: input.location || "",
    whenText: input.whenText || "",
    whenDate: normalizeWhenDate(input.whenDate),
    notes: input.notes || "",
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
  if (days) {
    shift.days = days;
    shift.slotsPerDay = slotsPerDayOf(input.slotsPerDay != null ? input.slotsPerDay : input.officersPerDay);
    shift.fillRound = 1;
    shift.assignments = {};
    if (!shift.whenDate) {
      const firstDated = days.find((d) => d.date);
      if (firstDated) shift.whenDate = firstDated.date;
    }
  }
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

function rosterSorted(data) {
  return data.roster.slice().sort((a, b) => a.order - b.order);
}

function proposalFor(data, shift, round) {
  if (!isMultiDay(shift)) return [];
  return allocateDays({
    roster: rosterSorted(data),
    interests: data.interests.filter((i) => i.shiftId === String(shift.id)),
    days: shift.days.map((d) => d.n),
    assigned: assignedMap(shift),
    mode: Number(round) >= 3 ? "extra" : "one",
    slotsPerDay: slotsPerDayOf(shift),
  });
}

function canOfferSecondRequest(shift) {
  return (Number(shift.resendCount) || 0) < unfilledResendMax();
}

function openSecondRequest(shift, now) {
  const mins = resendWindowMinutes(shift);
  shift.resendCount = (Number(shift.resendCount) || 0) + 1;
  shift.lastResendAt = now;
  shift.closesAt = now + mins * 60 * 1000;
  shift.resendWindowMinutes = mins;
  shift.resendPending = true;
  shift.status = "open";
  shift.fillRound = 2;
}

function finalizeMulti(shift) {
  shift.status = hasAnyAssignee(shift) ? "awarded" : "closed";
  shift.resendPending = false;
}

function placeAssignee(shift, day, slot) {
  const key = String(day);
  if (!shift.assignments || typeof shift.assignments !== "object") shift.assignments = {};
  if (slotsPerDayOf(shift) <= 1) {
    shift.assignments[key] = slot;
    return;
  }
  const cur = shift.assignments[key];
  const list = Array.isArray(cur) ? cur.slice() : (cur && cur.badge ? [cur] : []);
  if (!list.some((s) => String(s.badge) === String(slot.badge))) list.push(slot);
  shift.assignments[key] = list;
}

function removeAssignee(shift, day, badge) {
  if (!shift.assignments) return;
  const key = String(day);
  const cur = shift.assignments[key];
  if (Array.isArray(cur)) {
    const next = cur.filter((s) => String(s.badge) !== String(badge));
    if (next.length) shift.assignments[key] = next;
    else delete shift.assignments[key];
    return;
  }
  if (cur && String(cur.badge) === String(badge)) delete shift.assignments[key];
}

function applyRotationMoves(data, badgesInStartOrder) {
  const sorted = rosterSorted(data);
  const today = new Date();
  const md = today.getMonth() + 1 + "-" + today.getDate();
  const snapshots = [];
  badgesInStartOrder.forEach((badge) => {
    const idx = sorted.findIndex((o) => o.badge === badge);
    if (idx < 0) return;
    const priorOrder = idx;
    const priorLastAward = sorted[idx].lastAward;
    const [w] = sorted.splice(idx, 1);
    w.lastAward = md;
    sorted.push(w);
    snapshots.push({ badge: w.badge, name: w.name, priorOrder, priorLastAward });
  });
  sorted.forEach((o, i) => { o.order = i; });
  data.roster = sorted;
  return snapshots;
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
  const multi = isMultiDay(shift);
  const committed = multi && hasAnyAssignee(shift);
  if (interested || committed) {
    shift.status = "closed";
    shift.closesAt = Math.min(shift.closesAt, now);
    shift.resendPending = false;
    if (multi && Number(shift.fillRound) === 2 && !proposalFor(data, shift, 2).length && unfilledDayNumbers(shift).length) {
      shift.fillRound = 3;
    }
    write(data);
    return { action: "closed", reason: interested ? "interested" : "partial", shift: getShift(shiftId) };
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
      days: s.days || null,
      assignments: s.assignments || null,
    });
  });
  if (pending.length) write(data);
  return pending;
}

function addInterest(shiftId, badge, ranksRaw) {
  const rolled = rollInterestWindow(shiftId);
  if (rolled.error) return rolled;
  const data = read();
  const shift = data.shifts.find((s) => s.id === String(shiftId));
  if (!shift) return { error: "Shift not found", status: 404 };
  if (shift.status !== "open") return { error: "Interest window has ended", status: 400 };
  const officer = data.roster.find((o) => o.badge === String(badge));
  if (!officer) return { error: "Unknown badge", status: 400 };
  let ranks = null;
  if (isMultiDay(shift)) {
    ranks = normalizeRanks(ranksRaw).filter((n) => shift.days.some((d) => d.n === n));
    if (!ranks.length) {
      return { error: "Pick the days you want, in the order you want them", status: 400 };
    }
  }
  const already = data.interests.find(
    (i) => i.shiftId === String(shiftId) && i.badge === String(badge)
  );
  if (already && !isMultiDay(shift)) return { error: "Already marked interested", status: 409, interest: already };
  const dates = interestDates(shift, ranks || []);
  const sameWeek = sameWeekAwards(officer.badge, dates.whenDate, dates.extra, shift.id);
  if (already) {
    already.ranks = ranks;
    already.name = officer.name;
    already.at = Date.now();
    write(data);
    return { interest: already, sameWeek, updated: true };
  }
  const interest = {
    shiftId: String(shiftId),
    badge: officer.badge,
    name: officer.name,
    at: Date.now(),
  };
  if (ranks) interest.ranks = ranks;
  data.interests.push(interest);
  write(data);
  return { interest, sameWeek };
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
  if (!isMultiDay(shift)) return { shift, suggestion: computeWinner(data, shiftId) };
  const info = suggestWinner(shiftId);
  return { shift: info.shift || shift, suggestion: null, proposal: info.proposal || [], multi: true };
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
  const shift = getShift(shiftId);
  const interests = getInterests(shiftId);
  if (!isMultiDay(shift)) {
    return {
      shift,
      interests,
      suggestion: computeWinner(read(), shiftId),
    };
  }
  const pending = shift.status === "open" || shift.status === "closed";
  const round = Number(shift.fillRound) || 1;
  return {
    shift,
    interests,
    suggestion: null,
    multi: true,
    fillRound: round,
    proposal: pending ? proposalFor(read(), shift, round) : [],
    unfilled: unfilledDayNumbers(shift),
    assignments: assignedMap(shift),
  };
}

function confirmMultiDay(data, shift) {
  if (shift.status === "awarded") return { error: "Already awarded", status: 400 };
  if (shift.status === "cancelled") return { error: "Award was cancelled", status: 400 };
  const wasOpen = shift.status === "open";
  const now = Date.now();
  if (shift.status === "open") {
    shift.status = "closed";
    shift.closesAt = Math.min(shift.closesAt, now);
  }
  shift.resendPending = false;

  let round = Number(shift.fillRound) || 1;
  if (round < 1) round = 1;
  if (round > 3) round = 3;
  const interests = data.interests.filter((i) => i.shiftId === String(shift.id));
  const proposal = proposalFor(data, shift, round);

  if (!proposal.length && round === 2 && wasOpen) {
    return { error: "Nobody new for the open days yet. Close the window when you want to move on.", status: 400 };
  }
  if (!proposal.length && round === 1) {
    return { error: interests.length ? "No open day matches these requests" : "No interested officers", status: 400 };
  }
  if (!proposal.length && round === 2 && unfilledDayNumbers(shift).length) {
    shift.fillRound = 3;
    shift.status = "closed";
    write(data);
    return { shift: getShift(shift.id), awardedNow: [], advancedTo: 3, multi: true, roster: getRoster(), winner: null, award: null };
  }
  if (!proposal.length) {
    finalizeMulti(shift);
    write(data);
    return { shift: getShift(shift.id), awardedNow: [], multi: true, roster: getRoster(), winner: null, award: null };
  }

  const startOrder = rosterSorted(data).map((o) => o.badge);
  const seen = new Set();
  const winnerBadges = [];
  proposal.forEach((p) => {
    if (seen.has(p.badge)) return;
    seen.add(p.badge);
    winnerBadges.push(p.badge);
  });
  winnerBadges.sort((a, b) => startOrder.indexOf(a) - startOrder.indexOf(b));
  const snapshots = applyRotationMoves(data, winnerBadges);
  const snapByBadge = {};
  snapshots.forEach((s) => { snapByBadge[s.badge] = s; });

  if (!shift.assignments || typeof shift.assignments !== "object") shift.assignments = {};
  if (!Array.isArray(data.awards)) data.awards = [];
  if (data.nextAwardId == null) data.nextAwardId = 1;

  const byBadge = new Map();
  proposal.forEach((p) => {
    if (!byBadge.has(p.badge)) byBadge.set(p.badge, []);
    byBadge.get(p.badge).push(p.day);
  });

  const awards = [];
  winnerBadges.forEach((badge) => {
    const snap = snapByBadge[badge];
    if (!snap) return;
    const daysWon = byBadge.get(badge) || [];
    const dayDates = {};
    daysWon.forEach((d) => {
      const meta = shift.days.find((x) => x.n === d);
      dayDates[String(d)] = meta && meta.date ? meta.date : "";
    });
    const awardId = String(data.nextAwardId++);
    const award = {
      id: awardId,
      shiftId: String(shift.id),
      badge,
      name: snap.name,
      awardedAt: now,
      priorOrder: snap.priorOrder,
      priorLastAward: snap.priorLastAward,
      rotationMove: true,
      status: "active",
      cancelledAt: null,
      restored: false,
      days: daysWon.slice(),
      cancelledDays: [],
      round,
      dayDates,
    };
    data.awards.push(award);
    awards.push(award);
    daysWon.forEach((d) => {
      placeAssignee(shift, d, {
        badge,
        name: snap.name,
        awardId,
        round,
        at: now,
      });
    });
  });

  const unfilled = unfilledDayNumbers(shift);
  if (round === 1 && unfilled.length && canOfferSecondRequest(shift)) {
    openSecondRequest(shift, now);
  } else if (round === 2 && unfilled.length) {
    shift.fillRound = 3;
    shift.status = "closed";
    shift.resendPending = false;
  } else {
    finalizeMulti(shift);
  }

  write(data);
  return {
    shift: getShift(shift.id),
    winner: null,
    award: awards[0] || null,
    awards,
    awardedNow: proposal,
    multi: true,
    roster: getRoster(),
  };
}

function confirmAward(shiftId) {
  const data = read();
  const shift = data.shifts.find((s) => s.id === String(shiftId));
  if (!shift) return { error: "Shift not found", status: 404 };
  if (isMultiDay(shift)) return confirmMultiDay(data, shift);
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
    if (a.rotationMove === false) return false;
    if (a.awardedAt > award.awardedAt) return true;
    // Same ms (fast successive awards): treat higher award id as newer
    if (a.awardedAt === award.awardedAt && Number(a.id) > Number(award.id)) return true;
    return false;
  });
}

function restoreOfficer(data, award) {
  const sorted = rosterSorted(data);
  const curIdx = sorted.findIndex((o) => o.badge === award.badge);
  if (curIdx < 0) return { error: "Officer no longer on roster", status: 400 };
  const [officer] = sorted.splice(curIdx, 1);
  officer.lastAward = award.priorLastAward;
  const insertAt = Math.max(0, Math.min(Number(award.priorOrder), sorted.length));
  sorted.splice(insertAt, 0, officer);
  sorted.forEach((o, i) => { o.order = i; });
  data.roster = sorted;
  return { officer, insertAt };
}

function cancelMultiDay(data, shift, opts) {
  opts = opts || {};
  if (shift.status === "cancelled") return { error: "Award was cancelled", status: 400 };
  let day = Number(opts.day);
  const awards = data.awards || [];
  let award = null;
  if (Number.isInteger(day) && day > 0) {
    const matches = awards.filter((a) =>
      String(a.shiftId) === String(shift.id) &&
      a.status === "active" &&
      Array.isArray(a.days) &&
      a.days.some((d) => Number(d) === day) &&
      (!opts.badge || String(a.badge) === String(opts.badge))
    );
    if (!opts.badge && matches.length > 1) {
      return { error: "Say which officer to cancel", status: 400 };
    }
    award = matches[0] || null;
  } else if (opts.awardId) {
    const found = awards.find((a) => a.id === String(opts.awardId) && String(a.shiftId) === String(shift.id) && a.status === "active");
    if (found && Array.isArray(found.days) && found.days.length === 1) {
      award = found;
      day = Number(found.days[0]);
    }
  }
  const people = assigneesFor(shift, day);
  if (!award || !people.some((s) => String(s.badge) === String(award.badge))) {
    return { error: Number.isInteger(day) && day > 0 ? "That day is not awarded" : "Say which day to cancel", status: 400 };
  }

  const info = awardRestoreInfo(award);
  if (!info.canRestore) return { error: info.reason, status: 400, award };

  const willEmpty = award.days.length === 1;
  if (willEmpty && award.rotationMove !== false && hasNewerActiveAward(data, award)) {
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
  if (willEmpty && award.rotationMove !== false && award.priorOrder == null) {
    return { error: "Cannot restore — this award has no saved prior list position.", status: 400 };
  }

  award.days = award.days.filter((d) => Number(d) !== day);
  award.cancelledDays = (award.cancelledDays || []).concat([day]);
  removeAssignee(shift, day, award.badge);

  let restored = null;
  if (award.days.length === 0) {
    if (award.rotationMove !== false) {
      const back = restoreOfficer(data, award);
      if (back.error) return back;
      restored = {
        badge: back.officer.badge,
        name: back.officer.name,
        order: back.insertAt,
        lastAward: back.officer.lastAward,
      };
    }
    award.status = "cancelled";
    award.cancelledAt = Date.now();
    award.restored = !!restored;
  }

  const anyLeft = hasAnyAssignee(shift);
  if (!anyLeft && shift.status !== "open") {
    shift.status = "cancelled";
    shift.cancelledAt = Date.now();
  }

  write(data);
  return { shift: getShift(shift.id), award, restored, roster: getRoster() };
}

function cancelAward(shiftId, opts) {
  const data = read();
  const shift = data.shifts.find((s) => s.id === String(shiftId));
  if (!shift) return { error: "Shift not found", status: 404 };
  if (isMultiDay(shift)) return cancelMultiDay(data, shift, opts || {});
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
  isIsoDate,
  weekStartKey,
  sameWeekAwards,
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
  bootstrap,
};
