const http = require("http");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
process.chdir(root);
const seed = require("../roster");
fs.writeFileSync(path.join(root, "data", "store.json"), JSON.stringify({
  roster: seed.map((o, i) => Object.assign({}, o, { order: i })),
  shifts: [], interests: [], nextShiftId: 1
}, null, 2));
const { server, PORT } = require("../server");

function call(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const d = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (d) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(d);
    }
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("error", reject);
    if (d) r.write(d);
    r.end();
  });
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const h = await call("GET", "/api/health");
  const home = await call("GET", "/");
  const created = await call("POST", "/api/shifts", {
    title: "Main St Detail", whenText: "Sat", location: "Main", windowMinutes: 20
  });
  const shift = JSON.parse(created.body);
  await call("POST", "/api/shifts/" + shift.id + "/interest", { badge: "84" });
  await call("POST", "/api/shifts/" + shift.id + "/interest", { badge: "80" });
  await call("POST", "/api/shifts/" + shift.id + "/interest", { badge: "54" });
  const closed = JSON.parse((await call("POST", "/api/shifts/" + shift.id + "/close", {})).body);
  const awarded = JSON.parse((await call("POST", "/api/shifts/" + shift.id + "/award", {})).body);
  const officer = await call("GET", "/s/" + shift.id);
  const admin = await call("GET", "/admin/shift/" + shift.id);
  const css = await call("GET", "/styles.css");
  const ok =
    h.status === 200 &&
    home.status === 200 &&
    home.body.indexOf("Post a shift") >= 0 &&
    closed.suggestion && closed.suggestion.badge === "54" &&
    awarded.winner && awarded.winner.badge === "54" &&
    officer.body.indexOf("Pierson") >= 0 &&
    admin.body.indexOf("Awarded") >= 0 &&
    css.status === 200;
  console.log(JSON.stringify({
    suggest: closed.suggestion,
    winner: awarded.winner,
    homeOk: home.body.indexOf("Post a shift") >= 0,
    officerOk: officer.body.indexOf("Pierson") >= 0,
    adminOk: admin.body.indexOf("Awarded") >= 0,
    css: css.status,
    ok
  }));
  server.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
