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
    return "<tr><td><a href=\"/admin/shift/" + esc(s.id) + "\">" + esc(s.title) + "</a></td>" +
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
    "<label>Interest window (minutes)<input name=\"windowMinutes\" type=\"number\" min=\"1\" value=\"20\"/></label>" +
    "<p class=\"muted\">Officers with a phone on file get a text with this shift and the interest link. The shift is still created if texts cannot be sent.</p>" +
    "<button type=\"submit\" class=\"btn primary\">Create and get link</button></form></section>" +
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

function awardsSection() {
  const awards = db.listRecentAwards();
  if (!awards.length) {
    return "<section class=\"card\"><h2>Recent awards (14 days)</h2>" +
      "<p class=\"muted\">No awards in the restore window yet.</p></section>";
  }
  const rows = awards.map((a) => {
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
  }).join("");
  return "<section class=\"card\"><h2>Recent awards (14 days)</h2>" +
    "<p class=\"muted\">Cancel within 14 days to put the officer back where they were on the list.</p>" +
    "<ul class=\"award-list\">" + rows + "</ul></section>";
}



function adminShiftPage(id, baseUrl) {
  const info = db.suggestWinner(id);
  if (info.error) return null;
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

function thanksPage(interest, shiftId, sameWeek) {
  return layout("Thanks",
    "<section class=\"card hero\"><h1>You are in</h1><p>#" + esc(interest.badge) + " " +
    esc(interest.name) + " marked interested.</p>" +
    weekWarning(sameWeek) +
    "<p class=\"muted\">After the window closes, the job goes to whoever is highest on the Off Duty list among those who tapped in.</p>" +
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
