const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const db = require("./db");
const views = require("./lib/views");
const util2 = require("./util2");
const sms = require("./sms");
const persist = require("./persist");

const PORT = Number(process.env.PORT) || 3847;
const PUBLIC = path.join(__dirname, "public");

async function send(res, status, body, headers) {
  try {
    await persist.flush();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Save failed");
    }
    return;
  }
  const h = Object.assign({ "Content-Type": "text/html; charset=utf-8" }, headers || {});
  if (typeof body === "object" && body !== null && !Buffer.isBuffer(body)) {
    h["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(body);
  }
  res.writeHead(status, h);
  res.end(body);
}

async function redirect(res, location, extra) {
  try {
    await persist.flush();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Save failed");
    }
    return;
  }
  res.writeHead(303, Object.assign({ Location: location }, extra || {}));
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
      } else if (ct.includes("application/x-www-form-urlencoded")) {
        const out = {};
        new URLSearchParams(raw).forEach((v, k) => { out[k] = v; });
        resolve(out);
      } else resolve({ raw });
    });
    req.on("error", reject);
  });
}

function baseUrl(req) {
  const env = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").trim().replace(/\/$/, "");
  if (env) return env;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || ("localhost:" + PORT)).split(",")[0].trim();
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return proto + "://" + host;
}

function fallbackBase() {
  const env = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").trim().replace(/\/$/, "");
  if (env) return env;
  return "http://localhost:" + PORT;
}

async function announceShift(shift, req) {
  let summary;
  try {
    summary = await sms.notifyShift(shift, baseUrl(req));
  } catch (err) {
    console.error("SMS notify failed", err && err.message);
    summary = {
      configured: sms.twilioConfigured(),
      sent: 0,
      failed: 0,
      skipped: 0,
      note: "Texts were not sent (unexpected error). The shift was still created.",
      failures: [],
    };
  }
  try {
    db.recordSmsSummary(shift.id, summary, "sms");
  } catch (err) {
    console.error("SMS summary save failed", err && err.message);
  }
  console.log("SMS shift " + shift.id + ": " + summary.note);
  return summary;
}

async function announceAward(shift) {
  let summary;
  try {
    summary = await sms.notifyAwarded(shift);
  } catch (err) {
    console.error("SMS award failed", err && err.message);
    summary = {
      configured: sms.twilioConfigured(),
      sent: 0,
      failed: 0,
      skipped: 0,
      note: "Texts were not sent (unexpected error). The award was saved.",
      failures: [],
    };
  }
  try {
    db.recordSmsSummary(shift.id, summary, "awardSms");
  } catch (err) {
    console.error("SMS award summary save failed", err && err.message);
  }
  console.log("SMS award shift " + shift.id + ": " + summary.note);
  return summary;
}

async function flushResendTexts(reqOrBase) {
  const base = typeof reqOrBase === "string" ? reqOrBase : (reqOrBase ? baseUrl(reqOrBase) : fallbackBase());
  const pending = db.takePendingResends();
  for (const shift of pending) {
    let summary;
    try {
      summary = await sms.notifyStillOpen(shift, base);
    } catch (err) {
      console.error("SMS resend failed", err && err.message);
      summary = {
        configured: sms.twilioConfigured(),
        sent: 0,
        failed: 0,
        skipped: 0,
        note: "Texts were not sent (unexpected error). The shift is still open.",
        failures: [],
      };
    }
    try {
      db.recordSmsSummary(shift.id, summary, "resendSms");
    } catch (err) {
      console.error("SMS resend summary save failed", err && err.message);
    }
    console.log("SMS resend shift " + shift.id + ": " + summary.note);
  }
  return pending.length;
}

async function prepareShift(shiftId, req) {
  if (shiftId) db.rollInterestWindow(shiftId);
  await flushResendTexts(req);
}

async function maybeWeekWarningSms(shiftId, interest, sameWeek) {
  if (!interest || !sameWeek || !sameWeek.length) return { sent: false, reason: "none" };
  try {
    const result = await sms.notifySameWeek(db.getShift(shiftId), interest, sameWeek);
    if (result && result.sent) console.log("SMS same-week shift " + shiftId + " badge " + interest.badge);
    return result || { sent: false };
  } catch (err) {
    console.error("same-week SMS", err && err.message);
    return { sent: false, reason: "error" };
  }
}

function interestRanks(body) {
  if (!body) return undefined;
  if (Array.isArray(body.ranks)) return body.ranks;
  if (body.ranks != null && String(body.ranks).trim() !== "") return body.ranks;
  if (Array.isArray(body.days)) return body.days;
  if (body.days != null && String(body.days).trim() !== "") return body.days;
  return undefined;
}

function wantsJson(req) {
  const accept = req.headers.accept || "";
  const ct = req.headers["content-type"] || "";
  return accept.includes("application/json") || ct.includes("application/json") || (req.url || "").startsWith("/api/");
}

function requireAdmin(req, res) {
  if (util2.isAuthed(req)) return true;
  if (!util2.hasKey()) {
    if (wantsJson(req) || (req.url || "").startsWith("/api/")) {
      send(res, 401, { error: "Admin setup required" });
      return false;
    }
    res.writeHead(303, { Location: "/setup" });
    res.end();
    return false;
  }
  if (wantsJson(req) || (req.url || "").startsWith("/api/")) {
    send(res, 401, { error: "Admin login required" });
    return false;
  }
  const next = encodeURIComponent((req.url || "/").split("?")[0] || "/");
  res.writeHead(303, { Location: "/login?next=" + next });
  res.end();
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    const p = url.pathname;

    if (req.method === "GET" && p === "/styles.css") {
      const f = path.join(PUBLIC, "styles.css");
      if (!fs.existsSync(f)) return send(res, 404, "missing");
      return send(res, 200, fs.readFileSync(f), { "Content-Type": "text/css; charset=utf-8" });
    }

    if (req.method === "GET" && p === "/api/health") return send(res, 200, { ok: true });

    // Setup (first run only)
    if (req.method === "GET" && p === "/setup") {
      if (util2.hasKey()) {
        return redirect(res, "/login");
      }
      return send(res, 200, views.loginPage({ setup: true }));
    }
    if (req.method === "POST" && p === "/setup") {
      if (util2.hasKey()) {
        return redirect(res, "/login");
      }
      const body = await readBody(req);
      if (String(body.code || "") !== String(body.code2 || "")) {
        return send(res, 400, views.loginPage({ setup: true, error: "Codes do not match" }));
      }
      const r = util2.setKey(body.code);
      if (r.error) return send(res, 400, views.loginPage({ setup: true, error: r.error }));
      const id = util2.mint();
      return redirect(res, "/", { "Set-Cookie": util2.cookieHeader(id) });
    }

    // Login / logout
    if (req.method === "GET" && p === "/login") {
      if (!util2.hasKey()) {
        return redirect(res, "/setup");
      }
      if (util2.isAuthed(req)) {
        return redirect(res, url.searchParams.get("next") || "/");
      }
      return send(res, 200, views.loginPage({ next: url.searchParams.get("next") || "/" }));
    }
    if (req.method === "POST" && p === "/login") {
      if (!util2.hasKey()) {
        return redirect(res, "/setup");
      }
      const body = await readBody(req);
      const next = body.next || url.searchParams.get("next") || "/";
      const safe = String(next).startsWith("/") && !String(next).startsWith("//") ? next : "/";
      if (!util2.checkKey(body.code)) {
        return send(res, 401, views.loginPage({ error: "Incorrect code", next: safe }));
      }
      const id = util2.mint();
      return redirect(res, safe, { "Set-Cookie": util2.cookieHeader(id) });
    }
    if (req.method === "POST" && p === "/logout") {
      util2.drop(util2.getToken(req));
      return redirect(res, "/login", { "Set-Cookie": util2.clearCookieHeader() });
    }

    // Officer public routes (no roster rankings)
    let m = p.match(/^\/s\/([^/]+)$/);
    if (req.method === "GET" && m) {
      await prepareShift(m[1], req);
      const html = views.officerPage(m[1]);
      if (!html) return send(res, 404, views.layout("Not found", "<p>Shift not found</p>"));
      return send(res, 200, html);
    }
    m = p.match(/^\/s\/([^/]+)\/interest$/);
    if (req.method === "POST" && m) {
      await prepareShift(m[1], req);
      const body = await readBody(req);
      const r = db.addInterest(m[1], body.badge, interestRanks(body));
      if (r.error) {
        return send(res, r.status || 400, views.layout("Interest",
          "<section class=\"card\"><p>" + views.esc(r.error) + "</p><p><a href=\"/s/" + views.esc(m[1]) + "\">Back</a></p></section>"));
      }
      if (!r.updated) await maybeWeekWarningSms(m[1], r.interest, r.sameWeek);
      return send(res, 200, views.thanksPage(r.interest, m[1], r.sameWeek, { updated: !!r.updated }));
    }
    m = p.match(/^\/api\/shifts\/([^/]+)\/interest$/);
    if (req.method === "POST" && m) {
      await prepareShift(m[1], req);
      const body = await readBody(req);
      const r = db.addInterest(m[1], body.badge, interestRanks(body));
      if (r.error) return send(res, r.status || 400, { error: r.error });
      if (!r.updated) await maybeWeekWarningSms(m[1], r.interest, r.sameWeek);
      return send(res, r.updated ? 200 : 201, Object.assign({}, r.interest, { sameWeek: r.sameWeek || [], updated: !!r.updated }));
    }
    m = p.match(/^\/s\/([^/]+)\/withdraw$/);
    if (req.method === "POST" && m) {
      await prepareShift(m[1], req);
      const body = await readBody(req);
      const r = db.removeInterest(m[1], body.badge);
      if (r.error) {
        return send(res, r.status || 400, views.layout("Withdraw",
          "<section class=\"card\"><p class=\"banner\">" + views.esc(r.error) + "</p>" +
          "<p><a class=\"btn\" href=\"/s/" + views.esc(m[1]) + "\">Back to shift</a></p></section>"));
      }
      return send(res, 200, views.withdrawnPage(r.interest, m[1]));
    }
    m = p.match(/^\/api\/shifts\/([^/]+)\/withdraw$/);
    if (req.method === "POST" && m) {
      await prepareShift(m[1], req);
      const r = db.removeInterest(m[1], (await readBody(req)).badge);
      if (r.error) return send(res, r.status || 400, { error: r.error });
      return send(res, 200, { interest: r.interest });
    }

    // Everything below requires admin
    const adminPaths =
      p === "/" || p === "/admin" || p.startsWith("/admin/") ||
      p === "/api/roster" || p.startsWith("/api/roster/") ||
      p === "/api/awards" || p === "/api/shifts" ||
      /^\/api\/shifts\//.test(p);
    if (adminPaths && !requireAdmin(req, res)) return;

    if (req.method === "GET" && p === "/api/roster") return send(res, 200, db.getRoster());

    if (req.method === "GET" && (p === "/" || p === "/admin")) {
      if (!util2.hasKey()) {
        return redirect(res, "/setup");
      }
      return send(res, 200, views.adminHome({ savedBadge: url.searchParams.get("phone") }));
    }

    if (req.method === "POST" && p === "/admin/shifts") {
      const body = await readBody(req);
      const shift = db.createShift(body);
      await announceShift(shift, req);
      return redirect(res, "/admin/shift/" + shift.id);
    }

    m = p.match(/^\/admin\/shift\/([^/]+)$/);
    if (req.method === "GET" && m) {
      await prepareShift(m[1], req);
      const html = views.adminShiftPage(m[1], baseUrl(req));
      if (!html) return send(res, 404, views.layout("Not found", "<p>Shift not found</p>"));
      return send(res, 200, html);
    }

    m = p.match(/^\/admin\/shift\/([^/]+)\/close$/);
    if (req.method === "POST" && m) {
      db.closeShift(m[1]);
      return redirect(res, "/admin/shift/" + m[1]);
    }

    m = p.match(/^\/admin\/shift\/([^/]+)\/award$/);
    if (req.method === "POST" && m) {
      const r = db.confirmAward(m[1]);
      if (r.error) return send(res, r.status || 400, views.layout("Error", "<p>" + views.esc(r.error) + "</p>", "/admin/shift/" + m[1]));
      if (!r.multi || (r.awardedNow && r.awardedNow.length)) await announceAward(r.shift);
      await flushResendTexts(req);
      return redirect(res, "/admin/shift/" + m[1]);
    }

    m = p.match(/^\/admin\/shift\/([^/]+)\/cancel$/);
    if (req.method === "POST" && m) {
      const body = await readBody(req);
      const r = db.cancelAward(m[1], { day: body.day, awardId: body.awardId });
      if (r.error) {
        return send(res, r.status || 400, views.layout("Cancel award",
          "<section class=\"card\"><p>" + views.esc(r.error) + "</p>" +
          "<p><a class=\"btn\" href=\"/admin/shift/" + views.esc(m[1]) + "\">Back to shift</a> " +
          "<a class=\"btn\" href=\"/\">Admin home</a></p></section>",
          "/admin/shift/" + m[1]));
      }
      return redirect(res, "/admin/shift/" + m[1] + "?restored=1");
    }

    if (req.method === "POST" && p === "/api/shifts") {
      const shift = db.createShift(await readBody(req));
      const summary = await announceShift(shift, req);
      const saved = db.getShift(shift.id) || shift;
      return send(res, 201, Object.assign({}, saved, { sms: saved.sms || summary }));
    }

    m = p.match(/^\/api\/shifts\/([^/]+)\/close$/);
    if (req.method === "POST" && m) {
      const r = db.closeShift(m[1]);
      if (r.error) return send(res, r.status || 400, { error: r.error });
      return send(res, 200, r);
    }

    m = p.match(/^\/api\/shifts\/([^/]+)\/award$/);
    if (req.method === "POST" && m) {
      const r = db.confirmAward(m[1]);
      if (r.error) return send(res, r.status || 400, { error: r.error });
      let awardSms = null;
      if (!r.multi || (r.awardedNow && r.awardedNow.length)) awardSms = await announceAward(r.shift);
      await flushResendTexts(req);
      return send(res, 200, Object.assign({}, r, { awardSms }));
    }

    m = p.match(/^\/api\/shifts\/([^/]+)\/cancel$/);
    if (req.method === "POST" && m) {
      const body = await readBody(req);
      const r = db.cancelAward(m[1], { day: body.day, awardId: body.awardId });
      if (r.error) return send(res, r.status || 400, { error: r.error });
      return send(res, 200, r);
    }

    if (req.method === "GET" && p === "/api/awards") {
      return send(res, 200, db.listRecentAwards());
    }

    m = p.match(/^\/api\/shifts\/([^/]+)$/);
    if (req.method === "GET" && m) {
      await prepareShift(m[1], req);
      const info = db.suggestWinner(m[1]);
      if (info.error) return send(res, info.status || 404, { error: info.error });
      return send(res, 200, info);
    }

    m = p.match(/^\/admin\/roster\/([^/]+)\/phone$/);
    if (req.method === "POST" && m) {
      const body = await readBody(req);
      const r = db.setOfficerPhone(decodeURIComponent(m[1]), body.phone);
      if (r.error) {
        return send(res, r.status || 400, views.adminHome({ error: r.error }));
      }
      return redirect(res, "/?phone=" + encodeURIComponent(r.officer.badge) + "#b-" + encodeURIComponent(r.officer.badge));
    }

    m = p.match(/^\/api\/roster\/([^/]+)\/phone$/);
    if (req.method === "POST" && m) {
      const body = await readBody(req);
      const r = db.setOfficerPhone(decodeURIComponent(m[1]), body.phone);
      if (r.error) return send(res, r.status || 400, { error: r.error });
      return send(res, 200, r.officer);
    }

    send(res, 404, views.layout("Not found", "<p>Not found</p>"));
  } catch (err) {
    console.error(err);
    send(res, 500, views.layout("Error", "<p>" + views.esc(err.message) + "</p>"));
  }
});

function armSweep() {
  const sweep = setInterval(() => {
    try { db.rollExpiredShifts(); } catch (err) { console.error(err); }
    persist.flush()
      .then(() => flushResendTexts(fallbackBase()))
      .catch((err) => console.error("resend sweep", err && err.message));
  }, 30000);
  if (sweep.unref) sweep.unref();
}

if (require.main === module) {
  db.bootstrap()
    .then(() => {
      db.rollExpiredShifts();
      return persist.flush();
    })
    .then(() => flushResendTexts(fallbackBase()))
    .then(() => persist.flush())
    .then(() => {
      armSweep();
      server.listen(PORT, "0.0.0.0", () => console.log("TFPD Off Duty on http://0.0.0.0:" + PORT));
    })
    .catch((err) => {
      console.error("startup failed", err);
      process.exit(1);
    });
}

module.exports = { server, PORT };
