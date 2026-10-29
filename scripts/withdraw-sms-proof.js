const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tfpd-wd-"));
process.env.DATA_DIR = tmp;
delete process.env.PUBLIC_BASE_URL;
delete process.env.RENDER_EXTERNAL_URL;

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

const PORT = 3861;
const results = {};
const originalFetch = global.fetch;

function phoneOf(badge) {
  const o = db.getRoster().find((x) => x.badge === String(badge));
  return o ? (o.phone || "") : null;
}
function interestBadges(shiftId) {
  return db.getInterests(shiftId).map((i) => i.badge).sort();
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
  const rosterLen = db.getRoster().length;

  results.norm10 = util2.normalizePhone("(732) 555-0100") === "+17325550100";
  results.norm11 = util2.normalizePhone("1-732-555-0100") === "+17325550100";
  results.normPlus = util2.normalizePhone("+44 20 7946 0958") === "+442079460958";
  results.normEmpty = util2.normalizePhone("  ") === "" && util2.normalizePhone("nope") === "";

  const s = db.createShift({ title: "Traffic", whenText: "Fri 6p", windowMinutes: 30 });
  db.addInterest(s.id, "65");
  db.addInterest(s.id, "84");
  db.addInterest(s.id, "54");
  db.addInterest(s.id, "80");
  const withdrewTop = db.removeInterest(s.id, "65");
  const withdrewLower = db.removeInterest(s.id, "84");
  results.withdrewTop = !withdrewTop.error && withdrewTop.interest.badge === "65";
  results.withdrewLower = !withdrewLower.error && withdrewLower.interest.badge === "84";
  const left = interestBadges(s.id);
  results.removedFromList = left.indexOf("65") < 0 && left.indexOf("84") < 0 && left.indexOf("54") >= 0 && left.indexOf("80") >= 0;
  const suggestion = db.suggestWinner(s.id);
  results.suggestRemaining = suggestion.suggestion && suggestion.suggestion.badge === "54";
  results.doubleWithdraw = !!db.removeInterest(s.id, "65").error;
  const awarded = db.confirmAward(s.id);
  results.winnerIsRemaining = awarded.winner && awarded.winner.badge === "54";
  results.topStayed = db.getRoster()[0].badge === "65";
  results.lateAfterAward = /too late/i.test(String((db.removeInterest(s.id, "54").error || "")));

  const closed = db.createShift({ title: "Closed job", windowMinutes: 20 });
  db.addInterest(closed.id, "64");
  db.closeShift(closed.id);
  const lateClose = db.removeInterest(closed.id, "64");
  results.lateAfterClose = /too late/i.test(String(lateClose.error || ""));
  results.stillInterestedAfterClose = interestBadges(closed.id).indexOf("64") >= 0;

  const expired = db.createShift({ title: "Expired", windowMinutes: 20 });
  db.addInterest(expired.id, "64");
  const raw = JSON.parse(fs.readFileSync(db.DB_PATH, "utf8"));
  raw.shifts.forEach((sh) => { if (sh.id === expired.id) sh.closesAt = Date.now() - 1000; });
  fs.writeFileSync(db.DB_PATH, JSON.stringify(raw, null, 2));
  const lateExp = db.removeInterest(expired.id, "64");
  results.lateExpired = /too late/i.test(String(lateExp.error || ""));
  results.expiredNowClosed = db.getShift(expired.id).status === "closed";
  results.stillInterestedAfterExpire = interestBadges(expired.id).indexOf("64") >= 0;

  const noCfg = db.createShift({ title: "No config", whenText: "Sat", windowMinutes: 20 });
  const skipped = await sms.notifyShift(noCfg, "https://example.test");
  results.skipConfigured = skipped.configured === false && skipped.sent === 0 && skipped.failed === 0;
  results.skipNote = /config missing/i.test(skipped.note);
  results.shiftCreatedWithoutTwilio = !!db.getShift(noCfg.id);
  db.recordSmsSummary(noCfg.id, skipped);

  let fetchCalls = 0;
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  const quiet = await sms.notifyShift(noCfg, "https://example.test", {
    fetch: async () => { fetchCalls++; return { ok: true, status: 201, text: async () => "{}" }; },
  });
  results.noPhonesNoSend = quiet.configured === true && quiet.sent === 0 && quiet.failed === 0 && quiet.skipped === rosterLen && fetchCalls === 0;
  clearTwilio();

  results.badPhone = !!db.setOfficerPhone("65", "nope").error && phoneOf("65") === "";
  results.goodPhone = db.setOfficerPhone("65", "(732) 555-0101").officer.phone === "+17325550101";
  results.elevenPhone = db.setOfficerPhone("64", "1 732 555 0102").officer.phone === "+17325550102";
  results.unknownPhone = db.setOfficerPhone("9999", "7325550100").status === 404;
  const keep = db.createShift({ title: "Keep phone", windowMinutes: 20 });
  db.addInterest(keep.id, "64");
  const keptAward = db.confirmAward(keep.id);
  results.phoneSurvivesAward =
    keptAward.winner && keptAward.winner.badge === "64" &&
    phoneOf("65") === "+17325550101" &&
    phoneOf("64") === "+17325550102" &&
    db.getRoster().slice(-1)[0].badge === "64";

  util2.setKey("proof-code-ok");
  const token = util2.mint();
  const cookie = "od_a=" + token;

  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const openShift = db.createShift({ title: "Detail", whenText: "Sun 8a", location: "Main", windowMinutes: 25 });
  const pageBefore = await call("GET", "/s/" + openShift.id);
  results.noWithdrawYet = pageBefore.status === 200 && pageBefore.body.indexOf("/s/" + openShift.id + "/withdraw") < 0;
  results.publicHidesPhone = pageBefore.body.indexOf("7325550101") < 0 && pageBefore.body.indexOf("+17325550101") < 0;

  const tapped = await call("POST", "/s/" + openShift.id + "/interest", "badge=72", { "Content-Type": "application/x-www-form-urlencoded" });
  results.thanksHasWithdraw = tapped.status === 200 && tapped.body.indexOf("Withdraw interest") >= 0 && tapped.body.indexOf("/withdraw") >= 0;
  const pulled = await call("POST", "/s/" + openShift.id + "/withdraw", "badge=72", { "Content-Type": "application/x-www-form-urlencoded" });
  results.httpWithdrew = pulled.status === 200 && pulled.body.indexOf("Interest withdrawn") >= 0;
  results.httpRemoved = interestBadges(openShift.id).indexOf("72") < 0;

  await call("POST", "/api/shifts/" + openShift.id + "/interest", { badge: "54" });
  await call("POST", "/api/shifts/" + openShift.id + "/interest", { badge: "80" });
  const apiPull = await call("POST", "/api/shifts/" + openShift.id + "/withdraw", { badge: "80" });
  results.apiWithdrew = apiPull.status === 200 && interestBadges(openShift.id).indexOf("80") < 0 && interestBadges(openShift.id).indexOf("54") >= 0;
  const pageOpen = await call("GET", "/s/" + openShift.id);
  results.openShowsWithdraw = pageOpen.body.indexOf("/s/" + openShift.id + "/withdraw") >= 0 && pageOpen.body.indexOf("7325550101") < 0;

  db.confirmAward(openShift.id);
  const pageAwarded = await call("GET", "/s/" + openShift.id);
  const lateHttp = await call("POST", "/s/" + openShift.id + "/withdraw", "badge=54", { "Content-Type": "application/x-www-form-urlencoded" });
  results.awardedPageLocks = pageAwarded.body.indexOf("/withdraw") < 0 && /too late/i.test(pageAwarded.body);
  results.awardedPostLocks = lateHttp.status === 400 && /too late/i.test(lateHttp.body);
  results.awardedStillListed = interestBadges(openShift.id).indexOf("54") >= 0;

  const anon = await call("POST", "/api/shifts", { title: "Nope" });
  results.createRequiresAdmin = anon.status === 401;

  const home = await call("GET", "/", null, { Cookie: cookie });
  results.adminPhoneForm = home.status === 200 && home.body.indexOf("/admin/roster/65/phone") >= 0 && home.body.indexOf("name=\"phone\"") >= 0;
  results.adminWarnsMissingTwilio = /not configured/i.test(home.body);

  const savedPhone = await call("POST", "/admin/roster/66/phone", "phone=7325550199", {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: cookie,
  });
  results.phoneSaveRedirect = savedPhone.status === 303 && /phone=66/.test(savedPhone.headers.location || "");
  results.phoneSavedNorm = phoneOf("66") === "+17325550199";
  const homeSaved = await call("GET", "/?phone=66", null, { Cookie: cookie });
  results.phoneSaveVisible = homeSaved.body.indexOf("Saved phone") >= 0 && homeSaved.body.indexOf("+17325550199") >= 0;

  const badSave = await call("POST", "/api/roster/66/phone", { phone: "abc" }, { Cookie: cookie });
  results.apiRejectsBadPhone = badSave.status === 400 && phoneOf("66") === "+17325550199";
  const cleared = await call("POST", "/api/roster/66/phone", { phone: "" }, { Cookie: cookie });
  results.apiClearsPhone = cleared.status === 200 && phoneOf("66") === "";

  const noText = await call("POST", "/api/shifts", { title: "Skip texts", whenText: "Mon", windowMinutes: 20 }, { Cookie: cookie });
  const noTextBody = JSON.parse(noText.body);
  results.apiCreateWithoutConfig = noText.status === 201 && noTextBody.id && noTextBody.sms && noTextBody.sms.configured === false && noTextBody.sms.sent === 0 && /config missing/i.test(noTextBody.sms.note || "");
  const adminShift = await call("GET", "/admin/shift/" + noTextBody.id, null, { Cookie: cookie });
  results.adminShowsSkip = adminShift.status === 200 && /config missing/i.test(adminShift.body);

  db.setOfficerPhone("65", "7325550101");
  db.setOfficerPhone("64", "17325550102");
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
  const seen = [];
  let authOk = true;
  global.fetch = async (url, opts) => {
    const params = new URLSearchParams(opts.body);
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || "";
    if (!String(auth).startsWith("Basic ") || String(auth).length < 12) authOk = false;
    const to = params.get("To");
    seen.push({ url: String(url), to, from: params.get("From"), body: params.get("Body") });
    if (to === "+17325550102") {
      return { ok: false, status: 400, statusText: "Bad", text: async () => "{\"message\":\"invalid\"}" };
    }
    return { ok: true, status: 201, text: async () => "{}" };
  };
  const texted = await call("POST", "/api/shifts", {
    title: "Road job", whenText: "Tue 9a", windowMinutes: 20,
  }, { Cookie: cookie });
  const textedBody = JSON.parse(texted.body);
  const bodiesOk = seen.length > 0 && seen.every((c) =>
    c.body.indexOf("TFPD Off Duty:") >= 0 &&
    c.body.indexOf("Road job") >= 0 &&
    c.body.indexOf("Tue 9a") >= 0 &&
    c.body.indexOf("/s/" + textedBody.id) >= 0 &&
    c.from === "+15550001111" &&
    c.url.indexOf("/Accounts/ACtest/Messages.json") >= 0
  );
  results.textSent = texted.status === 201 && textedBody.sms && textedBody.sms.sent === 1 && textedBody.sms.failed === 1;
  results.textSkippedRest = textedBody.sms && textedBody.sms.skipped === rosterLen - 2;
  results.textTargets = seen.length === 2 && seen.some((c) => c.to === "+17325550101") && seen.some((c) => c.to === "+17325550102");
  results.textBody = bodiesOk && authOk;
  results.shiftExistsAfterPartial = !!db.getShift(textedBody.id);
  const adminText = await call("GET", "/admin/shift/" + textedBody.id, null, { Cookie: cookie });
  results.adminShowsCounts = /1 sent, 1 failed/.test(adminText.body);
  const publicTexted = await call("GET", "/s/" + textedBody.id);
  results.publicStillHidesPhone = publicTexted.body.indexOf("7325550101") < 0 && publicTexted.body.indexOf("7325550102") < 0;

  const homeOn = await call("GET", "/", null, { Cookie: cookie });
  results.adminSeesConfigured = /Twilio is configured/.test(homeOn.body);

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
