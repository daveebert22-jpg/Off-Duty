const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tfpd-ar-"));
process.env.DATA_DIR = tmp;
delete process.env.PUBLIC_BASE_URL;
delete process.env.RENDER_EXTERNAL_URL;
delete process.env.SMS_UNFILLED_RESEND_MAX;
delete process.env.SMS_UNFILLED_RESEND_MINUTES;

const savedEnv = {
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
};
function clearTwilio() {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
}
function restoreTwilio() {
  Object.keys(savedEnv).forEach((k) => {
    if (savedEnv[k] == null) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
}
clearTwilio();

const util2 = require("../util2");
const db = require("../db");
const sms = require("../sms");
const { server } = require("../server");

const PORT = 3863;
const results = {};
const originalFetch = global.fetch;

function expire(id) {
  const data = JSON.parse(fs.readFileSync(db.DB_PATH, "utf8"));
  data.shifts.forEach((s) => {
    if (s.id === String(id)) s.closesAt = Date.now() - 1000;
  });
  fs.writeFileSync(db.DB_PATH, JSON.stringify(data));
}

function call(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const d = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const h = Object.assign({}, headers || {});
    if (d != null && !h["Content-Type"]) h["Content-Type"] = "application/json";
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

(async () => {
  db.resetToSeed();

  const filled = sms.messageAwarded({
    title: "Municipal detail", whenText: "Fri 6p", winnerName: "Pierson", winnerBadge: "54",
  });
  results.awardMsg = filled === "TFPD Off Duty: Municipal detail — Fri 6p filled by Pierson (badge #54).";
  const still = sms.messageStillOpen({ id: "9", title: "Municipal detail", whenText: "Fri 6p" }, "https://tfpd.example");
  results.stillMsg = still === "TFPD Off Duty: Municipal detail — Fri 6p still open. Tap to show interest: https://tfpd.example/s/9";
  results.createMsg = sms.messageFor({ id: "9", title: "Municipal detail", whenText: "Fri 6p" }, "https://tfpd.example")
    .indexOf("Tap to show interest: https://tfpd.example/s/9") >= 0;

  const openJob = db.createShift({ title: "Open job", whenText: "Sat", windowMinutes: 15 });
  expire(openJob.id);
  const reopened = db.rollInterestWindow(openJob.id);
  const reShift = db.getShift(openJob.id);
  const gap = reShift.closesAt - Date.now();
  results.reopened = reopened.action === "resend" && reShift.status === "open" && reShift.resendCount === 1;
  results.spacingUsesWindow = gap > 14 * 60000 && gap < 16 * 60000;
  const pendingOnce = db.takePendingResends();
  results.onePending = pendingOnce.length === 1 && pendingOnce[0].id === openJob.id;
  expire(openJob.id);
  const capped = db.rollInterestWindow(openJob.id);
  results.capped = capped.action === "closed" && capped.reason === "cap" && db.getShift(openJob.id).status === "closed";
  results.noExtraPending = db.takePendingResends().length === 0;

  const withInterest = db.createShift({ title: "Has interest", whenText: "Sat", windowMinutes: 20 });
  db.addInterest(withInterest.id, "54");
  expire(withInterest.id);
  const closedForAward = db.rollInterestWindow(withInterest.id);
  const suggested = db.suggestWinner(withInterest.id);
  results.interestCloses = closedForAward.action === "closed" && closedForAward.reason === "interested";
  results.suggestsPierson = suggested.suggestion && suggested.suggestion.badge === "54" && suggested.shift.status === "closed";
  results.noResendWhenInterested = (db.getShift(withInterest.id).resendCount || 0) === 0 && db.takePendingResends().length === 0;

  const manual = db.createShift({ title: "Manual close", windowMinutes: 20 });
  db.closeShift(manual.id);
  expire(manual.id);
  const manualRoll = db.rollInterestWindow(manual.id);
  results.manualNoResend = manualRoll.action === "none" && db.getShift(manual.id).status === "closed" && db.takePendingResends().length === 0;

  process.env.SMS_UNFILLED_RESEND_MAX = "0";
  const noResend = db.createShift({ title: "No resend", windowMinutes: 20 });
  expire(noResend.id);
  const zero = db.rollInterestWindow(noResend.id);
  results.maxZeroCloses = zero.action === "closed" && zero.reason === "cap" && db.getShift(noResend.id).status === "closed";
  delete process.env.SMS_UNFILLED_RESEND_MAX;

  process.env.SMS_UNFILLED_RESEND_MINUTES = "5";
  const custom = db.createShift({ title: "Custom gap", windowMinutes: 20 });
  expire(custom.id);
  db.rollInterestWindow(custom.id);
  const customGap = db.getShift(custom.id).closesAt - Date.now();
  results.customSpacing = db.getShift(custom.id).status === "open" && customGap > 4 * 60000 && customGap < 6 * 60000;
  delete process.env.SMS_UNFILLED_RESEND_MINUTES;
  db.takePendingResends();

  const again = db.createShift({ title: "Withdraw again", whenText: "Mon", windowMinutes: 20 });
  expire(again.id);
  db.rollInterestWindow(again.id);
  db.takePendingResends();
  db.addInterest(again.id, "72");
  const pulled = db.removeInterest(again.id, "72");
  results.withdrawDuringNewWindow = !pulled.error && db.getInterests(again.id).length === 0 && db.getShift(again.id).status === "open";

  db.setOfficerPhone("54", "7325550101");
  db.setOfficerPhone("65", "7325550102");
  const quiet = db.createShift({ title: "Award quiet", whenText: "Sun", windowMinutes: 20 });
  db.addInterest(quiet.id, "54");
  const awardedQuiet = db.confirmAward(quiet.id);
  const quietSms = await sms.notifyAwarded(awardedQuiet.shift);
  results.awardWithoutTwilio = awardedQuiet.shift && awardedQuiet.shift.status === "awarded" &&
    quietSms.configured === false && quietSms.sent === 0 && /config missing/i.test(quietSms.note) && /award was saved/i.test(quietSms.note);
  results.phoneSurvivedAward = db.getRoster().find((o) => o.badge === "54").phone === "+17325550101";
  db.recordSmsSummary(quiet.id, quietSms, "awardSms");
  results.quietStored = db.getShift(quiet.id).awardSms && /config missing/i.test(db.getShift(quiet.id).awardSms.note);

  util2.setKey("proof-code-ok");
  const cookie = "od_a=" + util2.mint();
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const seen = [];
  global.fetch = async (url, opts) => {
    const params = new URLSearchParams(opts.body);
    const to = params.get("To");
    seen.push({ to, body: params.get("Body"), url: String(url) });
    if (to === "+17325550102") return { ok: false, status: 400, text: async () => "{\"message\":\"bad\"}" };
    return { ok: true, status: 201, text: async () => "{}" };
  };
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";

  const live = db.createShift({ title: "Road job", whenText: "Tue 9a", windowMinutes: 20 });
  db.addInterest(live.id, "65");
  const awardRes = await call("POST", "/api/shifts/" + live.id + "/award", {}, { Cookie: cookie });
  const awardBody = JSON.parse(awardRes.body);
  const awardCalls = seen.filter((c) => c.body && c.body.indexOf("filled by") >= 0);
  results.awardHttp = awardRes.status === 200 && awardBody.winner && awardBody.winner.badge === "65" &&
    awardBody.awardSms && awardBody.awardSms.sent === 1 && awardBody.awardSms.failed === 1;
  results.awardStillAwarded = db.getShift(live.id).status === "awarded" && db.getRoster().slice(-1)[0].badge === "65";
  results.awardText = awardCalls.length === 2 &&
    awardCalls.every((c) => c.body.indexOf("filled by Duncan (badge #65)") >= 0 && c.body.indexOf("Road job") >= 0 && c.body.indexOf("Tue 9a") >= 0) &&
    awardCalls.some((c) => c.to === "+17325550101") && awardCalls.some((c) => c.to === "+17325550102");
  const adminAward = await call("GET", "/admin/shift/" + live.id, null, { Cookie: cookie });
  results.adminSeesAwardSms = adminAward.status === 200 && /1 sent, 1 failed/.test(adminAward.body);

  db.setOfficerPhone("54", "");
  db.setOfficerPhone("65", "");
  db.setOfficerPhone("80", "7325550180");
  const beforeResend = seen.length;
  const reopen = db.createShift({ title: "Still needed", whenText: "Wed 4p", windowMinutes: 20 });
  expire(reopen.id);
  const page = await call("GET", "/s/" + reopen.id);
  const resendCalls = seen.slice(beforeResend).filter((c) => c.body && c.body.indexOf("still open") >= 0);
  const reopenedShift = db.getShift(reopen.id);
  results.httpReopened = page.status === 200 && page.body.indexOf("Still open") >= 0 && page.body.indexOf("I am interested") >= 0;
  results.httpResendSms = reopenedShift.status === "open" && reopenedShift.resendCount === 1 &&
    reopenedShift.resendSms && reopenedShift.resendSms.sent === 1 && reopenedShift.resendSms.failed === 0;
  results.httpResendBody = resendCalls.length === 1 &&
    resendCalls[0].to === "+17325550180" &&
    resendCalls[0].body.indexOf("Still needed") >= 0 &&
    resendCalls[0].body.indexOf("Wed 4p") >= 0 &&
    resendCalls[0].body.indexOf("/s/" + reopen.id) >= 0;
  results.publicHidesPhone = page.body.indexOf("5550180") < 0;
  const tapped = await call("POST", "/s/" + reopen.id + "/interest", "badge=80", { "Content-Type": "application/x-www-form-urlencoded" });
  results.interestAfterResend = tapped.status === 200 && db.getInterests(reopen.id).some((i) => i.badge === "80");

  expire(reopen.id);
  const callsBeforeCap = seen.length;
  const closedPage = await call("GET", "/s/" + reopen.id);
  results.secondWindowCloses = db.getShift(reopen.id).status === "closed" && seen.length === callsBeforeCap;
  results.closedPageLate = /too late/i.test(closedPage.body) && closedPage.body.indexOf("/withdraw") < 0;

  clearTwilio();
  const skip = db.createShift({ title: "Skip resend", whenText: "Thu", windowMinutes: 20 });
  expire(skip.id);
  const callsBeforeSkip = seen.length;
  const skipPage = await call("GET", "/s/" + skip.id);
  const skipShift = db.getShift(skip.id);
  results.resendWithoutTwilio = skipShift.status === "open" && skipShift.resendCount === 1 &&
    skipShift.resendSms && skipShift.resendSms.configured === false && /config missing/i.test(skipShift.resendSms.note) &&
    /still open/i.test(skipShift.resendSms.note) && seen.length === callsBeforeSkip &&
    skipPage.body.indexOf("I am interested") >= 0;

  const ok = Object.keys(results).every((k) => results[k] === true);
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = originalFetch;
  restoreTwilio();
  delete process.env.SMS_UNFILLED_RESEND_MAX;
  delete process.env.SMS_UNFILLED_RESEND_MINUTES;
  try { server.close(); } catch (e) { /* not listening */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode || 0), 50);
});
