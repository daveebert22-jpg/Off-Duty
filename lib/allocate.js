// Multi-day award: walk the rotation from the top. Each officer gets their
// highest-ranked day that still has an open spot. Round 1 and 2 give one day
// and skip anyone who already holds a day. Round 3 ("extra") repeats that
// pass so holders can take additional days, one more day per pass. An officer
// never takes two spots on the same day.

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

function slotsPerDayOf(shiftOrNumber) {
  const raw = shiftOrNumber && typeof shiftOrNumber === "object" ? shiftOrNumber.slotsPerDay : shiftOrNumber;
  let n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(10, n);
}

function dayAssignees(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  list.forEach((v) => {
    if (v && typeof v === "object" && v.badge != null && String(v.badge).trim() !== "") {
      out.push({
        badge: String(v.badge),
        name: v.name || "",
        awardId: v.awardId || null,
        round: v.round || null,
        at: v.at || null,
      });
      return;
    }
    if (v != null && typeof v !== "object" && String(v).trim() !== "") {
      out.push({ badge: String(v), name: "", awardId: null, round: null, at: null });
    }
  });
  return out;
}

function allocateDays({ roster, interests, days, assigned, mode, slotsPerDay }) {
  const daySet = new Set((days || []).map((d) => Number(d)).filter((d) => Number.isInteger(d) && d > 0));
  const cap = slotsPerDayOf(slotsPerDay);
  const byDay = new Map();
  const heldBy = new Map();
  const src = assigned || {};
  Object.keys(src).forEach((k) => {
    const day = Number(k);
    if (!Number.isInteger(day)) return;
    const people = dayAssignees(src[k]);
    if (!people.length) return;
    byDay.set(day, people.map((p) => p.badge));
    people.forEach((p) => {
      if (!heldBy.has(p.badge)) heldBy.set(p.badge, new Set());
      heldBy.get(p.badge).add(day);
    });
  });
  const holders = new Set();
  heldBy.forEach((_, badge) => holders.add(badge));

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
    const mine = heldBy.get(badge) || new Set();
    for (let i = 0; i < ranks.length; i++) {
      const day = ranks[i];
      if (!daySet.has(day) || mine.has(day)) continue;
      const filled = (byDay.get(day) || []).length;
      if (filled >= cap) continue;
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
      if (!byDay.has(choice)) byDay.set(choice, []);
      byDay.get(choice).push(o.badge);
      if (!heldBy.has(o.badge)) heldBy.set(o.badge, new Set());
      heldBy.get(o.badge).add(choice);
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
    const limit = daySet.size * cap + 1;
    while (guard < limit && onePass(false)) guard++;
  } else {
    onePass(true);
  }
  return result;
}

module.exports = { allocateDays, normalizeRanks, slotsPerDayOf, dayAssignees };
