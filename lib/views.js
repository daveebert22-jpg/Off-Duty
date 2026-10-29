const db = require("../db");
const sms = require("../sms");

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function remaining(closesAt) {
  const ms = closesAt - Date.now();
  if (ms <= 0) return "Closed";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m + "m " + String(s).padStart(2, "0") + "s";
}

function layout(title, body, back, opts) {
  opts = opts || {};
  let right = "";
  if (back) right += "<a class=\"back\" href=\"" + esc(back) + "\">Back</a>";
  if (opts.logout) {
    if (right) right += " · ";
    right += "<form method=\"POST\" action=\"/logout\" class=\"inline-form\" style=\"display:inline\"><button type=\"submit\" class=\"back\" style=\"background:none;border:0;cursor:pointer;padding:0;font:inherit\">Log out</button></form>";
  }
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"/>" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>" +
    "<title>" + esc(title) + " · TFPD Off Duty</title>" +
    "<link rel=\"stylesheet\" href=\"/styles.css\"/></head><body>" +
    "<header class=\"top\"><div class=\"brand\">TFPD Off Duty</div>" + right +
    "</header><main class=\"wrap\">" + body + "</main></body></html>";
}

function adminHome(opts) {
  opts = opts || {};
  const savedBadge = opts.savedBadge ? String(opts.savedBadge) : "";
  const shifts = db.listShifts();
  const rows = shifts.map((s) => {
    const n = db.getInterests(s.id).length;
    return "<tr><td><a href=\"/admin/shift/" + esc(s.id) + "\">" + esc(s.title) + "</a>" +
      (s.days && s.days.length > 1 ? " <span class=\"muted\">" + s.days.length + " days</span>" : "") + "</td>" +
      "<td><span class=\"pill " + esc(s.status) + "\">" + esc(s.status) + "</span></td>" +
      "<td>" + n + "</td><td>" + esc(fmtTime(s.closesAt)) + "</td></tr>";
  }).join("");
  const rosterOfficers = db.getRoster();
  const saved = savedBadge ? rosterOfficers.find((o) => o.badge === savedBadge) : null;
  const roster = rosterOfficers.map((o) => {
    const phone = o.phone || "";
    return "<li class=\"roster-item\" id=\"b-" + esc(o.badge) + "\">" +
      "<div><span class=\"badge\">#" + esc(o.badge) + "</span> " + esc(o.name) +
      " <span class=\"muted\">last " + esc(o.lastAward) + "</span></div>" +
      "<form method=\"POST\" action=\"/admin/roster/" + encodeURIComponent(o.badge) + "/phone\" class=\"phone-form\">" +
      "<input name=\"phone\" type=\"tel\" inputmode=\"tel\" autocomplete=\"off\" placeholder=\"No phone — not texted\" value=\"" + esc(phone) + "\"/>" +
      "<button type=\"submit\" class=\"btn\">Save</button></form></li>";
  }).join("");
  const err = opts.error ? "<p class=\"banner\">" + esc(opts.error) + "</p>" : "";
  const savedNote = saved
    ? "<p class=\"sms-ok\">Saved phone for #" + esc(saved.badge) + " " + esc(saved.name) + ".</p>"
    : "";
  const twilioNote = sms.twilioConfigured()
    ? "<p class=\"muted\">Twilio is configured. Creating a shift texts every officer with a phone number.</p>"
    : "<p class=\"banner\">Twilio is not configured, so new shifts will not text anyone. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.</p>";
  const body =
    "<section class=\"card\"><h1>Post a shift</h1>" + err + twilioNote +
    "<form method=\"POST\" action=\"/admin/shifts\" class=\"stack\">" +
    "<label>Title<input name=\"title\" required value=\"Off Duty\"/></label>" +
    "<label>Shift date<input name=\"whenDate\" type=\"date\"/></label>" +
    "<label>When<input name=\"whenText\" placeholder=\"6p–10p\"/></label>" +
    "<p class=\"muted\">Shift date is the job's calendar day in Eastern time. Weeks run Sunday–Saturday and drive the same-week reminder.</p>" +
    "<label>Location<input name=\"location\"/></label>" +
    "<label>Notes<textarea name=\"notes\" rows=\"2\"></textarea></label>" +
    "<label class=\"check\"><input type=\"checkbox\" id=\"multiDay\" name=\"multiDay\"/> This job covers more than one day</label>" +
    "<div id=\"multiFields\" hidden>" +
    "<label>How many days?<input id=\"dayCount\" name=\"dayCount\" type=\"number\" min=\"2\" max=\"60\" value=\"5\"/></label>" +
    "<div id=\"dayRows\"></div>" +
    "<p class=\"muted\">Days are numbered 1 through N. Date and a short label (Mon, Greenway) are optional. Officers tap the days in the order they want them.</p>" +
    "</div>" +
    "<label>Interest window (minutes)<input name=\"windowMinutes\" type=\"number\" min=\"1\" value=\"20\"/></label>" +
    "<p class=\"muted\">Officers with a phone on file get a text with this shift and the interest link. The shift is still created if texts cannot be sent.</p>" +
    "<button type=\"submit\" class=\"btn primary\">Create and get link</button></form>" +
    "<script>(function(){" +
    "var box=document.getElementById('multiDay'),wrap=document.getElementById('multiFields'),count=document.getElementById('dayCount'),rows=document.getElementById('dayRows');" +
    "if(!box||!wrap||!count||!rows)return;" +
    "function esc(s){return String(s).replace(/&/g,'&amp;').replace(/\"/g,'&quot;').replace(/</g,'&lt;');}" +
    "function val(name){var el=rows.querySelector('[name=\"'+name+'\"]');return el?el.value:'';}" +
    "function build(){var n=Math.max(2,Math.min(60,parseInt(count.value,10)||5));count.value=String(n);var keep={};" +
    "for(var i=1;i<=60;i++)keep[i]={date:val('dayDate'+i),label:val('dayLabel'+i)};var html='';" +
    "for(var d=1;d<=n;d++){html+='<div class=\"day-edit\"><div class=\"badge\">Day '+d+'</div><div class=\"row\">'+" +
    "'<input type=\"date\" name=\"dayDate'+d+'\" value=\"'+esc(keep[d].date||'')+'\" aria-label=\"Day '+d+' date\"/>'+" +
    "'<input name=\"dayLabel'+d+'\" maxlength=\"40\" placeholder=\"Label\" value=\"'+esc(keep[d].label||'')+'\" aria-label=\"Day '+d+' label\"/>'+" +
    "'</div></div>';}rows.innerHTML=html;}" +
    "function sync(){wrap.hidden=!box.checked;if(box.checked)build();}" +
    "box.addEventListener('change',sync);count.addEventListener('input',function(){if(box.checked)build();});sync();" +
    "})();</script></section>" +
    "<section class=\"card\"><h2>Shifts</h2>" +
    (shifts.length
      ? "<div class=\"table-wrap\"><table><thead><tr><th>Title</th><th>Status</th><th>Interest</th><th>Closes</th></tr></thead><tbody>" +
        rows + "</tbody></table></div>"
      : "<p class=\"muted\">No shifts yet.</p>") +
    "</section>" + awardsSection() +
    "<section class=\"card\" id=\"roster\"><h2>Rotation (top = waiting longest)</h2>" +
    savedNote +
    "<p class=\"muted\">Optional phone for each officer. Blank skips that person when a shift is texted out. A US 10-digit number is saved as +1.</p>" +
    "<ol class=\"roster\">" + roster + "</ol></section>";
  return layout("Admin", body, null, { logout: true });
}

function isMulti(shift) {
  return !!(shift && Array.isArray(shift.days) && shift.days.length > 1);
}

function dayMeta(shift, n) {
  return ((shift && shift.days) || []).find((d) => Number(d.n) === Number(n)) || { n: Number(n), date: "", label: "" };
}

function dayHeading(shift, n) {
  const d = dayMeta(shift, n);
  const bits = ["Day " + d.n];
  if (d.label) bits.push(d.label);
  if (d.date) bits.push(fmtIsoDate(d.date));
  return bits.join(" · ");
}

function dayShort(shift, n) {
  const d = dayMeta(shift, n);
  const bits = ["Day " + d.n];
  if (d.label) bits.push(d.label);
  else if (d.date) bits.push(fmtIsoDate(d.date));
  return bits.join(" · ");
}

function cancelDayForm(shiftId, day) {
  return "<form method=\"POST\" action=\"/admin/shift/" + esc(shiftId) +
    "/cancel\" class=\"inline-form\" onsubmit=\"return confirm('Cancel this day? If it is their last day from this round, their list spot is restored.');\">" +
    "<input type=\"hidden\" name=\"day\" value=\"" + esc(String(day)) + "\"/>" +
    "<button type=\"submit\" class=\"btn danger\">Cancel day " + esc(String(day)) + "</button></form>";
}

function awardsSection() {
  const awards = db.listRecentAwards();
  if (!awards.length) {
    return "<section class=\"card\"><h2>Recent awards (14 days)</h2>" +
      "<p class=\"muted\">No awards in the restore window yet.</p></section>";
  }
  const rows = awards.map((a) => renderAwardRow(a)).join("");
  return "<section class=\"card\"><h2>Recent awards (14 days)</h2>" +
    "<p class=\"muted\">Cancel within 14 days to put the officer back where they were on the list. On a multi-day job, cancelling one day leaves their other days in place until the last day from that round is cancelled.</p>" +
    "<ul class=\"award-list\">" + rows + "</ul></section>";
}

function renderAwardRow(a) {
  const shift = db.getShift(a.shiftId);
  const multi = Array.isArray(a.days);
  if (!multi) {
    let action;
    if (a.status === "cancelled") {
      action = "<span class=\"pill cancelled\">cancelled</span> · restored";
    } else if (a.canRestore) {
      action = "<form method=\"POST\" action=\"/admin/shift/" + esc(a.shiftId) +
        "/cancel\" class=\"inline-form\" onsubmit=\"return confirm('Cancel this award and restore prior list spot?');\">" +
        "<button type=\"submit\" class=\"btn danger\">Cancel / restore</button></form>";
    } else {
      action = "<span class=\"muted\">" + esc(a.restoreBlockedReason || "Restore unavailable") + "</span>";
    }
    return "<li class=\"award-row\"><div><strong>" + esc(a.shiftTitle) + "</strong> " +
      (a.whenText ? "<span class=\"muted\">" + esc(a.whenText) + "</span> " : "") +
      "<br/><span class=\"badge\">#" + esc(a.badge) + "</span> " + esc(a.name) +
      " · " + esc(fmtTime(a.awardedAt)) +
      (a.canRestore && a.daysLeft != null ? " · <span class=\"muted\">" + a.daysLeft + "d left</span>" : "") +
      "</div><div class=\"award-actions\">" + action + "</div></li>";
  }
  const active = Array.isArray(a.days) ? a.days : [];
  const dropped = Array.isArray(a.cancelledDays) ? a.cancelledDays : [];
  const lines = active.map((n) => {
    const action = a.status === "cancelled"
      ? ""
      : (a.canRestore
        ? cancelDayForm(a.shiftId, n)
        : "<span class=\"muted\">" + esc(a.restoreBlockedReason || "Restore unavailable") + "</span>");
    return "<div class=\"award-day\"><span>" + esc(dayHeading(shift, n)) + "</span> " + action + "</div>";
  }).join("");
  const droppedLine = dropped.length
    ? "<p class=\"muted\">Cancelled day" + (dropped.length > 1 ? "s" : "") + ": " +
      dropped.map((n) => esc(String(n))).join(", ") + "</p>"
    : "";
  const state = a.status === "cancelled"
    ? "<span class=\"pill cancelled\">cancelled</span> " + (a.restored ? "· restored" : "")
    : "";
  return "<li class=\"award-row\"><div><strong>" + esc(a.shiftTitle) + "</strong> " +
    (a.whenText ? "<span class=\"muted\">" + esc(a.whenText) + "</span> " : "") +
    state +
    "<br/><span class=\"badge\">#" + esc(a.badge) + "</span> " + esc(a.name) +
    (a.round ? " · round " + esc(String(a.round)) : "") +
    " · " + esc(fmtTime(a.awardedAt)) +
    (a.canRestore && a.daysLeft != null ? " · <span class=\"muted\">" + a.daysLeft + "d left</span>" : "") +
    droppedLine + lines +
    "</div></li>";
}



function roundBlurb(shift) {
  const r = Number(shift.fillRound) || 1;
  if (shift.status === "awarded") return "Awarded. Each officer who received a day this round was moved to the bottom once, using the list order from the start of that round.";
  if (shift.status === "cancelled") return "Cancelled.";
  if (r <= 1) return "Round 1. Walk the list from the top. Each officer gets their highest-ranked day that is still open. One day per officer.";
  if (r === 2) return "Round 2, the second request. Unfilled days are open again. Officers who already have a day on this job are not eligible yet.";
  return "Round 3. Days were still open after the second request. Anyone who ranked an open day can take it, including officers who already have a day. One extra day per pass, top of the list first, until nothing else fits.";
}

function adminMultiShiftPage(info, baseUrl) {
  const shift = info.shift;
  const interests = (info.interests || []).slice();
  const order = new Map(db.getRoster().map((o, i) => [o.badge, i]));
  interests.sort((a, b) => (order.get(a.badge) - order.get(b.badge)) || 0);
  const link = baseUrl + "/s/" + shift.id;
  const smsHtml = smsNote(shift.sms) + smsNote(shift.resendSms);
  const assignments = shift.assignments || {};
  const proposal = info.proposal || [];
  const proposalByDay = {};
  proposal.forEach((p) => { proposalByDay[p.day] = p; });
  const recent = db.listRecentAwards({ horizonMs: db.RESTORE_WINDOW_MS * 2 });
  const dayRows = shift.days.slice().sort((a, b) => a.n - b.n).map((d) => {
    const slot = assignments[String(d.n)] || assignments[d.n];
    const proposed = proposalByDay[d.n];
    let who;
    let action = "";
    if (slot && slot.badge) {
      who = "<strong>#" + esc(slot.badge) + " " + esc(slot.name) + "</strong> <span class=\"muted\">round " + esc(String(slot.round || "")) + "</span>";
      const award = recent.find((a) => a.shiftId === shift.id && a.status === "active" && Array.isArray(a.days) && a.days.some((n) => Number(n) === d.n));
      if (award && award.canRestore) action = cancelDayForm(shift.id, d.n);
      else if (award) action = "<span class=\"muted\">" + esc(award.restoreBlockedReason || "Restore unavailable") + "</span>";
    } else if (proposed && (shift.status === "open" || shift.status === "closed")) {
      who = "<span class=\"winner\">Proposed #" + esc(proposed.badge) + " " + esc(proposed.name) + "</span>";
    } else {
      who = "<span class=\"muted\">Unfilled</span>";
    }
    return "<div class=\"proposal-row\"><div>" + esc(dayHeading(shift, d.n)) + "</div><div>" + who + "</div><div class=\"award-actions\">" + action + "</div></div>";
  }).join("");
  const interestRows = interests.map((i) => {
    const ranks = Array.isArray(i.ranks) && i.ranks.length ? i.ranks.join(" → ") : "";
    return "<li><span class=\"badge\">#" + esc(i.badge) + "</span> " + esc(i.name) +
      (ranks ? " <span class=\"muted\">wants " + esc(ranks) + "</span>" : "") +
      " <span class=\"muted\">" + esc(fmtTime(i.at)) + "</span></li>";
  }).join("");
  const canConfirm = proposal.length > 0 || (shift.status === "closed" && (Number(shift.fillRound) || 1) >= 2 && (info.unfilled || []).length > 0);
  let awardBlock = "<p class=\"muted\">" + esc(roundBlurb(shift)) + "</p>" +
    "<div class=\"proposal\">" + dayRows + "</div>";
  if (shift.status === "awarded") {
    awardBlock += smsNote(shift.awardSms) + "<p class=\"muted\">Confirm moved each awarded officer to the bottom once for that round.</p>";
  } else if (shift.status === "cancelled") {
    awardBlock += "<p class=\"banner\">Award cancelled" + (shift.cancelledAt ? " · " + esc(fmtTime(shift.cancelledAt)) : "") + "</p>";
  } else {
    const buttons = (shift.status === "open"
      ? "<form method=\"POST\" action=\"/admin/shift/" + esc(shift.id) + "/close\"><button class=\"btn\">Close window now</button></form>"
      : "") +
      (canConfirm
        ? "<form method=\"POST\" action=\"/admin/shift/" + esc(shift.id) + "/award\"><button class=\"btn primary\" type=\"submit\">Confirm award</button></form>"
        : "");
    if (!proposal.length && shift.status !== "awarded") {
      awardBlock += "<p class=\"muted\">No matching requests for this round yet.</p>";
    }
    if (shift.resendCount) {
      awardBlock += "<p class=\"muted\">Still-open text sent " + esc(String(shift.resendCount)) + " time(s)." +
        (shift.status === "open" ? " A new interest window is open." : " The window is now closed.") + "</p>";
    }
    if (buttons) awardBlock += "<div class=\"row\">" + buttons + "</div>";
    awardBlock += smsNote(shift.awardSms);
  }
  const body =
    "<section class=\"card\"><h1>" + esc(shift.title) + "</h1>" +
    "<p class=\"meta\">" + esc(String(shift.days.length)) + "-day job" +
    (whenLine(shift) !== "-" ? " · " + esc(whenLine(shift)) : "") +
    (shift.location ? " · " + esc(shift.location) : "") + "</p>" +
    (shift.notes ? "<p>" + esc(shift.notes) + "</p>" : "") +
    "<p><span class=\"pill " + esc(shift.status) + "\">" + esc(shift.status) +
    "</span> · round " + esc(String(shift.fillRound || 1)) +
    " · " + esc(String(shift.windowMinutes)) + " min · closes " +
    esc(fmtTime(shift.closesAt)) +
    (shift.status === "open" ? " · <strong>" + esc(remaining(shift.closesAt)) + "</strong> left" : "") +
    (shift.status === "open" && shift.resendCount ? " · still open, window restarted" : "") +
    "</p>" + smsHtml + "<label class=\"share\">Shareable link<div class=\"row\">" +
    "<input id=\"link\" readonly value=\"" + esc(link) + "\"/>" +
    "<button type=\"button\" class=\"btn\" id=\"copyBtn\">Copy</button></div></label></section>" +
    "<section class=\"card\"><h2>Days</h2>" + awardBlock + "</section>" +
    "<section class=\"card\"><h2>Interested (" + interests.length + ")</h2>" +
    "<p class=\"muted\">Numbers are preference order. 1 → 3 → 5 means day 1 first, then 3, then 5.</p>" +
    (interests.length ? "<ul class=\"list\">" + interestRows + "</ul>" : "<p class=\"muted\">Nobody yet.</p>") +
    "</section>" +
    "<script>var b=document.getElementById('copyBtn');if(b)b.onclick=function(){navigator.clipboard.writeText(document.getElementById('link').value);b.textContent='Copied';};" +
    (shift.status === "open" ? "setTimeout(function(){location.reload()},15000);" : "") + "</script>";
  return layout(shift.title, body, "/", { logout: true });
}

function adminShiftPage(id, baseUrl) {
  const info = db.suggestWinner(id);
  if (info.error) return null;
  if (info.multi) return adminMultiShiftPage(info, baseUrl);
  const { shift, interests, suggestion } = info;
  const link = baseUrl + "/s/" + shift.id;
  const smsHtml = smsNote(shift.sms) + smsNote(shift.resendSms);
  const interestRows = interests.map((i) =>
    "<li><span class=\"badge\">#" + esc(i.badge) + "</span> " + esc(i.name) +
    " <span class=\"muted\">" + esc(fmtTime(i.at)) + "</span></li>"
  ).join("");
  let awardBlock;
  if (shift.status === "awarded") {
    const awards = db.listRecentAwards({ horizonMs: db.RESTORE_WINDOW_MS * 2 });
    const mine = awards.find((a) => a.shiftId === shift.id) || null;
    let cancelBit = "";
    if (mine && mine.canRestore) {
      cancelBit = "<form method=\"POST\" action=\"/admin/shift/" + esc(shift.id) +
        "/cancel\" onsubmit=\"return confirm('Cancel award and restore prior list spot?');\">" +
        "<button type=\"submit\" class=\"btn danger\">Cancel award / restore list spot</button></form>" +
        "<p class=\"muted\">Within 14 days — puts them back where they were before this award.</p>";
    } else if (mine) {
      cancelBit = "<p class=\"banner\">" + esc(mine.restoreBlockedReason || "Restore unavailable") + "</p>";
    } else {
      cancelBit = "<p class=\"muted\">No restore snapshot for this award.</p>";
    }
    awardBlock = "<p class=\"winner\">Awarded to <strong>#" + esc(shift.winnerBadge) + " " +
      esc(shift.winnerName) + "</strong> · " + esc(fmtTime(shift.awardedAt)) +
      "</p><p class=\"muted\">Winner moved to bottom of rotation.</p>" +
      smsNote(shift.awardSms) + cancelBit;
  } else if (shift.status === "cancelled") {
    awardBlock = "<p class=\"banner\">Award cancelled" +
      (shift.cancelledAt ? " · " + esc(fmtTime(shift.cancelledAt)) : "") +
      "</p><p>Previously awarded to <strong>#" + esc(shift.winnerBadge) + " " +
      esc(shift.winnerName) + "</strong>. Officer restored to prior list position.</p>";
  } else if (suggestion) {
    awardBlock = "<p>Suggested: <strong class=\"winner\">#" + esc(suggestion.badge) + " " +
      esc(suggestion.name) + "</strong></p><div class=\"row\">" +
      (shift.status === "open"
        ? "<form method=\"POST\" action=\"/admin/shift/" + esc(shift.id) +
          "/close\"><button class=\"btn\">Close window now</button></form>"
        : "") +
      "<form method=\"POST\" action=\"/admin/shift/" + esc(shift.id) +
      "/award\"><button class=\"btn primary\" type=\"submit\">Confirm award</button></form></div>";
  } else {
    const resendNote = shift.resendCount
      ? "<p class=\"muted\">Still-open text sent " + esc(String(shift.resendCount)) +
        " time(s)." + (shift.status === "closed" ? " The window is now closed." : " A new interest window is open.") + "</p>"
      : "";
    awardBlock = "<p class=\"muted\">No interested officers yet.</p>" + resendNote +
      (shift.status === "open"
        ? "<form method=\"POST\" action=\"/admin/shift/" + esc(shift.id) +
          "/close\"><button class=\"btn\">Close window now</button></form>"
        : "");
  }
  const body =
    "<section class=\"card\"><h1>" + esc(shift.title) + "</h1>" +
    "<p class=\"meta\">" + esc(whenLine(shift)) +
    (shift.location ? " · " + esc(shift.location) : "") + "</p>" +
    (shift.notes ? "<p>" + esc(shift.notes) + "</p>" : "") +
    "<p><span class=\"pill " + esc(shift.status) + "\">" + esc(shift.status) +
    "</span> · " + esc(String(shift.windowMinutes)) + " min · closes " +
    esc(fmtTime(shift.closesAt)) +
    (shift.status === "open" ? " · <strong>" + esc(remaining(shift.closesAt)) + "</strong> left" : "") +
    (shift.status === "open" && shift.resendCount ? " · still open, window restarted" : "") +
    "</p>" + smsHtml + "<label class=\"share\">Shareable link<div class=\"row\">" +
    "<input id=\"link\" readonly value=\"" + esc(link) + "\"/>" +
    "<button type=\"button\" class=\"btn\" id=\"copyBtn\">Copy</button></div></label></section>" +
    "<section class=\"card\"><h2>Interested (" + interests.length + ")</h2>" +
    (interests.length ? "<ul class=\"list\">" + interestRows + "</ul>" : "<p class=\"muted\">Nobody yet.</p>") +
    "</section><section class=\"card\"><h2>Award</h2>" + awardBlock + "</section>" +
    "<script>var b=document.getElementById('copyBtn');if(b)b.onclick=function(){navigator.clipboard.writeText(document.getElementById('link').value);b.textContent='Copied';};" +
    (shift.status === "open" ? "setTimeout(function(){location.reload()},15000);" : "") + "</script>";
  return layout(shift.title, body, "/", { logout: true });
}

function smsNote(summary) {
  if (!summary || !summary.note) return "";
  const cls = !summary.configured || summary.failed ? "banner" : "sms-ok";
  const fails = summary.failures && summary.failures.length
    ? "<ul class=\"list\">" + summary.failures.map((f) =>
      "<li>#" + esc(f.badge) + " " + esc(f.name) + " — " + esc(f.error) + "</li>"
    ).join("") + "</ul>"
    : "";
  return "<div class=\"sms-note\"><p class=\"" + cls + "\">" + esc(summary.note || "") + "</p>" + fails + "</div>";
}

function officerPage(id) {
  const shift = db.getShift(id);
  if (!shift) return null;
  if (shift.status === "open" && Date.now() > shift.closesAt) db.rollInterestWindow(id);
  const current = db.getShift(id);
  const roster = db.getRoster().slice().sort((a, b) => a.name.localeCompare(b.name) || String(a.badge).localeCompare(String(b.badge)));
  const interests = db.getInterests(id);
  if (isMulti(current)) return officerMultiPage(id, current, roster, interests);
  const taken = new Set(interests.map((i) => i.badge));
  const options = roster.map((o) =>
    "<option value=\"" + esc(o.badge) + "\"" + (taken.has(o.badge) ? " disabled" : "") +
    ">#" + esc(o.badge) + " " + esc(o.name) + (taken.has(o.badge) ? " (already in)" : "") + "</option>"
  ).join("");
  const interested = interests.slice().sort((a, b) =>
    a.name.localeCompare(b.name) || String(a.badge).localeCompare(String(b.badge))
  );
  let action;
  if (current.status !== "open") {
    action = "<p class=\"banner\">Interest window is closed. It is too late to withdraw.</p>" +
      (current.status === "awarded"
        ? "<p class=\"winner\">Awarded to #" + esc(current.winnerBadge) + " " + esc(current.winnerName) + "</p>"
        : current.status === "cancelled"
          ? "<p class=\"banner\">This award was cancelled.</p>"
          : "<p class=\"muted\">" + interests.length + " officer(s) marked interested.</p>");
  } else {
    const withdraw = interested.length
      ? "<div class=\"withdraw\"><h2>Withdraw interest</h2>" +
        "<p class=\"muted\">Already tapped in? Remove yourself before this shift is awarded. You will not be considered.</p>" +
        "<form method=\"POST\" action=\"/s/" + esc(id) + "/withdraw\" class=\"stack\">" +
        "<label>Your badge / name<select name=\"badge\" required><option value=\"\">Select...</option>" +
        interested.map((i) =>
          "<option value=\"" + esc(i.badge) + "\">#" + esc(i.badge) + " " + esc(i.name) + "</option>"
        ).join("") +
        "</select></label>" +
        "<button type=\"submit\" class=\"btn danger big\">Withdraw interest</button></form></div>"
      : "";
    const reopened = current.resendCount
      ? "<p class=\"timer\">Still open. A new interest window is running.</p>"
      : "";
    action = reopened + "<p class=\"timer\">Time left: <strong>" + esc(remaining(current.closesAt)) + "</strong></p>" +
      "<form method=\"POST\" action=\"/s/" + esc(id) + "/interest\" class=\"stack\">" +
      "<label>Your badge / name<select name=\"badge\" required><option value=\"\">Select...</option>" +
      options + "</select></label>" +
      "<button type=\"submit\" class=\"btn primary big\">I am interested</button></form>" +
      withdraw;
  }
  const body = "<section class=\"card hero\"><h1>" + esc(current.title) + "</h1>" +
    "<p class=\"meta\">" + esc(whenLine(current) === "-" ? "" : whenLine(current)) + "</p>" +
    (current.location ? "<p>" + esc(current.location) + "</p>" : "") +
    (current.notes ? "<p class=\"notes\">" + esc(current.notes) + "</p>" : "") +
    action + "</section><p class=\"fine muted\">Tinton Falls PD · Off Duty · v1</p>";
  return layout(current.title, body);
}

function fmtIsoDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = String(iso).split("-").map(Number);
  return months[m - 1] + " " + d + ", " + y;
}

function whenLine(shift) {
  if (!shift) return "-";
  const parts = [];
  if (shift.whenDate) parts.push(fmtIsoDate(shift.whenDate));
  if (shift.whenText) parts.push(shift.whenText);
  return parts.join(" · ") || "-";
}

function weekWarning(jobs) {
  if (!jobs || !jobs.length) return "";
  const items = jobs.map((j) => {
    const bits = [j.title || "Off Duty"];
    if (j.whenText) bits.push(j.whenText);
    if (j.whenDate) bits.push(fmtIsoDate(j.whenDate));
    return "<li>" + esc(bits.join(" · ")) + "</li>";
  }).join("");
  const lead = jobs.length === 1 ? "an Off Duty job" : jobs.length + " Off Duty jobs";
  return "<div class=\"banner week-warn\"><p><strong>You already have " + lead +
    " this week.</strong> Maybe leave this one so others get a turn.</p><ul class=\"list\">" +
    items + "</ul><p>You are still in. This is only a reminder.</p></div>";
}

function officerMultiPage(id, current, roster, interests) {
  const taken = new Set(interests.map((i) => i.badge));
  const options = roster.map((o) =>
    "<option value=\"" + esc(o.badge) + "\">#" + esc(o.badge) + " " + esc(o.name) +
    (taken.has(o.badge) ? " (change days)" : "") + "</option>"
  ).join("");
  const interested = interests.slice().sort((a, b) =>
    a.name.localeCompare(b.name) || String(a.badge).localeCompare(String(b.badge))
  );
  const assigned = current.assignments || {};
  const dayButtons = current.days.slice().sort((a, b) => a.n - b.n).map((d) => {
    const slot = assigned[String(d.n)] || assigned[d.n];
    const locked = !!(slot && slot.badge);
    const label = dayShort(current, d.n) + (locked ? " · taken" : "");
    return "<button type=\"button\" class=\"day-btn" + (locked ? " taken" : "") + "\" data-day=\"" + esc(String(d.n)) + "\"" +
      (locked ? " disabled" : "") + " aria-pressed=\"false\">" +
      "<span class=\"day-rank\"></span><span class=\"day-label\">" + esc(label) + "</span></button>";
  }).join("");
  const awardedList = "<ul class=\"list day-status\">" + current.days.slice().sort((a, b) => a.n - b.n).map((d) => {
    const slot = assigned[String(d.n)] || assigned[d.n];
    const who = slot && slot.badge ? "taken by #" + slot.badge + " " + slot.name : "Open";
    return "<li>" + esc(dayHeading(current, d.n)) + " — " + esc(who) + "</li>";
  }).join("") + "</ul>";
  let action;
  if (current.status !== "open") {
    action = "<p class=\"banner\">Interest window is closed. It is too late to withdraw.</p>" +
      awardedList +
      (current.status === "awarded"
        ? "<p class=\"winner\">Days awarded.</p>"
        : current.status === "cancelled"
          ? "<p class=\"banner\">This award was cancelled.</p>"
          : "<p class=\"muted\">" + interests.length + " officer(s) marked interested.</p>");
  } else {
    const withdraw = interested.length
      ? "<div class=\"withdraw\"><h2>Withdraw interest</h2>" +
        "<p class=\"muted\">Remove yourself before this round is awarded and you will not be considered. A day already awarded to you stays awarded.</p>" +
        "<form method=\"POST\" action=\"/s/" + esc(id) + "/withdraw\" class=\"stack\">" +
        "<label>Your badge / name<select name=\"badge\" required><option value=\"\">Select...</option>" +
        interested.map((i) =>
          "<option value=\"" + esc(i.badge) + "\">#" + esc(i.badge) + " " + esc(i.name) + "</option>"
        ).join("") +
        "</select></label>" +
        "<button type=\"submit\" class=\"btn danger big\">Withdraw interest</button></form></div>"
      : "";
    const reopened = current.resendCount
      ? "<p class=\"timer\">Still open. A new interest window is running.</p>"
      : "";
    const roundNote = (Number(current.fillRound) || 1) >= 2
      ? "<p class=\"muted\">Unfilled days only. If you already have a day, you will not get another one in this round. Submit an order anyway if you want it saved for a later round.</p>"
      : "<p class=\"muted\">Tap days in the order you want them. The first tap is your first choice. You can get one day this round.</p>";
    action = reopened + awardedList +
      "<p class=\"timer\">Time left: <strong>" + esc(remaining(current.closesAt)) + "</strong></p>" +
      roundNote +
      "<form method=\"POST\" action=\"/s/" + esc(id) + "/interest\" class=\"stack\" id=\"dayForm\">" +
      "<label>Your badge / name<select name=\"badge\" required><option value=\"\">Select...</option>" +
      options + "</select></label>" +
      "<div class=\"day-grid\" id=\"dayGrid\">" + dayButtons + "</div>" +
      "<ol class=\"rank-list\" id=\"rankList\"><li class=\"muted\">Tap days in the order you want them.</li></ol>" +
      "<label>Preference order<input name=\"ranks\" id=\"ranks\" inputmode=\"numeric\" autocomplete=\"off\" placeholder=\"1, 3, 5, 4\" required/></label>" +
      "<p class=\"muted\">That box is the order that will be saved. 1, 3, 5, 4 means day 1 first, then 3, then 5, then 4. Use Up and Down to edit it.</p>" +
      "<button type=\"submit\" class=\"btn primary big\">Submit day order</button></form>" +
      withdraw + dayPickerScript(interests);
  }
  const body = "<section class=\"card hero\"><h1>" + esc(current.title) + "</h1>" +
    "<p class=\"meta\">" + esc(String(current.days.length)) + "-day job" +
    (whenLine(current) === "-" ? "" : " · " + esc(whenLine(current))) + "</p>" +
    (current.location ? "<p>" + esc(current.location) + "</p>" : "") +
    (current.notes ? "<p class=\"notes\">" + esc(current.notes) + "</p>" : "") +
    action + "</section><p class=\"fine muted\">Tinton Falls PD · Off Duty · v1</p>";
  return layout(current.title, body);
}

function dayPickerScript(interests) {
  const map = {};
  interests.forEach((i) => {
    if (Array.isArray(i.ranks) && i.ranks.length) map[String(i.badge)] = i.ranks.map((n) => String(n));
  });
  const data = JSON.stringify(map).replace(/</g, "\\u003c");
  return "<script>(function(){" +
    "var input=document.getElementById('ranks');" +
    "var buttons=[].slice.call(document.querySelectorAll('[data-day]'));" +
    "var list=document.getElementById('rankList');" +
    "var existing=" + data + ";" +
    "function allowed(n){var b=document.querySelector('[data-day=\"'+n+'\"]');return !!(b&&!b.disabled);}" +
    "function parse(){var seen={},out=[];String(input.value||'').split(/[^0-9]+/).forEach(function(p){if(!p)return;var n=String(Number(p));if(seen[n]||!allowed(n))return;seen[n]=1;out.push(n);});return out;}" +
    "function write(nums){input.value=nums.join(', ');paint(nums);}" +
    "function paint(nums){var pos={};nums.forEach(function(n,i){pos[n]=i+1;});" +
    "buttons.forEach(function(b){var n=b.getAttribute('data-day');var on=!!pos[n];b.classList.toggle('on',on);b.setAttribute('aria-pressed',on?'true':'false');var bubble=b.querySelector('.day-rank');if(bubble)bubble.textContent=on?String(pos[n]):'';});" +
    "if(!list)return;list.textContent='';if(!nums.length){var empty=document.createElement('li');empty.className='muted';empty.textContent='Tap days in the order you want them. First tap is your first choice.';list.appendChild(empty);return;}" +
    "nums.forEach(function(n,i){var li=document.createElement('li');var label=document.querySelector('[data-day=\"'+n+'\"] .day-label');var text=document.createElement('span');text.textContent=(i+1)+'. '+(label?label.textContent:('Day '+n));li.appendChild(text);" +
    "[['Up','-1'],['Down','1'],['Remove','0']].forEach(function(pair){var b=document.createElement('button');b.type='button';b.className='btn';b.setAttribute('data-move',pair[1]);b.setAttribute('data-n',n);b.textContent=pair[0];li.appendChild(b);});list.appendChild(li);});}" +
    "buttons.forEach(function(b){b.addEventListener('click',function(){if(b.disabled)return;var n=b.getAttribute('data-day');var nums=parse();var i=nums.indexOf(n);if(i>=0)nums.splice(i,1);else nums.push(n);write(nums);});});" +
    "if(list)list.addEventListener('click',function(e){var t=e.target;if(!t.getAttribute)return;var move=t.getAttribute('data-move');if(move==null)return;var n=t.getAttribute('data-n');var nums=parse();var i=nums.indexOf(n);if(i<0)return;if(move==='0')nums.splice(i,1);else{var j=i+Number(move);if(j<0||j>=nums.length)return;var tmp=nums[j];nums[j]=nums[i];nums[i]=tmp;}write(nums);});" +
    "input.addEventListener('input',function(){paint(parse());});" +
    "var sel=document.querySelector('#dayForm select[name=badge]');" +
    "function load(){if(!sel)return;var saved=existing[sel.value];if(saved&&saved.length)write(saved.filter(allowed));else write([]);}" +
    "if(sel)sel.addEventListener('change',load);paint(parse());" +
    "})();</script>";
}

function thanksPage(interest, shiftId, sameWeek, opts) {
  opts = opts || {};
  const shift = db.getShift(shiftId);
  const multi = isMulti(shift) && Array.isArray(interest.ranks) && interest.ranks.length;
  const order = multi ? interest.ranks.join(" → ") : "";
  const lead = multi
    ? "#" + esc(interest.badge) + " " + esc(interest.name) + " asked for days " + esc(order) + " in that order."
    : "#" + esc(interest.badge) + " " + esc(interest.name) + " marked interested.";
  const rule = multi
    ? "Days are handed out from the top of the Off Duty list. You get your first choice that is still open, one day this round."
    : "After the window closes, the job goes to whoever is highest on the Off Duty list among those who tapped in.";
  return layout("Thanks",
    "<section class=\"card hero\"><h1>You are in</h1><p>" + lead + "</p>" +
    (opts.updated ? "<p>Day order updated.</p>" : "") +
    weekWarning(sameWeek) +
    "<p class=\"muted\">" + rule + "</p>" +
    "<form method=\"POST\" action=\"/s/" + esc(shiftId) + "/withdraw\" class=\"stack\">" +
    "<input type=\"hidden\" name=\"badge\" value=\"" + esc(interest.badge) + "\"/>" +
    "<button type=\"submit\" class=\"btn danger big\">Withdraw interest</button></form>" +
    "<p class=\"muted\">Changed your mind? Withdraw before the shift is awarded and you will not be considered.</p>" +
    "<p><a class=\"btn\" href=\"/s/" + esc(shiftId) + "\">Back to shift</a></p></section>");
}

function withdrawnPage(interest, shiftId) {
  return layout("Withdrawn",
    "<section class=\"card hero\"><h1>Interest withdrawn</h1><p>#" + esc(interest.badge) + " " +
    esc(interest.name) + " is no longer interested and will not be considered for this shift.</p>" +
    "<p><a class=\"btn\" href=\"/s/" + esc(shiftId) + "\">Back to shift</a></p></section>");
}



function loginPage(opts) {
  opts = opts || {};
  const setup = !!opts.setup;
  const next = opts.next || "/";
  const err = opts.error ? "<p class=\"banner\">" + esc(opts.error) + "</p>" : "";
  const body = "<section class=\"card\"><h1>" + (setup ? "Set admin code" : "Admin login") + "</h1>" +
    err +
    (setup
      ? "<p class=\"muted\">First run — choose a code only you (Dave) know. Officers never see this.</p>"
      : "<p class=\"muted\">Administrator only. Officers use the shareable /s/… link.</p>") +
    "<form method=\"POST\" action=\"" + (setup ? "/setup" : "/login") + "\" class=\"stack\">" +
    (setup ? "" : "<input type=\"hidden\" name=\"next\" value=\"" + esc(next) + "\"/>") +
    "<label>" + (setup ? "New admin code" : "Admin code") +
    "<input name=\"code\" type=\"password\" required minlength=\"4\" autocomplete=\"current-password\"/></label>" +
    (setup ? "<label>Confirm<input name=\"code2\" type=\"password\" required minlength=\"4\"/></label>" : "") +
    "<button type=\"submit\" class=\"btn primary\">" + (setup ? "Save and continue" : "Log in") + "</button></form></section>";
  return layout(setup ? "Setup" : "Login", body);
}

module.exports = { esc, fmtTime, remaining, layout, adminHome, adminShiftPage, officerPage, thanksPage, withdrawnPage, awardsSection, loginPage };
