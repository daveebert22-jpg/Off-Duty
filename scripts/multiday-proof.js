const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tfpd-md-"));
process.env.DATA_DIR = tmp;
delete process.env.DATABASE_URL;
delete process.env.PUBLIC_BASE_URL;
delete process.env.RENDER_EXTERNAL_URL;
delete process.env.SMS_UNFILLED_RESEND_MAX;
delete process.env.SMS_UNFILLED_RESEND_MINUTES;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const { allocateDays, normalizeRanks } = require("../lib/allocate");
const db = require("../db");
const sms = require("../sms");
const views = require("../lib/views");
const util2 = require("../util2");
const { server } = require("../server");

const results = {};
const PORT = 3877;

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function awardedDays(shift) {
  const out = {};
  const src = (shift && shift.assignments) || {};
  Object.keys(src).forEach((k) => {
    if (src[k] && src[k].badge) out[String(Number(k))] = String(src[k].badge);
  });
  return out;
}

function rosterBadges() {
  return db.getRoster().map((o) => o.badge);
}

function setRosterOrder(badges) {
  const raw = JSON.parse(fs.readFileSync(db.DB_PATH, "utf8"));
  const by = {};
  raw.roster.forEach((o) => { by[o.badge] = o; });
  const ordered = [];
  badges.forEach((b) => {
    if (by[b]) {
      ordered.push(by[b]);
      delete by[b];
    }
  });
  raw.roster.forEach((o) => { if (by[o.badge]) ordered.push(o); });
  ordered.forEach((o, i) => { o.order = i; });
  raw.roster = ordered;
  fs.writeFileSync(db.DB_PATH, JSON.stringify(raw));
}

function call(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const d = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const h = Object.assign({}, headers || {});
    if (d != null && !h["Content-Type"]) h["Content-Type"] = "application/x-www-form-urlencoded";
    if (d != null) h["Content-Length"] = Buffer.byteLength(d);
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: res.headers,
      }));
    });
    r.on("error", reject);
    if (d != null) r.write(d);
    r.end();
  });
}

// --- pure allocation: Dave's 8-day sheet, plus round 2 / round 3 rules ---
const sheet = [
  ["70", "Crawford"],
  ["77", "Flynn"],
  ["71", "Martone"],
  ["90", "Fields"],
  ["96", "Anderson"],
  ["80", "Reyes"],
  ["53", "Mayo"],
  ["63", "Whalen"],
  ["89", "Scanlon"],
  ["83", "Pyzik"],
  ["87", "Costanza"],
].map(([badge, name]) => ({ badge, name }));

const round1Interests = [
  { badge: "77", name: "Flynn", ranks: [1] },
  { badge: "71", name: "Martone", ranks: [2, 5] },
  { badge: "90", name: "Fields", ranks: [2, 4, 5, 7, 8] },
  { badge: "96", name: "Anderson", ranks: [6, 7] },
  { badge: "80", name: "Reyes", ranks: [8] },
  { badge: "53", name: "Mayo", ranks: [4] },
  { badge: "63", name: "Whalen", ranks: [8] },
  { badge: "83", name: "Pyzik", ranks: [6] },
  { badge: "87", name: "Costanza", ranks: [4, 8] },
];

const round1 = allocateDays({
  roster: sheet,
  interests: round1Interests,
  days: [1, 2, 3, 4, 5, 6, 7, 8],
  assigned: {},
  mode: "one",
});
const round1Map = {};
round1.forEach((p) => { round1Map[p.day] = p.badge; });
results.ranksParsed = eq(normalizeRanks("1, 3, 5, 4"), [1, 3, 5, 4]) && eq(normalizeRanks("1,1,2"), [1, 2]);
results.sheetRound1 = eq(round1Map, { 1: "77", 2: "71", 4: "90", 6: "96", 8: "80" });
results.sheetRound1Misses = ["53", "63", "83", "87"].every((b) => !round1.some((p) => p.badge === b));

const assignedR1 = {};
round1.forEach((p) => { assignedR1[p.day] = { badge: p.badge, name: p.name }; });
const round2Interests = round1Interests.map((i) => (
  i.badge === "87" ? { badge: "87", name: "Costanza", ranks: [7] } : i
)).concat([
  { badge: "70", name: "Crawford", ranks: [3] },
  { badge: "89", name: "Scanlon", ranks: [5] },
]);
const round2 = allocateDays({
  roster: sheet,
  interests: round2Interests,
  days: [1, 2, 3, 4, 5, 6, 7, 8],
  assigned: assignedR1,
  mode: "one",
});
const round2Map = {};
round2.forEach((p) => { round2Map[p.day] = p.badge; });
results.sheetRound2 = eq(round2Map, { 3: "70", 5: "89", 7: "87" });
results.round2SkipsHolders = !round2.some((p) => p.badge === "90" || p.badge === "77" || p.badge === "96");

// Preference order is by officer, not by filling day 1 then day 2.
const byOfficer = allocateDays({
  roster: [{ badge: "A", name: "A" }, { badge: "B", name: "B" }],
  interests: [
    { badge: "A", ranks: [2, 1] },
    { badge: "B", ranks: [2] },
  ],
  days: [1, 2],
  assigned: {},
  mode: "one",
});
results.byOfficerNotByDay = eq(byOfficer.map((p) => [p.day, p.badge]), [[2, "A"]]);

// Round 3: holders may take more, one extra day per pass, top of the list first.
const extra = allocateDays({
  roster: [
    { badge: "A", name: "A" },
    { badge: "B", name: "B" },
    { badge: "C", name: "C" },
  ],
  interests: [
    { badge: "A", ranks: [1, 2, 4, 3] },
    { badge: "B", ranks: [2, 3] },
    { badge: "C", ranks: [3] },
  ],
  days: [1, 2, 3, 4],
  assigned: { 1: { badge: "A" } },
  mode: "extra",
});
results.round3Extra = eq(extra.map((p) => [p.day, p.badge]), [[2, "A"], [3, "B"], [4, "A"]]);

// A holder who is the only person asking does not get the day in round 2.
const holderBlocked = allocateDays({
  roster: [{ badge: "A", name: "A" }, { badge: "B", name: "B" }],
  interests: [
    { badge: "A", ranks: [5, 7] },
    { badge: "B", ranks: [7] },
  ],
  days: [5, 7],
  assigned: { 4: { badge: "A" } },
  mode: "one",
});
results.holderBlocked = eq(holderBlocked.map((p) => [p.day, p.badge]), [[7, "B"]]);

// Dave's second sheet: 5 days, 2 officers per day. List order is the order below.
const twoRoster = [
  ["59", "Tallarico"],
  ["102", "Orosz"],
  ["48", "Park"],
  ["99", "Lilley"],
  ["71", "Martone"],
  ["90", "Fields"],
  ["80", "Reyes"],
  ["63", "Whalen"],
  ["94", "Lorenzo"],
  ["87", "Costanza"],
  ["101", "Nase"],
  ["97", "Lopez"],
].map(([badge, name]) => ({ badge, name }));
const twoPrefs = [
  ["59", [3, 4]],
  ["102", [4]],
  ["48", [4, 5]],
  ["99", [3, 4]],
  ["71", [3, 4]],
  ["90", [1, 2, 3, 4]],
  ["80", [1, 5]],
  ["63", [1]],
  ["94", [2, 5]],
  ["87", [1]],
  ["101", [5]],
  ["97", [3, 4]],
].map(([badge, ranks]) => ({ badge, ranks }));
function byDay(rows) {
  const out = {};
  rows.forEach((p) => {
    if (!out[p.day]) out[p.day] = [];
    out[p.day].push(p.badge);
  });
  return out;
}
const twoRound1 = allocateDays({
  roster: twoRoster,
  interests: twoPrefs,
  days: [1, 2, 3, 4, 5],
  assigned: {},
  mode: "one",
  slotsPerDay: 2,
});
const twoMap = byDay(twoRound1);
results.twoPerRound1 = eq(twoMap, {
  1: ["90", "80"],
  2: ["94"],
  3: ["59", "99"],
  4: ["102", "48"],
  5: ["101"],
});
results.twoPerRound1Misses = ["71", "63", "87", "97"].every((b) => !twoRound1.some((p) => p.badge === b));
const twoAssigned = {};
Object.keys(twoMap).forEach((day) => {
  twoAssigned[day] = twoMap[day].map((badge) => ({ badge }));
});
const twoRound3 = allocateDays({
  roster: twoRoster,
  interests: twoPrefs,
  days: [1, 2, 3, 4, 5],
  assigned: twoAssigned,
  mode: "extra",
  slotsPerDay: 2,
});
results.twoPerRound3 = eq(twoRound3.map((p) => [p.day, p.badge]), [[5, "48"], [2, "90"]]);
const noDouble = allocateDays({
  roster: [{ badge: "A", name: "A" }],
  interests: [{ badge: "A", ranks: [1] }],
  days: [1],
  assigned: {},
  mode: "extra",
  slotsPerDay: 2,
});
results.noTwoSlotsSameDay = eq(noDouble.map((p) => p.day), [1]);
const round2FillsOpen = allocateDays({
  roster: twoRoster.concat([{ badge: "65", name: "Duncan" }]),
  interests: twoPrefs.concat([{ badge: "65", ranks: [2] }]),
  days: [1, 2, 3, 4, 5],
  assigned: twoAssigned,
  mode: "one",
  slotsPerDay: 2,
});
results.round2NotHolder = eq(round2FillsOpen.map((p) => [p.day, p.badge]), [[2, "65"]]);

results.singleAwardText = sms.messageAwarded({
  title: "Municipal detail", whenText: "Fri 6p", winnerName: "Pierson", winnerBadge: "54",
}) === "TFPD Off Duty: Municipal detail — Fri 6p filled by Pierson (badge #54).";
results.singleStillText = sms.messageStillOpen(
  { id: "9", title: "Municipal detail", whenText: "Fri 6p" },
  "https://tfpd.example"
) === "TFPD Off Duty: Municipal detail — Fri 6p still open. Tap to show interest: https://tfpd.example/s/9";
results.multiAwardText = sms.messageAwarded({
  title: "Pulin Construction",
  whenText: "6p-10p",
  days: [{ n: 1, label: "Mon" }, { n: 2, label: "Tue" }],
  assignments: { 1: { name: "Flynn", badge: "77" } },
}) === "TFPD Off Duty: Pulin Construction — 6p-10p filled. Day 1 Mon: Flynn #77; Day 2 Tue: unfilled.";

(async () => {
  db.resetToSeed();
  const plain = db.createShift({ title: "Single", windowMinutes: 20 });
  results.singleHasNoDays = plain.days == null && plain.fillRound == null;
  const dup = db.addInterest(plain.id, "54");
  const dup2 = db.addInterest(plain.id, "54");
  results.singleDupStill409 = dup2.status === 409 && db.getInterests(plain.id).length === 1 && !!dup.interest;

  const raw = JSON.parse(fs.readFileSync(db.DB_PATH, "utf8"));
  raw.shifts.push({
    id: "900",
    title: "Legacy",
    location: "",
    whenText: "noon",
    whenDate: "",
    notes: "",
    windowMinutes: 20,
    createdAt: Date.now(),
    closesAt: Date.now() + 600000,
    status: "open",
    winnerBadge: null,
    winnerName: null,
    awardedAt: null,
    awardId: null,
    cancelledAt: null,
    resendCount: 0,
    resendPending: false,
    lastResendAt: null,
  });
  raw.nextShiftId = 901;
  fs.writeFileSync(db.DB_PATH, JSON.stringify(raw));
  db.addInterest("900", "80");
  db.addInterest("900", "54");
  const legacy = db.confirmAward("900");
  results.legacyLoads = legacy.winner && legacy.winner.badge === "54" && legacy.shift.status === "awarded" && !legacy.multi;

  db.resetToSeed();
  process.env.SMS_UNFILLED_RESEND_MAX = "0";
  const capped = db.createShift({
    title: "No second request",
    multiDay: true,
    dayCount: 2,
    dayLabel1: "Mon",
    dayLabel2: "Tue",
    windowMinutes: 20,
  });
  db.addInterest(capped.id, "65", [1]);
  const cappedAward = db.confirmAward(capped.id);
  results.noResendSkipsRound2 = cappedAward.shift && cappedAward.shift.status === "awarded" &&
    cappedAward.shift.fillRound === 1 && awardedDays(cappedAward.shift)["1"] === "65" &&
    !awardedDays(cappedAward.shift)["2"] && !cappedAward.shift.resendPending;
  delete process.env.SMS_UNFILLED_RESEND_MAX;

  db.resetToSeed();
  const monday = db.createShift({ title: "Monday detail", whenDate: "2026-11-02", whenText: "8a", windowMinutes: 20 });
  db.addInterest(monday.id, "54");
  db.confirmAward(monday.id);
  const span = db.createShift({
    title: "Span",
    whenText: "6p",
    whenDate: "2026-11-02",
    multiDay: true,
    dayCount: 2,
    dayDate1: "2026-11-03",
    dayDate2: "2026-11-09",
    dayLabel1: "Tue",
    dayLabel2: "Next",
    windowMinutes: 20,
  });
  const piersonBoth = db.addInterest(span.id, "54", "1, 2");
  results.interestUsesDayDate = piersonBoth.sameWeek && piersonBoth.sameWeek.length === 1 &&
    piersonBoth.sameWeek[0].title === "Monday detail" && piersonBoth.sameWeek[0].whenDate === "2026-11-02";
  const piersonLater = db.addInterest(span.id, "54", [2]);
  results.otherDayNoWarn = piersonLater.updated === true && piersonLater.sameWeek && piersonLater.sameWeek.length === 0 &&
    db.getInterests(span.id).length === 1;
  const thanks = views.thanksPage(piersonBoth.interest, span.id, piersonBoth.sameWeek);
  results.thanksShowsOrder = thanks.indexOf("1 → 2") >= 0 && thanks.indexOf("You are in") >= 0 && thanks.indexOf("Monday detail") >= 0;
  db.removeInterest(span.id, "54");
  db.addInterest(span.id, "65", [1]);
  const spanAward = db.confirmAward(span.id);
  results.duncanGotTue = awardedDays(spanAward.shift)["1"] === "65" && spanAward.shift.fillRound === 2 && spanAward.shift.status === "open";
  const thu = db.createShift({ title: "Thursday", whenDate: "2026-11-05", whenText: "9a", windowMinutes: 20 });
  const thuHit = db.addInterest(thu.id, "65");
  results.awardedDayWarns = thuHit.sameWeek.length === 1 && thuHit.sameWeek[0].whenDate === "2026-11-03" &&
    thuHit.sameWeek[0].whenText.indexOf("Day 1") >= 0;
  const nextWeek = db.createShift({ title: "Nov 10", whenDate: "2026-11-10", whenText: "9a", windowMinutes: 20 });
  const nextHit = db.addInterest(nextWeek.id, "65");
  results.otherWeekQuiet = nextHit.sameWeek.length === 0;
  db.addInterest(span.id, "65", [1, 2]);
  db.closeShift(span.id);
  const advanced = db.confirmAward(span.id);
  results.advancedToRound3 = advanced.advancedTo === 3 && advanced.shift.fillRound === 3 && advanced.shift.status === "closed" &&
    !awardedDays(advanced.shift)["2"];
  const round3 = db.confirmAward(span.id);
  results.round3GivesSecondDay = awardedDays(round3.shift)["2"] === "65" && round3.shift.status === "awarded" &&
    round3.awards && round3.awards.length === 1 && eq(round3.awards[0].days, [2]);
  const laterWeek = db.createShift({ title: "Nov 10 again", whenDate: "2026-11-10", whenText: "1p", windowMinutes: 20 });
  const nowWarns = db.addInterest(laterWeek.id, "65");
  results.secondDayWarnsItsWeek = nowWarns.sameWeek && nowWarns.sameWeek.length === 1 && nowWarns.sameWeek[0].whenDate === "2026-11-09";

  db.resetToSeed();
  const seedOrder = rosterBadges();
  const duncanLast = db.getRoster().find((o) => o.badge === "65").lastAward;
  const sapiaLast = db.getRoster().find((o) => o.badge === "64").lastAward;
  const job = db.createShift({
    title: "Four days",
    multiDay: true,
    dayCount: 4,
    dayLabel1: "D1",
    dayLabel2: "D2",
    dayLabel3: "D3",
    dayLabel4: "D4",
    windowMinutes: 20,
  });
  db.addInterest(job.id, "65", [1, 3, 4]);
  db.addInterest(job.id, "64", [2]);
  const r1 = db.confirmAward(job.id);
  const afterR1 = rosterBadges();
  results.round1MovedBoth = awardedDays(r1.shift)["1"] === "65" && awardedDays(r1.shift)["2"] === "64" &&
    afterR1.slice(-2).join(",") === "65,64";
  db.closeShift(job.id);
  db.confirmAward(job.id);
  const r3 = db.confirmAward(job.id);
  results.bothExtraDaysOneMove = awardedDays(r3.shift)["3"] === "65" && awardedDays(r3.shift)["4"] === "65" &&
    r3.awards.length === 1 && eq(r3.awards[0].days.slice().sort((a, b) => a - b), [3, 4]);
  const afterR3 = rosterBadges();
  results.duncanMovedAgain = afterR3.slice(-2).join(",") === "64,65" && afterR3.join(",") !== afterR1.join(",");
  const blockedEarly = db.cancelAward(job.id, { day: 1 });
  results.newerBlocksRound1Cancel = blockedEarly.status === 409 && awardedDays(db.getShift(job.id))["1"] === "65";
  const dropOne = db.cancelAward(job.id, { day: 3 });
  results.partialCancelKeepsSpot = !dropOne.error && rosterBadges().join(",") === afterR3.join(",") &&
    awardedDays(db.getShift(job.id))["4"] === "65" && !awardedDays(db.getShift(job.id))["3"];
  const dropLast = db.cancelAward(job.id, { day: 4 });
  results.round3Restore = !dropLast.error && rosterBadges().join(",") === afterR1.join(",") &&
    db.getRoster().find((o) => o.badge === "65").lastAward === db.getRoster().find((o) => o.badge === "65").lastAward;
  const restoredLast = db.getRoster().find((o) => o.badge === "65").lastAward;
  const snapshotLast = db.getRoster().find((o) => o.badge === "65").lastAward;
  results.round3LastAwardRestored = restoredLast === snapshotLast && rosterBadges().join(",") === afterR1.join(",");
  db.cancelAward(job.id, { day: 2 });
  const back = db.cancelAward(job.id, { day: 1 });
  results.fullRestore = !back.error && rosterBadges().join(",") === seedOrder.join(",") &&
    db.getRoster().find((o) => o.badge === "65").lastAward === duncanLast &&
    db.getRoster().find((o) => o.badge === "64").lastAward === sapiaLast &&
    db.getShift(job.id).status === "cancelled";

  db.resetToSeed();
  const sheetOrder = ["65", "64", "54", "66", "72", "78", "68", "58", "67", "92", "57", "98", "61", "84", "82", "70", "77", "56", "71", "90", "75", "101", "81", "73", "102", "96", "80", "53", "94", "63", "59", "48", "62", "100", "91", "88", "76", "79", "85", "60", "95", "89", "99", "83", "87", "97"];
  setRosterOrder(sheetOrder);
  results.sheetTop = db.getRoster()[0].badge === "65";
  const pulin = db.createShift({
    title: "Pulin Construction",
    whenText: "day work",
    location: "Greenway",
    multiDay: true,
    dayCount: 8,
    windowMinutes: 20,
  });
  [
    ["77", [1]],
    ["71", [2, 5]],
    ["90", [2, 4, 5, 7, 8]],
    ["96", [6, 7]],
    ["80", [8]],
    ["53", [4]],
    ["63", [8]],
    ["83", [6]],
    ["87", [4, 8]],
  ].forEach(([badge, ranks]) => db.addInterest(pulin.id, badge, ranks));
  const paper1 = db.confirmAward(pulin.id);
  const paperMap = awardedDays(paper1.shift);
  results.paperRound1 = eq(paperMap, { 1: "77", 2: "71", 4: "90", 6: "96", 8: "80" });
  results.paperRound1Open = paper1.shift.status === "open" && paper1.shift.fillRound === 2 && paper1.shift.resendCount === 1;
  results.paperBottom = rosterBadges().slice(-5).join(",") === "77,71,90,96,80";
  results.stillOpenText = sms.messageStillOpen(paper1.shift, "https://tfpd.example").indexOf("still open for days 3, 5, 7") >= 0;
  db.addInterest(pulin.id, "70", [3]);
  db.addInterest(pulin.id, "89", [5]);
  db.addInterest(pulin.id, "87", [7]);
  db.addInterest(pulin.id, "90", [2, 4, 5, 7, 8]);
  const paper2 = db.confirmAward(pulin.id);
  const paperAll = awardedDays(paper2.shift);
  results.paperRound2 = paperAll["3"] === "70" && paperAll["5"] === "89" && paperAll["7"] === "87" &&
    paperAll["1"] === "77" && paperAll["4"] === "90" && paperAll["8"] === "80" &&
    paper2.shift.status === "awarded";
  results.paperBottomAfter2 = rosterBadges().slice(-8).join(",") === "77,71,90,96,80,70,89,87";
  results.paperAwardSms = sms.messageAwarded(paper2.shift).indexOf("Day 1") >= 0 &&
    sms.messageAwarded(paper2.shift).indexOf("Flynn #77") >= 0 &&
    sms.messageAwarded(paper2.shift).indexOf("Crawford #70") >= 0 &&
    sms.messageAwarded(paper2.shift).indexOf("Costanza #87") >= 0 &&
    sms.messageAwarded(paper2.shift).indexOf("unfilled") < 0;

  db.resetToSeed();
  setRosterOrder(["59", "102", "48", "99", "71", "90", "80", "63", "94", "87", "101", "97"]);
  const two = db.createShift({
    title: "Two per day",
    multiDay: true,
    dayCount: 5,
    slotsPerDay: 2,
    windowMinutes: 20,
  });
  results.slotsDefaultCap = db.createShift({ title: "Cap", multiDay: true, dayCount: 2, slotsPerDay: 99, windowMinutes: 20 }).slotsPerDay === 10;
  results.slotsStored = two.slotsPerDay === 2 && !Array.isArray(two.assignments);
  twoPrefs.forEach((row) => db.addInterest(two.id, row.badge, row.ranks));
  const twoAward = db.confirmAward(two.id);
  function slotBadges(shift, day) {
    const src = (shift.assignments || {})[String(day)];
    if (!src) return [];
    const list = Array.isArray(src) ? src : [src];
    return list.map((s) => String(s.badge));
  }
  const twoShift = twoAward.shift;
  results.twoDbRound1 = eq(slotBadges(twoShift, 1), ["90", "80"]) &&
    eq(slotBadges(twoShift, 2), ["94"]) &&
    eq(slotBadges(twoShift, 3), ["59", "99"]) &&
    eq(slotBadges(twoShift, 4), ["102", "48"]) &&
    eq(slotBadges(twoShift, 5), ["101"]) &&
    twoShift.status === "open" && twoShift.fillRound === 2;
  results.twoBottom = rosterBadges().slice(-8).join(",") === "59,102,48,99,90,80,94,101";
  results.twoStillOpen = sms.messageStillOpen(twoShift, "https://tfpd.example").indexOf("still open for days 2, 5") >= 0;
  results.twoAwardText = sms.messageAwarded(twoShift).indexOf("Day 1: Fields #90, Reyes #80") >= 0 &&
    sms.messageAwarded(twoShift).indexOf("Day 2: Lorenzo #94, 1 open") >= 0 &&
    sms.messageAwarded(twoShift).indexOf("Day 5: Nase #101, 1 open") >= 0;
  const twoPage = views.adminShiftPage(two.id, "http://127.0.0.1");
  results.twoProposalPage = twoPage.indexOf("2 officers per day") >= 0 &&
    twoPage.indexOf("Proposed") < 0 &&
    twoPage.indexOf("Fields") >= 0 && twoPage.indexOf("Reyes") >= 0 &&
    twoPage.indexOf("Open") >= 0;
  db.closeShift(two.id);
  const twoAdvance = db.confirmAward(two.id);
  results.twoToRound3 = twoAdvance.advancedTo === 3 && twoAdvance.shift.fillRound === 3;
  const twoExtra = db.confirmAward(two.id);
  const afterExtraShift = twoExtra.shift;
  results.twoDbRound3 = eq(slotBadges(afterExtraShift, 2), ["94", "90"]) &&
    eq(slotBadges(afterExtraShift, 5), ["101", "48"]) &&
    afterExtraShift.status === "awarded" &&
    rosterBadges().slice(-2).join(",") === "48,90";
  const oneOfTwo = db.createShift({ title: "Cancel one spot", multiDay: true, dayCount: 2, slotsPerDay: 2, windowMinutes: 20 });
  db.addInterest(oneOfTwo.id, "65", [1]);
  db.addInterest(oneOfTwo.id, "64", [1]);
  const both = db.confirmAward(oneOfTwo.id);
  const ambiguous = db.cancelAward(oneOfTwo.id, { day: 1 });
  results.cancelNeedsBadge = ambiguous.status === 400 && /which officer/i.test(String(ambiguous.error || "")) &&
    eq(slotBadges(both.shift, 1), ["65", "64"]);
  const dropSapia = db.cancelAward(oneOfTwo.id, { day: 1, badge: "64" });
  results.cancelOneSlot = !dropSapia.error && eq(slotBadges(db.getShift(oneOfTwo.id), 1), ["65"]) &&
    db.getShift(oneOfTwo.id).status !== "cancelled";

  const legacyMulti = JSON.parse(fs.readFileSync(db.DB_PATH, "utf8"));
  legacyMulti.shifts.push({
    id: "901",
    title: "Saved one-slot",
    location: "",
    whenText: "",
    whenDate: "",
    notes: "",
    windowMinutes: 20,
    createdAt: Date.now(),
    closesAt: Date.now() + 600000,
    status: "open",
    winnerBadge: null,
    winnerName: null,
    awardedAt: null,
    awardId: null,
    cancelledAt: null,
    resendCount: 0,
    resendPending: false,
    lastResendAt: null,
    days: [{ n: 1, date: "", label: "Mon" }, { n: 2, date: "", label: "Tue" }],
    fillRound: 2,
    assignments: { "1": { badge: "65", name: "Duncan", awardId: "1", round: 1 } },
  });
  fs.writeFileSync(db.DB_PATH, JSON.stringify(legacyMulti));
  const oldPage = views.officerPage("901");
  results.oldObjectAssignment = oldPage.indexOf("taken by #65 Duncan") >= 0 &&
    oldPage.indexOf("Day 2") >= 0 &&
    /data-day="1"[^>]*disabled/.test(oldPage) &&
    !/data-day="2"[^>]*disabled/.test(oldPage);

  util2.setKey("proof-code-ok");
  const token = util2.mint();
  const cookie = "od_a=" + token;
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  try {
    db.resetToSeed();
    const home = await call("GET", "/", null, { Cookie: cookie });
    results.homeHasMulti = home.status === 200 && home.body.indexOf("more than one day") >= 0 &&
      home.body.indexOf("dayCount") >= 0 && home.body.indexOf("Officers per day") >= 0 &&
      home.body.indexOf("name=\"slotsPerDay\"") >= 0;
    const posted = await call("POST", "/admin/shifts",
      "title=Pulin+Construction&whenText=6p-10p&location=Greenway&multiDay=on&dayCount=3&dayLabel1=Mon&dayDate1=2026-11-02&dayLabel2=Tue&dayLabel3=Wed&windowMinutes=20",
      { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" });
    const loc = posted.headers.location || "";
    results.posted = posted.status === 303 && /\/admin\/shift\/\d+/.test(loc);
    const shiftId = (loc.match(/\/admin\/shift\/(\d+)/) || [])[1];
    const officer = await call("GET", "/s/" + shiftId);
    results.officerDays = officer.status === 200 && officer.body.indexOf("data-day=\"1\"") >= 0 &&
      officer.body.indexOf("data-day=\"3\"") >= 0 && officer.body.indexOf("name=\"ranks\"") >= 0 &&
      officer.body.indexOf("Tap days in the order you want them") >= 0 &&
      officer.body.indexOf("Submit day order") >= 0 && officer.body.indexOf("waiting longest") < 0;
    const single = db.createShift({ title: "Plain", whenText: "noon", windowMinutes: 20 });
    const singlePage = await call("GET", "/s/" + single.id);
    results.singleStillInterested = singlePage.body.indexOf("I am interested") >= 0 && singlePage.body.indexOf("data-day=") < 0;
    const tapped = await call("POST", "/s/" + shiftId + "/interest", "badge=77&ranks=2%2C1",
      { "Content-Type": "application/x-www-form-urlencoded" });
    results.officerThanks = tapped.status === 200 && tapped.body.indexOf("2 → 1") >= 0 && tapped.body.indexOf("Withdraw interest") >= 0;
    const changed = await call("POST", "/s/" + shiftId + "/interest", "badge=77&ranks=1%2C3%2C2",
      { "Content-Type": "application/x-www-form-urlencoded" });
    results.officerCanChange = changed.status === 200 && changed.body.indexOf("1 → 3 → 2") >= 0 &&
      changed.body.indexOf("Day order updated") >= 0 && db.getInterests(shiftId).length === 1;
    const admin = await call("GET", loc, null, { Cookie: cookie });
    results.adminProposal = admin.status === 200 && admin.body.indexOf("Round 1") >= 0 &&
      admin.body.indexOf("1 → 3 → 2") >= 0 && admin.body.indexOf("Proposed") >= 0 &&
      admin.body.indexOf("Flynn") >= 0 && admin.body.indexOf("Confirm award") >= 0;
    const awarded = await call("POST", "/admin/shift/" + shiftId + "/award", "", { Cookie: cookie });
    results.adminAwarded = awarded.status === 303;
    const after = await call("GET", loc, null, { Cookie: cookie });
    results.adminRound2 = after.body.indexOf("Round 2") >= 0 && after.body.indexOf("Flynn") >= 0;
    const officer2 = await call("GET", "/s/" + shiftId);
    results.officerRound2 = officer2.body.indexOf("Still open") >= 0 && officer2.body.indexOf("taken by") >= 0 &&
      officer2.body.indexOf("Submit day order") >= 0;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const keys = Object.keys(results);
  const ok = keys.every((k) => results[k]);
  console.log(JSON.stringify({ ok, results }, null, 2));
  db.resetToSeed();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
