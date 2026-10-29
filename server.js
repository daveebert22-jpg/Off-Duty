const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const db = require("./db");
const views = require("./lib/views");
const util2 = require("./util2");

const PORT = Number(process.env.PORT) || 3847;
const PUBLIC = path.join(__dirname, "public");

function send(res, status, body, headers) {
  const h = Object.assign({ "Content-Type": "text/html; charset=utf-8" }, headers || {});
  if (typeof body === "object" && body !== null && !Buffer.isBuffer(body)) {
    h["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(body);
  }
  res.writeHead(status, h);
  res.end(body);
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
  const host = req.headers["x-forwarded-host"] || req.headers.host || ("localhost:" + PORT);
  const proto = req.headers["x-forwarded-proto"] || "http";
  return proto + "://" + host;
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
        res.writeHead(303, { Location: "/login" });
        return res.end();
      }
      return send(res, 200, views.loginPage({ setup: true }));
    }
    if (req.method === "POST" && p === "/setup") {
      if (util2.hasKey()) {
        res.writeHead(303, { Location: "/login" });
        return res.end();
      }
      const body = await readBody(req);
      if (String(body.code || "") !== String(body.code2 || "")) {
        return send(res, 400, views.loginPage({ setup: true, error: "Codes do not match" }));
      }
      const r = util2.setKey(body.code);
      if (r.error) return send(res, 400, views.loginPage({ setup: true, error: r.error }));
      const id = util2.mint();
      res.writeHead(303, { Location: "/", "Set-Cookie": util2.cookieHeader(id) });
      return res.end();
    }

    // Login / logout
    if (req.method === "GET" && p === "/login") {
      if (!util2.hasKey()) {
        res.writeHead(303, { Location: "/setup" });
        return res.end();
      }
      if (util2.isAuthed(req)) {
        res.writeHead(303, { Location: url.searchParams.get("next") || "/" });
        return res.end();
      }
      return send(res, 200, views.loginPage({ next: url.searchParams.get("next") || "/" }));
    }
    if (req.method === "POST" && p === "/login") {
      if (!util2.hasKey()) {
        res.writeHead(303, { Location: "/setup" });
        return res.end();
      }
      const body = await readBody(req);
      const next = body.next || url.searchParams.get("next") || "/";
      const safe = String(next).startsWith("/") && !String(next).startsWith("//") ? next : "/";
      if (!util2.checkKey(body.code)) {
        return send(res, 401, views.loginPage({ error: "Incorrect code", next: safe }));
      }
      const id = util2.mint();
      res.writeHead(303, { Location: safe, "Set-Cookie": util2.cookieHeader(id) });
      return res.end();
    }
    if (req.method === "POST" && p === "/logout") {
      util2.drop(util2.getToken(req));
      res.writeHead(303, { Location: "/login", "Set-Cookie": util2.clearCookieHeader() });
      return res.end();
    }

    // Officer public routes (no roster rankings)
    let m = p.match(/^\/s\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const html = views.officerPage(m[1]);
      if (!html) return send(res, 404, views.layout("Not found", "<p>Shift not found</p>"));
      return send(res, 200, html);
    }
    m = p.match(/^\/s\/([^/]+)\/interest$/);
    if (req.method === "POST" && m) {
      const body = await readBody(req);
      const r = db.addInterest(m[1], body.badge);
      if (r.error) {
        return send(res, r.status || 400, views.layout("Interest",
          "<section class=\"card\"><p>" + views.esc(r.error) + "</p><p><a href=\"/s/" + views.esc(m[1]) + "\">Back</a></p></section>"));
      }
      return send(res, 200, views.thanksPage(r.interest, m[1]));
    }
    m = p.match(/^\/api\/shifts\/([^/]+)\/interest$/);
    if (req.method === "POST" && m) {
      const r = db.addInterest(m[1], (await readBody(req)).badge);
      if (r.error) return send(res, r.status || 400, { error: r.error });
      return send(res, 201, r.interest);
    }

    // Everything below requires admin
    const adminPaths =
      p === "/" || p === "/admin" || p.startsWith("/admin/") ||
      p === "/api/roster" || p === "/api/awards" || p === "/api/shifts" ||
      /^\/api\/shifts\//.test(p);
    if (adminPaths && !requireAdmin(req, res)) return;

    if (req.method === "GET" && p === "/api/roster") return send(res, 200, db.getRoster());

    if (req.method === "GET" && (p === "/" || p === "/admin")) {
      if (!util2.hasKey()) {
        res.writeHead(303, { Location: "/setup" });
        return res.end();
      }
      return send(res, 200, views.adminHome());
    }

    if (req.method === "POST" && p === "/admin/shifts") {
      const body = await readBody(req);
      const shift = db.createShift(body);
      res.writeHead(303, { Location: "/admin/shift/" + shift.id });
      return res.end();
    }

    m = p.match(/^\/admin\/shift\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const html = views.adminShiftPage(m[1], baseUrl(req));
      if (!html) return send(res, 404, views.layout("Not found", "<p>Shift not found</p>"));
      return send(res, 200, html);
    }

    m = p.match(/^\/admin\/shift\/([^/]+)\/close$/);
    if (req.method === "POST" && m) {
      db.closeShift(m[1]);
      res.writeHead(303, { Location: "/admin/shift/" + m[1] });
      return res.end();
    }

    m = p.match(/^\/admin\/shift\/([^/]+)\/award$/);
    if (req.method === "POST" && m) {
      const r = db.confirmAward(m[1]);
      if (r.error) return send(res, r.status || 400, views.layout("Error", "<p>" + views.esc(r.error) + "</p>", "/admin/shift/" + m[1]));
      res.writeHead(303, { Location: "/admin/shift/" + m[1] });
      return res.end();
    }

    m = p.match(/^\/admin\/shift\/([^/]+)\/cancel$/);
    if (req.method === "POST" && m) {
      const r = db.cancelAward(m[1]);
      if (r.error) {
        return send(res, r.status || 400, views.layout("Cancel award",
          "<section class=\"card\"><p>" + views.esc(r.error) + "</p>" +
          "<p><a class=\"btn\" href=\"/admin/shift/" + views.esc(m[1]) + "\">Back to shift</a> " +
          "<a class=\"btn\" href=\"/\">Admin home</a></p></section>",
          "/admin/shift/" + m[1]));
      }
      res.writeHead(303, { Location: "/admin/shift/" + m[1] + "?restored=1" });
      return res.end();
    }

    if (req.method === "POST" && p === "/api/shifts") {
      return send(res, 201, db.createShift(await readBody(req)));
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
      return send(res, 200, r);
    }

    m = p.match(/^\/api\/shifts\/([^/]+)\/cancel$/);
    if (req.method === "POST" && m) {
      const r = db.cancelAward(m[1]);
      if (r.error) return send(res, r.status || 400, { error: r.error });
      return send(res, 200, r);
    }

    if (req.method === "GET" && p === "/api/awards") {
      return send(res, 200, db.listRecentAwards());
    }

    m = p.match(/^\/api\/shifts\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const info = db.suggestWinner(m[1]);
      if (info.error) return send(res, info.status || 404, { error: info.error });
      return send(res, 200, info);
    }

    send(res, 404, views.layout("Not found", "<p>Not found</p>"));
  } catch (err) {
    console.error(err);
    send(res, 500, views.layout("Error", "<p>" + views.esc(err.message) + "</p>"));
  }
});

if (require.main === module) {
  db.getRoster();
  server.listen(PORT, () => console.log("TFPD Off Duty on http://localhost:" + PORT));
}

module.exports = { server, PORT };
