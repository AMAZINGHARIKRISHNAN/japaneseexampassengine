/**
 * Cross-device sync for the N3/N4 study engines.
 *
 * The engines keep their state in localStorage, which meant progress never
 * followed a student between devices — a real problem now that sign-in is just
 * a name and a date of birth and they are expected to study anywhere. This
 * module mirrors that state into `progress/{username}` and merges it back on
 * load. It also owns the exam-date picker that drives each engine's countdown.
 *
 * Loaded as:
 *   <script type="module" src="progress-sync.js"
 *           data-progress-sync data-course="n3" data-state-key="n3engine.v1"></script>
 *
 * Contract with the engine's classic script (both directions are optional, so
 * the engines still work standalone if this file fails to load):
 *   engine provides  window.__applyExamDate(iso)   apply + redraw countdown
 *   engine provides  window.__getExamDateISO()     currently stored ISO, or ""
 *   engine calls     window.__pushProgress(STATE)  from save()
 *   this module adds window.__pushExamDate(iso)
 */
import { initializeApp, getApps }
  from "https://www.gstatic.com/firebasejs/11.9.0/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/11.9.0/firebase-auth.js";

const firebaseConfig = {
  apiKey:            "AIzaSyCDfc2n8sJfesrIwbWluTmjTnTsl_x46SQ",
  authDomain:        "japanesen3passengine.firebaseapp.com",
  projectId:         "japanesen3passengine",
  storageBucket:     "japanesen3passengine.firebasestorage.app",
  messagingSenderId: "409024055518",
  appId:             "1:409024055518:web:c1e74cb1cf64e50fc25a4f",
  measurementId:     "G-5KH5JW9JX3"
};

const tag       = document.querySelector("script[data-progress-sync]");
const COURSE    = tag?.dataset.course ?? "n3";
const STATE_KEY = tag?.dataset.stateKey ?? `${COURSE}engine.v1`;
const RELOAD_FLAG = `__synced_${COURSE}`;

const app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// ─── Session ────────────────────────────────────────────────────────────────
function currentUsername() {
  try {
    const s = JSON.parse(sessionStorage.getItem("n3_user_session") ?? "null");
    return s?.verified === true && s.username ? s.username : null;
  } catch { return null; }
}

// ─── Exam-date picker ───────────────────────────────────────────────────────
// JLPT sits on the first Sunday of July and of December. A sitting stays
// offerable until the end of its own day, matching the engines' countdown.
const endOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

function nextSittings(count = 4) {
  const out = [];
  const now = new Date();
  for (let y = now.getFullYear(); out.length < count && y <= now.getFullYear() + 3; y++) {
    for (const month of [6, 11]) {
      const d = new Date(y, month, 1, 9, 0, 0);
      d.setDate(1 + ((7 - d.getDay()) % 7));
      if (endOfDay(d) - now > 0 && out.length < count) out.push(d);
    }
  }
  return out;
}

const fmt = d => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric" });
const toISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T09:00:00`;

function buildPicker() {
  if (document.getElementById("examPickerOverlay")) return;

  // Styled from the page's own theme variables (dojo-theme.css), so it
  // follows light/dark like everything else; fallbacks keep it legible alone.
  const style = document.createElement("style");
  style.textContent = `
    #examPickerOverlay{position:fixed;inset:0;background:rgba(10,15,25,.55);backdrop-filter:blur(4px);
      display:none;align-items:center;justify-content:center;z-index:9999;padding:16px}
    #examPickerOverlay.open{display:flex}
    #examPickerCard{width:min(460px,100%);max-height:calc(100dvh - 32px);overflow:auto;background:var(--surface,#fffcfa);
      border:1px solid var(--line,#e3d3d2);border-top:5px solid var(--ai,#6a3d9e);border-radius:16px;padding:22px 22px 18px;
      color:var(--ink,#2a2230);font-family:var(--gothic,system-ui,sans-serif);box-shadow:var(--shadow-h,0 12px 28px rgba(0,0,0,.2))}
    #examPickerCard h3{font-size:19px;margin:0 0 2px;color:var(--ink,#2a2230)}
    #examPickerCard .sub{font-size:13px;color:var(--muted,#665c70);margin-bottom:16px}
    #examPickerCard .sec{font-size:12px;font-weight:700;letter-spacing:.06em;color:var(--ai,#6a3d9e);margin:16px 0 8px}
    #examPickerCard .now{background:var(--ai-soft,#ece1f6);border-radius:10px;padding:9px 12px;font-size:13.5px;margin-bottom:4px}
    .exam-opt{display:block;width:100%;text-align:left;padding:10px 13px;margin-bottom:6px;border-radius:10px;
      background:var(--surface,#fffcfa);border:1px solid var(--line,#e3d3d2);color:var(--ink,#2a2230);font-size:14px;font-weight:700;
      cursor:pointer;font-family:inherit;transition:border-color .15s,background .15s}
    .exam-opt:hover{border-color:var(--ai,#6a3d9e);background:var(--ai-soft,#ece1f6)}
    .exam-opt small{display:block;font-weight:400;color:var(--muted,#665c70);font-size:12px;margin-top:1px}
    #examCustom{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    #examCustom label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:var(--muted,#665c70)}
    #examCustom label.wide{grid-column:1/-1}
    #examCustom input{background:var(--paper,#f7efee);border:1px solid var(--line,#e3d3d2);border-radius:10px;color:var(--ink,#2a2230);
      padding:9px 11px;font-size:15px;font-family:inherit;font-weight:400;min-width:0}
    #examCustom input:focus{outline:none;border-color:var(--ai,#6a3d9e);box-shadow:0 0 0 3px color-mix(in srgb,var(--ai,#6a3d9e) 20%,transparent)}
    #examErr{min-height:18px;font-size:12.5px;color:var(--ume,#9e3557);margin-top:6px}
    #examPickerCard .acts{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
    #examPickerCard .acts div{display:flex;gap:8px;margin-left:auto}
    #examPickerCard button.ghost{background:var(--surface,#fffcfa);border:1px solid var(--line,#e3d3d2);color:var(--ink,#2a2230);border-radius:10px;
      padding:9px 14px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit}
    #examPickerCard button.link{background:none;border:0;color:var(--ai,#6a3d9e);text-decoration:underline;font-size:13px;cursor:pointer;padding:4px 0;font-family:inherit}
    #examPickerCard button.link[hidden]{display:none}
    #examSaveCustom{background:var(--ai,#6a3d9e);border:1px solid var(--ai,#6a3d9e);color:var(--paper,#fff);border-radius:10px;padding:9px 16px;
      font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit}
  `;
  document.head.appendChild(style);

  const level = COURSE.toUpperCase();
  const overlay = document.createElement("div");
  overlay.id = "examPickerOverlay";
  overlay.innerHTML = `
    <div id="examPickerCard" role="dialog" aria-modal="true" aria-labelledby="examPickerTitle">
      <h3 id="examPickerTitle">Set your exam deadline</h3>
      <div class="sub">Your countdown follows this date, on every device you sign in on.</div>
      <div class="now" id="examNow"></div>
      <div class="sec">My own deadline</div>
      <div id="examCustom">
        <label>Date<input id="examCustomDate" type="date"></label>
        <label>Time<input id="examCustomTime" type="time" value="09:00"></label>
        <label class="wide">Name it (optional)<input id="examCustomName" type="text" maxlength="40" placeholder="e.g. School mock exam, My ${level} goal"></label>
      </div>
      <div id="examErr" role="alert"></div>
      <div class="sec">Or an official JLPT ${level} sitting</div>
      <div id="examOpts"></div>
      <div class="acts">
        <button class="link" id="examReset" type="button">Use the next official date</button>
        <div><button class="ghost" id="examCancel" type="button">Cancel</button>
        <button id="examSaveCustom" type="button">Save my deadline</button></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const opts = overlay.querySelector("#examOpts");
  for (const d of nextSittings()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "exam-opt";
    b.innerHTML = `${fmt(d)}<small>Official JLPT sitting</small>`;
    b.addEventListener("click", () => commit(toISO(d), `JLPT ${level}`));
    opts.appendChild(b);
  }

  const date = overlay.querySelector("#examCustomDate");
  const time = overlay.querySelector("#examCustomTime");
  const name = overlay.querySelector("#examCustomName");
  const err  = overlay.querySelector("#examErr");
  overlay.querySelector("#examSaveCustom").addEventListener("click", () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) { err.textContent = "Pick a date first."; date.focus(); return; }
    const t = /^\d{2}:\d{2}$/.test(time.value) ? time.value : "09:00";
    const iso = `${date.value}T${t}:00`;
    if (new Date(iso) - new Date() <= 0) { err.textContent = "That time has already passed. Pick one in the future."; return; }
    commit(iso, name.value.trim().slice(0, 40));
  });
  overlay.querySelector("#examReset").addEventListener("click", () => commit("", ""));

  const close = () => overlay.classList.remove("open");
  overlay.querySelector("#examCancel").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });

  function commit(iso, label) {
    window.__applyExamDate?.(iso, label);
    window.__pushExamDate?.(iso, label);
    close();
  }
}

function openPicker() {
  buildPicker();
  const overlay = document.getElementById("examPickerOverlay");
  if (!overlay) return;
  // Prefill with what is set now, so editing a deadline is one change.
  const iso   = window.__getExamDateISO?.() || "";
  const label = window.__getExamLabel?.() || "";
  const own   = iso && !label.startsWith("JLPT");
  const d     = iso ? new Date(iso) : null;
  const ok    = own && d && !isNaN(d);
  const pad   = n => String(n).padStart(2, "0");
  const date  = overlay.querySelector("#examCustomDate");
  const t0    = new Date();
  date.min = `${t0.getFullYear()}-${pad(t0.getMonth() + 1)}-${pad(t0.getDate())}`;
  date.value = ok ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : "";
  overlay.querySelector("#examCustomTime").value = ok ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "09:00";
  overlay.querySelector("#examCustomName").value = own ? label : "";
  overlay.querySelector("#examErr").textContent = "";
  overlay.querySelector("#examNow").textContent =
    "Now counting down to: " + (document.getElementById("cdLabel")?.textContent.replace(/^until /, "") || "the next JLPT sitting");
  overlay.querySelector("#examReset").hidden = !iso;
  overlay.classList.add("open");
  (ok ? overlay.querySelector("#examSaveCustom") : date).focus();
}
window.__openExamPicker = openPicker;

// The countdown card, and anything marked [data-exam-picker], open the picker.
function wireCountdown() {
  for (const block of document.querySelectorAll(".countdown, [data-exam-picker]")) {
    block.style.cursor = "pointer";
    block.title = "Set your exam deadline";
    if (block.tagName !== "BUTTON") {
      block.setAttribute("role", "button");
      block.setAttribute("tabindex", "0");
      block.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
      });
    }
    block.addEventListener("click", openPicker);
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireCountdown);
} else {
  wireCountdown();
}

// ─── Progress merge ─────────────────────────────────────────────────────────
// Section state is a flat map of id -> truthy "done" flag, so a union is both
// lossless and order-independent: completing something on either device wins,
// and nothing a student has finished is ever un-finished by a sync.
function mergeState(local, remote) {
  const out = { ...local };
  let changed = false;
  for (const [section, remoteSection] of Object.entries(remote ?? {})) {
    if (!remoteSection || typeof remoteSection !== "object" || Array.isArray(remoteSection)) continue;
    const merged = (out[section] && typeof out[section] === "object") ? { ...out[section] } : {};
    for (const [id, value] of Object.entries(remoteSection)) {
      if (value && !merged[id]) { merged[id] = value; changed = true; }
    }
    out[section] = merged;
  }
  return { merged: out, changed };
}

function readLocal() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}"); }
  catch { return {}; }
}

// ─── Push (debounced) ───────────────────────────────────────────────────────
let pushTimer = null;
let activeUsername = null;

function schedulePush() {
  if (!activeUsername) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const payload = {
        username:  activeUsername,
        [COURSE]:  readLocal(),
        updatedAt: serverTimestamp(),
      };
      // The engine publishes its counts together with their totals, so the
      // admin dashboard can show a percentage without knowing anything about
      // how much content each course holds. Absent on a stale tab that has not
      // run refreshProgress() yet, which is why it is written conditionally.
      if (window.__progressSummary) payload.summary = { [COURSE]: window.__progressSummary };
      await setDoc(doc(db, "progress", activeUsername), payload, { merge: true });
    } catch (e) { console.warn("[sync] push failed", e); }
  }, 1500);
}

window.__pushProgress = schedulePush;

window.__pushExamDate = async (iso, label = "") => {
  if (!activeUsername) return;
  try {
    // iso "" means "back to the official date"; it is written (not skipped)
    // so the student's other devices drop their custom deadline too.
    await setDoc(doc(db, "progress", activeUsername), {
      username:   activeUsername,
      examDates:  { [COURSE]: iso ?? "" },
      examLabels: { [COURSE]: label ?? "" },
      updatedAt:  serverTimestamp(),
    }, { merge: true });
  } catch (e) { console.warn("[sync] exam date push failed", e); }
};

// Reset must clear the server copy too. A merged set() cannot empty a nested
// map, so this replaces the whole course field via updateDoc — otherwise the
// next pull would merge the old progress straight back and silently undo the
// reset the student just confirmed.
window.__clearRemoteProgress = async () => {
  clearTimeout(pushTimer);            // don't let a queued push resurrect it
  if (!activeUsername) return;
  try {
    await updateDoc(doc(db, "progress", activeUsername), {
      [COURSE]:  {},
      // Clear the mirrored summary too, or the dashboard would keep reporting
      // the progress the student just deliberately wiped.
      [`summary.${COURSE}`]: null,
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    if (e?.code !== "not-found") console.warn("[sync] remote reset failed", e);
  }
};

// ─── Pull on load ───────────────────────────────────────────────────────────
let pulled = false;

onAuthStateChanged(auth, async (user) => {
  const username = currentUsername();
  // A kept "signed in" flag (session-keep.js) but no Firebase session: the
  // page would show but nothing could load or save, so sign in again.
  if (!user && username) { window.__forgetSession?.(); location.replace("login.html"); return; }
  // Admins previewing the app have no student profile — nothing to sync.
  if (!user || !username) return;
  activeUsername = username;
  // This fires again on token refresh; the pull only needs to happen once.
  if (pulled) return;
  pulled = true;

  let remote;
  try {
    const snap = await getDoc(doc(db, "progress", username));
    remote = snap.exists() ? snap.data() : null;
  } catch (e) {
    console.warn("[sync] pull failed", e);
    return;
  }

  if (!remote) { schedulePush(); return; }   // first device: seed the doc

  // Exam deadline: the copy on the account wins, so a deadline set (or
  // cleared, as "") on one device follows the student to the others.
  const remoteExam  = remote.examDates?.[COURSE];
  const remoteLabel = remote.examLabels?.[COURSE];
  if (remoteExam !== undefined &&
      (remoteExam !== (window.__getExamDateISO?.() || "") ||
       (remoteLabel ?? "") !== (window.__getExamLabel?.() || ""))) {
    window.__applyExamDate?.(remoteExam, remoteLabel ?? "");
  }

  const local = readLocal();
  const { merged, changed } = mergeState(local, remote[COURSE]);
  if (!changed) { schedulePush(); return; }

  // The engines build their whole UI from STATE at parse time and have no
  // re-render entry point that covers every view, so a single reload is the
  // only way to show merged progress without touching their render graphs.
  //
  // If we have already reloaded this session, deliberately leave localStorage
  // alone: the engine's in-memory STATE is older than the merge, and its next
  // save() would write that stale copy back and drop the merged-in items.
  // Firestore holds the union regardless, so the next load still recovers it.
  if (sessionStorage.getItem(RELOAD_FLAG)) { schedulePush(); return; }

  sessionStorage.setItem(RELOAD_FLAG, "1");
  localStorage.setItem(STATE_KEY, JSON.stringify(merged));
  location.reload();
});
