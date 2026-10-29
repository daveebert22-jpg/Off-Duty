const path = require("path");
const fs = require("fs");
const root = path.join(__dirname, "..");
process.chdir(root);
const storePath = path.join(root, "data", "store.json");
const db = require("../db");
db.resetToSeed();

function idx(badge) {
  return db.getRoster().findIndex((o) => o.badge === String(badge));
}
function last(badge) {
  const o = db.getRoster().find((x) => x.badge === String(badge));
  return o ? o.lastAward : null;
}

const results = {};
const beforeIdx = idx("54");
const beforeLast = last("54");
results.beforeIdx = beforeIdx;
results.beforeLast = beforeLast;

const s1 = db.createShift({ title: "Verizon Municipal", whenText: "tomorrow 9a-1p", location: "Municipal Drive", windowMinutes: 20 });
db.addInterest(s1.id, "84");
db.addInterest(s1.id, "80");
db.addInterest(s1.id, "54");
const awarded = db.confirmAward(s1.id);
results.winner = awarded.winner && awarded.winner.badge;
results.awardSnapshot = awarded.award && {
  priorOrder: awarded.award.priorOrder,
  priorLastAward: awarded.award.priorLastAward,
};
const afterAwardIdx = idx("54");
const rosterLen = db.getRoster().length;
results.afterAwardIdx = afterAwardIdx;
results.atBottom = afterAwardIdx === rosterLen - 1;

const cancelled = db.cancelAward(s1.id);
results.cancelOk = !cancelled.error;
results.restoredOrder = cancelled.restored && cancelled.restored.order;
results.restoredLast = cancelled.restored && cancelled.restored.lastAward;
results.afterCancelIdx = idx("54");
results.afterCancelLast = last("54");
results.restoredToOriginal =
  results.afterCancelIdx === beforeIdx && results.afterCancelLast === beforeLast;
results.shiftCancelled = cancelled.shift && cancelled.shift.status === "cancelled";

db.resetToSeed();
const s2 = db.createShift({ title: "Old job", windowMinutes: 20 });
db.addInterest(s2.id, "54");
db.confirmAward(s2.id);
const data = JSON.parse(fs.readFileSync(storePath, "utf8"));
const oldMs = 15 * 24 * 60 * 60 * 1000;
data.awards.forEach((a) => { if (a.shiftId === s2.id) a.awardedAt = Date.now() - oldMs; });
data.shifts.forEach((s) => { if (s.id === s2.id) s.awardedAt = Date.now() - oldMs; });
fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
const refused = db.cancelAward(s2.id);
results.oldRefuse = !!refused.error;
results.oldMsg = refused.error || null;
results.oldStillAwarded = db.getShift(s2.id).status === "awarded";

db.resetToSeed();
const s3a = db.createShift({ title: "Job A", windowMinutes: 20 });
db.addInterest(s3a.id, "54");
db.confirmAward(s3a.id);
const s3b = db.createShift({ title: "Job B", windowMinutes: 20 });
db.addInterest(s3b.id, "54");
db.confirmAward(s3b.id);
const blocked = db.cancelAward(s3a.id);
results.newerBlock = !!blocked.error && /newer/i.test(String(blocked.error));
results.newerStatus = blocked.status;
results.newerMsg = blocked.error || null;
const cancelNewer = db.cancelAward(s3b.id);
results.cancelNewerOk = !cancelNewer.error;

db.resetToSeed();
const s4 = db.createShift({ title: "List check", windowMinutes: 20 });
db.addInterest(s4.id, "65");
db.confirmAward(s4.id);
const recent = db.listRecentAwards();
results.recentHas = recent.some((a) => a.shiftId === s4.id && a.canRestore === true);

const ok =
  results.winner === "54" &&
  results.atBottom === true &&
  results.restoredToOriginal === true &&
  results.shiftCancelled === true &&
  results.oldRefuse === true &&
  results.oldStillAwarded === true &&
  results.newerBlock === true &&
  results.cancelNewerOk === true &&
  results.recentHas === true;

console.log(JSON.stringify({ ok, results }, null, 2));
db.resetToSeed();
process.exit(ok ? 0 : 1);
