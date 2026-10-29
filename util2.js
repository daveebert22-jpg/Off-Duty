const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const CFG_PATH = path.join(DATA_DIR, "cfg.json");
const COOKIE = "od_a";
const TTL = 14 * 24 * 60 * 60 * 1000;
const jar = new Map();
function ensureDir(){ if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true}); }
function readCfg(){ ensureDir(); if (!fs.existsSync(CFG_PATH)) return null; try { return JSON.parse(fs.readFileSync(CFG_PATH,"utf8")); } catch { return null; } }
function writeCfg(obj){ ensureDir(); fs.writeFileSync(CFG_PATH, JSON.stringify(obj,null,2)); }
function hasKey(){ const a=readCfg(); return !!(a && a.keyHash && a.salt); }
function digest(raw, salt){ return crypto.createHash("sha256").update(String(salt)+":"+String(raw)).digest("hex"); }
function setKey(raw){ const p=String(raw||""); if (p.length<4) return {error:"Must be at least 4 characters"}; const salt=crypto.randomBytes(16).toString("hex"); writeCfg({keyHash:digest(p,salt),salt,updatedAt:Date.now()}); return {ok:true}; }
function checkKey(raw){ const a=readCfg(); if (!a||!a.keyHash||!a.salt) return false; return digest(raw,a.salt)===a.keyHash; }
function parseCookies(req){ const header=req.headers.cookie||""; const out={}; header.split(";").forEach(part=>{ const i=part.indexOf("="); if(i<0)return; const k=part.slice(0,i).trim(); const v=part.slice(i+1).trim(); if(k) out[k]=decodeURIComponent(v); }); return out; }
function prune(){ const now=Date.now(); for (const [id,s] of jar){ if(s.expiresAt<=now) jar.delete(id); } }
function mint(){ prune(); const id=crypto.randomBytes(24).toString("hex"); jar.set(id,{expiresAt:Date.now()+TTL}); return id; }
function drop(id){ if(id) jar.delete(id); }
function isAuthed(req){ prune(); const id=parseCookies(req)[COOKIE]; if(!id) return false; const s=jar.get(id); if(!s||s.expiresAt<=Date.now()){ jar.delete(id); return false;} s.expiresAt=Date.now()+TTL; return true; }
function cookieHeader(id){ const maxAge=Math.floor(TTL/1000); const secure=(process.env.OD_SECURE==="1"||process.env.NODE_ENV==="production")?"; Secure":""; return COOKIE+"="+encodeURIComponent(id)+"; Path=/; HttpOnly; SameSite=Lax; Max-Age="+maxAge+secure; }
function clearCookieHeader(){ return COOKIE+"=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"; }
function getToken(req){ return parseCookies(req)[COOKIE]||null; }
module.exports={COOKIE,CFG_PATH,hasKey,setKey,checkKey,isAuthed,mint,drop,getToken,cookieHeader,clearCookieHeader};
