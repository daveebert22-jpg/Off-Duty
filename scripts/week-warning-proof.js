const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tfpd-wk-"));
process.env.DATA_DIR = tmp;
delete process.env.PUBLIC_BASE_URL;
delete process.env.RENDER_EXTERNAL_URL;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const savedEnv = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
};
function restoreTwilio() {
  Object.keys(savedEnv).forEach((k) => {
    if (savedEnv[k] == null) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
}

const db = require("../db");
const sms = require("../sms");
const views = require("../lib/views");
const { server } = require("../server");

const PORT = 3865;
const results = {};
const originalFetch = global.fetch;

function call(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const d = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const h = Object.assign({}, headers || {});
    if (d != null && !h["Content-Type"]) h["Content-Type"] = "application/x-www-form-urlencoded";
    if (d != null) h["Content-Length"] = Buffer.byteLength(d);
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (d != null) r.write(d);
    r.end();
  });
}

function award(title, whenDate, whenText, badge) {
  const shift = db.createShift({ title, whenDate, whenText, windowMinutes: 20 });
  db.addInterest(shift.id, badge);
  const done = db.confirmAward(shift.id);
  return done.shift;
}

(async () => {
  db.resetToSeed();
  results.sunday = db.weekStartKey("2026-10-25") === "2026-10-25";
  results.saturday = db.weekStartKey("2026-10-31") === "2026-10-25";
  results.thursday = db.weekStartKey("2026-10-29") === "2026-10-25";
  results.nextSunday = db.weekStartKey("2026-11-01") === "2026-11-01";
  results.badDate = db.weekStartKey("tomorrow") === "" && db.createShift({ title: "Bad", whenDate: "10/30/2026" }).whenDate === "";

  const school = award("School crossing", "2026-10-28", "8a-12p", "54");
  const plaza = award("Plaza detail", "2026-10-29", "3p-7p", "80");
  results.awardsStuck = school.status === "awarded" && plaza.status === "awarded";

  const road = db.createShift({ title: "Road detail", whenDate: "2026-10-30", whenText: "6p-10p", windowMinutes: 30 });
  const warned = db.addInterest(road.id, "54");
  results.sameWeekWarns = warned.sameWeek && warned.sameWeek.length === 1 && warned.sameWeek[0].title === "School crossing" && warned.sameWeek[0].whenDate === "2026-10-28";
  results.noOtherOfficer = warned.sameWeek.every((j) => j.title !== "Plaza detail") && !JSON.stringify(warned.sameWeek).includes("80");
  results.interestKept = db.getInterests(road.id).some((i) => i.badge === "54");
  const page = views.thanksPage(warned.interest, road.id, warned.sameWeek);
  results.pageWarns = page.indexOf("already have") >= 0 && page.indexOf("School crossing") >= 0 && page.indexOf("Withdraw interest") >= 0 && page.indexOf("Plaza") < 0;

  const other = db.addInterest(road.id, "65");
  results.otherNoWarn = other.sameWeek && other.sameWeek.length === 0 && db.getInterests(road.id).some((i) => i.badge === "65");
  const otherPage = views.thanksPage(other.interest, road.id, other.sameWeek);
  results.otherPageQuiet = otherPage.indexOf("already have") < 0 && otherPage.indexOf("You are in") >= 0;

  const next = db.createShift({ title: "Next Monday", whenDate: "2026-11-02", whenText: "9a", windowMinutes: 20 });
  const later = db.addInterest(next.id, "54");
  results.nextWeekQuiet = later.sameWeek && later.sameWeek.length === 0 && db.getInterests(next.id).some((i) => i.badge === "54");

  const undated = db.createShift({ title: "No date", whenText: "sometime", windowMinutes: 20 });
  const undatedHit = db.addInterest(undated.id, "54");
  results.noDateQuiet = undatedHit.sameWeek && undatedHit.sameWeek.length === 0;

  const quietSms = await sms.notifySameWeek(db.getShift(road.id), warned.interest, warned.sameWeek);
  results.noSmsWithoutConfig = quietSms.sent === false && quietSms.reason === "config";

  db.setOfficerPhone("54", "7325550101");
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  const seen = [];
  global.fetch = async (url, opts) => {
    const params = new URLSearchParams(opts.body);
    seen.push({ to: params.get("To"), body: params.get("Body") });
    return { ok: true, status: 201, text: async () => "{}" };
  };
  const direct = await sms.notifySameWeek(db.getShift(road.id), warned.interest, warned.sameWeek);
  results.oneDirectSms = direct.sent === true && seen.length === 1 && seen[0].to === "+17325550101" &&
    seen[0].body.indexOf("School crossing") >= 0 && seen[0].body.indexOf("Plaza") < 0;

  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const beforeHttp = seen.length;
  const evening = db.createShift({ title: "Evening post", whenDate: "2026-10-27", whenText: "4p-8p", windowMinutes: 25 });
  const httpWarn = await call("POST", "/s/" + evening.id + "/interest", "badge=54");
  const httpCalls = seen.slice(beforeHttp);
  results.httpWarns = httpWarn.status === 200 && httpWarn.body.indexOf("already have") >= 0 &&
    httpWarn.body.indexOf("School crossing") >= 0 && httpWarn.body.indexOf("Withdraw interest") >= 0 &&
    httpWarn.body.indexOf("Plaza") < 0 && httpWarn.body.indexOf("5550101") < 0;
  results.httpKept = db.getInterests(evening.id).some((i) => i.badge === "54");
  results.httpOneSms = httpCalls.length === 1 && httpCalls[0].to === "+17325550101" &&
    httpCalls[0].body.indexOf("School crossing") >= 0 && httpCalls[0].body.indexOf("Evening post") >= 0;

  const dup = await call("POST", "/s/" + evening.id + "/interest", "badge=54");
  results.noSecondSms = dup.status === 409 && seen.length === beforeHttp + 1;

  const nextHttp = await call("POST", "/s/" + next.id + "/interest", "badge=72");
  results.httpNextWeekQuiet = nextHttp.status === 200 && nextHttp.body.indexOf("already have") < 0 && nextHttp.body.indexOf("You are in") >= 0 &&
    seen.length === beforeHttp + 1 && db.getInterests(next.id).some((i) => i.badge === "72");

  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  const still = db.createShift({ title: "Still this week", whenDate: "2026-10-31", whenText: "noon", windowMinutes: 20 });
  const callsBefore = seen.length;
  const stillRes = await call("POST", "/s/" + still.id + "/interest", "badge=54");
  results.warnsWithoutTwilio = stillRes.status === 200 && stillRes.body.indexOf("already have") >= 0 &&
    stillRes.body.indexOf("School crossing") >= 0 && db.getInterests(still.id).some((i) => i.badge === "54") &&
    seen.length === callsBefore;

  const cancelled = db.cancelAward(school.id);
  const afterCancel = db.createShift({ title: "After cancel", whenDate: "2026-10-26", whenText: "7a", windowMinutes: 20 });
  const after = db.addInterest(afterCancel.id, "54");
  results.cancelClearsWarning = !cancelled.error && after.sameWeek && after.sameWeek.length === 0 &&
    db.getInterests(afterCancel.id).some((i) => i.badge === "54");

  const ok = Object.keys(results).every((k) => results[k] === true);
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = originalFetch;
  restoreTwilio();
  try { server.close(); } catch (e) { /* not listening */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode || 0), 50);
});
