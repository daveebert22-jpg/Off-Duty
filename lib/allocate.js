// Multi-day award: walk the rotation from the top. Each officer gets their
// highest-ranked day that is still open. Round 1 and 2 give one day and skip
// anyone who already holds a day. Round 3 ("extra") repeats that pass so
// holders can take additional days, one more day per pass.

function normalizeRanks(raw) {
  let list = raw;
  if (typeof raw === "string") list = raw.split(/[^0-9]+/);
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  list.forEach((n) => {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  });
  return out;
}

function allocateDays({ roster, interests, days, assigned, mode }) {
  const daySet = new Set((days || []).map((d) => Number(d)).filter((d) => Number.isInteger(d) && d > 0));
  const taken = new Map();
  const src = assigned || {};
  Object.keys(src).forEach((k) => {
    const v = src[k];
    const badge = v && typeof v === "object" ? v.badge : v;
    if (badge == null || String(badge).trim() === "") return;
    const day = Number(k);
    if (!Number.isInteger(day)) return;
    taken.set(day, String(badge));
  });
  const holders = new Set();
  taken.forEach((badge) => holders.add(badge));

  const ranksByBadge = new Map();
  const nameByBadge = new Map();
  (interests || []).forEach((i) => {
    if (!i || i.badge == null) return;
    const badge = String(i.badge);
    ranksByBadge.set(badge, normalizeRanks(i.ranks != null ? i.ranks : i.days));
    if (i.name) nameByBadge.set(badge, i.name);
  });

  const order = (roster || []).map((o) => ({
    badge: String(o.badge),
    name: o.name || nameByBadge.get(String(o.badge)) || "",
  }));

  function bestOpen(badge) {
    const ranks = ranksByBadge.get(badge);
    if (!ranks) return null;
    for (let i = 0; i < ranks.length; i++) {
      const day = ranks[i];
      if (!daySet.has(day) || taken.has(day)) continue;
      return day;
    }
    return null;
  }

  const result = [];
  function onePass(skipHolders) {
    let added = 0;
    order.forEach((o) => {
      if (skipHolders && holders.has(o.badge)) return;
      const choice = bestOpen(o.badge);
      if (choice == null) return;
      taken.set(choice, o.badge);
      holders.add(o.badge);
      result.push({
        day: choice,
        badge: o.badge,
        name: o.name || nameByBadge.get(o.badge) || "",
      });
      added++;
    });
    return added;
  }

  if (mode === "extra") {
    let guard = 0;
    const cap = daySet.size + 1;
    while (guard < cap && onePass(false)) guard++;
  } else {
    onePass(true);
  }
  return result;
}

module.exports = { allocateDays, normalizeRanks };
