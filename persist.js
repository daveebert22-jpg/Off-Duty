const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const CFG_PATH = path.join(DATA_DIR, "cfg.json");

let mode = "file";
let pool = null;
let storeCache = null;
let cfgCache = null;
let chain = Promise.resolve();
let lastError = null;

function usingPg() {
  return mode === "pg";
}

function hasStore() {
  return storeCache != null;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error("Could not read " + file, err && err.message);
    return null;
  }
}

function stripSslMode(urlString) {
  try {
    const u = new URL(urlString);
    u.searchParams.delete("sslmode");
    return u.toString();
  } catch (err) {
    return urlString;
  }
}

function hostOf(urlString) {
  try {
    return new URL(urlString).hostname || "";
  } catch (err) {
    return "";
  }
}

function prefersSsl(urlString) {
  const host = hostOf(urlString);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".internal")) return false;
  return host.indexOf(".") !== -1;
}

function poolOptions(urlString, ssl) {
  return {
    connectionString: ssl ? urlString : stripSslMode(urlString),
    max: 2,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 10000,
    ssl: ssl ? { rejectUnauthorized: false } : false,
  };
}

async function connectPool(urlString) {
  const { Pool } = require("pg");
  const order = prefersSsl(urlString) ? [true, false] : [false, true];
  let lastErr = null;
  for (const ssl of order) {
    const attempt = new Pool(poolOptions(urlString, ssl));
    try {
      await attempt.query("SELECT 1");
      console.log("Postgres connected (" + (ssl ? "ssl" : "no ssl") + ")");
      return attempt;
    } catch (err) {
      lastErr = err;
      try { await attempt.end(); } catch (e) { /* ignore */ }
    }
  }
  throw lastErr || new Error("Postgres connection failed");
}

async function upsertNow(key, value) {
  await pool.query(
    "INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, now()) " +
      "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [key, JSON.stringify(value)]
  );
}

function enqueue(key, value) {
  const snapshot = clone(value);
  if (key === "store") storeCache = snapshot;
  else if (key === "cfg") cfgCache = snapshot;
  const run = () => upsertNow(key, snapshot);
  const pending = chain.then(run, run);
  chain = pending.then(
    () => { lastError = null; },
    (err) => {
      lastError = err;
      console.error("Postgres write failed", err && err.message);
    }
  );
  return pending;
}

async function init() {
  const url = String(process.env.DATABASE_URL || "").trim();
  if (!url) {
    mode = "file";
    return { mode };
  }
  pool = await connectPool(url);
  await pool.query(
    "CREATE TABLE IF NOT EXISTS app_kv (" +
      "key text PRIMARY KEY, " +
      "value jsonb NOT NULL, " +
      "updated_at timestamptz NOT NULL DEFAULT now())"
  );
  const found = await pool.query("SELECT key, value FROM app_kv WHERE key IN ('store', 'cfg')");
  const have = {};
  found.rows.forEach((row) => { have[row.key] = row.value; });

  let store = have.store || null;
  let cfg = have.cfg || null;
  if (!store) {
    const fromFile = readJsonFile(STORE_PATH);
    if (fromFile) {
      store = fromFile;
      console.log("Imported store.json into Postgres");
    }
  }
  if (!cfg) {
    const fromFile = readJsonFile(CFG_PATH);
    if (fromFile) {
      cfg = fromFile;
      console.log("Imported cfg.json into Postgres");
    }
  }
  storeCache = store;
  cfgCache = cfg;
  mode = "pg";
  if (store && !have.store) await upsertNow("store", store);
  if (cfg && !have.cfg) await upsertNow("cfg", cfg);
  return { mode };
}

function readStore() {
  if (!storeCache) return null;
  return clone(storeCache);
}

function writeStore(data) {
  if (mode !== "pg") return;
  return enqueue("store", data);
}

function readCfg() {
  return cfgCache ? clone(cfgCache) : null;
}

function writeCfg(obj) {
  if (mode !== "pg") return;
  return enqueue("cfg", obj);
}

function flush() {
  return chain.then(() => {
    if (lastError) {
      const err = lastError;
      lastError = null;
      throw err;
    }
  });
}

module.exports = {
  init,
  usingPg,
  hasStore,
  readStore,
  writeStore,
  readCfg,
  writeCfg,
  flush,
  STORE_PATH,
  CFG_PATH,
};
