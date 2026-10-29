const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const URL = process.env.DATABASE_URL || "postgres://tfpd:tfpd@127.0.0.1:5432/tfpd_offduty";
const PORT = 3891;
const root = path.join(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tfpd-pg-"));
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "tfpd-pg-empty-"));

delete process.env.DATABASE_URL;
process.env.DATA_DIR = dataDir;

const util2 = require("../util2");
const db = require("../db");
const { Client } = require("pg");

const results = {};
let child = null;
let log = "";

function startServer(dir) {
  log = "";
  child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      DATABASE_URL: URL,
      DATA_DIR: dir,
      PORT: String(PORT),
      TWILIO_ACCOUNT_SID: "",
      TWILIO_AUTH_TOKEN: "",
      TWILIO_FROM_NUMBER: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => { log += b.toString(); });
  child.stderr.on("data", (b) => { log += b.toString(); });
  return child;
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child && child.exitCode == null) child.kill("SIGKILL");
    }, 2000);
  });
}

function waitHealth() {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (child && child.exitCode != null) {
        clearInterval(timer);
        reject(new Error("server exited\n" + log));
        return;
      }
      const req = http.get("http://127.0.0.1:" + PORT + "/api/health", (res) => {
        res.resume();
        if (res.statusCode === 200) {
          clearInterval(timer);
          resolve();
        }
      });
      req.on("error", () => {});
      if (Date.now() - started > 20000) {
        clearInterval(timer);
        reject(new Error("health timeout\n" + log));
      }
    }, 200);
  });
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

async function login() {
  const res = await call("POST", "/login", "code=proof1", { "Content-Type": "application/x-www-form-urlencoded" });
  const cookie = String(res.headers["set-cookie"] || "").split(";")[0];
  return { status: res.status, cookie };
}

async function editStore(fn) {
  const client = new Client({ connectionString: URL, ssl: false });
  await client.connect();
  const cur = await client.query("SELECT value FROM app_kv WHERE key = 'store'");
  const store = cur.rows[0].value;
  fn(store);
  await client.query("UPDATE app_kv SET value = $1::jsonb WHERE key = 'store'", [JSON.stringify(store)]);
  await client.end();
}

(async () => {
  const client = new Client({ connectionString: URL, ssl: false });
  await client.connect();
  await client.query("DROP TABLE IF EXISTS app_kv");
  await client.end();

  util2.setKey("proof1");
  db.resetToSeed();
  db.setOfficerPhone("65", "7325550109");
  const imported = db.createShift({ title: "Imported job", whenText: "6p-10p", whenDate: "2026-10-30", windowMinutes: 30 });
  db.addInterest(imported.id, "54");

  startServer(dataDir);
  await waitHealth();
  results.importedLog = /Imported store.json/.test(log) && /Imported cfg.json/.test(log);
  let auth = await login();
  results.loginAfterImport = auth.status === 303 && auth.cookie.indexOf("od_a=") === 0;
  const roster = JSON.parse((await call("GET", "/api/roster", null, { Cookie: auth.cookie })).body);
  const duncan = roster.find((o) => o.badge === "65");
  results.importedPhone = duncan && duncan.phone === "+17325550109";
  const shifts = JSON.parse((await call("GET", "/api/shifts/" + imported.id, null, { Cookie: auth.cookie })).body);
  results.importedInterest = shifts.interests && shifts.interests.some((i) => i.badge === "54");

  const created = JSON.parse((await call("POST", "/api/shifts", {
    title: "Live job", whenText: "9a", whenDate: "2026-11-02", windowMinutes: 25,
  }, { Cookie: auth.cookie })).body);
  await call("POST", "/api/roster/64/phone", { phone: "7325550110" }, { Cookie: auth.cookie });
  await call("POST", "/api/shifts/" + created.id + "/interest", { badge: "64" });

  const empty = JSON.parse((await call("POST", "/api/shifts", {
    title: "Unfilled nap", whenText: "noon", whenDate: "2026-11-03", windowMinutes: 40,
  }, { Cookie: auth.cookie })).body);
  const filled = JSON.parse((await call("POST", "/api/shifts", {
    title: "Has people", whenText: "1p", whenDate: "2026-11-04", windowMinutes: 40,
  }, { Cookie: auth.cookie })).body);
  await call("POST", "/api/shifts/" + filled.id + "/interest", { badge: "72" });

  await stopServer();

  startServer(emptyDir);
  await waitHealth();
  results.noReimport = !/Imported store.json/.test(log);
  auth = await login();
  results.loginAfterRestart = auth.status === 303;
  const roster2 = JSON.parse((await call("GET", "/api/roster", null, { Cookie: auth.cookie })).body);
  results.phoneSurvived = roster2.find((o) => o.badge === "65").phone === "+17325550109" &&
    roster2.find((o) => o.badge === "64").phone === "+17325550110";
  const live = JSON.parse((await call("GET", "/api/shifts/" + created.id, null, { Cookie: auth.cookie })).body);
  results.shiftSurvived = live.shift && live.shift.title === "Live job" &&
    live.interests.some((i) => i.badge === "64");
  const stillImported = JSON.parse((await call("GET", "/api/shifts/" + imported.id, null, { Cookie: auth.cookie })).body);
  results.importSurvived = stillImported.interests.some((i) => i.badge === "54");

  await stopServer();
  await editStore((store) => {
    store.shifts.forEach((s) => {
      if (s.id === empty.id || s.id === filled.id) s.closesAt = Date.now() - 5000;
    });
  });
  startServer(emptyDir);
  await waitHealth();
  auth = await login();
  const unfilled = JSON.parse((await call("GET", "/api/shifts/" + empty.id, null, { Cookie: auth.cookie })).body);
  const withPeople = JSON.parse((await call("GET", "/api/shifts/" + filled.id, null, { Cookie: auth.cookie })).body);
  results.reopenedWhileAsleep = unfilled.shift && unfilled.shift.status === "open" &&
    unfilled.shift.resendCount === 1 && unfilled.shift.closesAt > Date.now();
  results.closedForAwardWhileAsleep = withPeople.shift && withPeople.shift.status === "closed" &&
    !withPeople.shift.winnerBadge && withPeople.interests.some((i) => i.badge === "72");

  const ok = Object.keys(results).every((k) => results[k] === true);
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) {
    console.error(log);
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error(err);
  console.error(log);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  setTimeout(() => process.exit(process.exitCode || 0), 50);
});
