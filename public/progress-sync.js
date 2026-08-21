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

  const style = document.createElement("style");
  style.textContent = `
    #examPickerOverlay{position:fixed;inset:0;background:#000000b0;backdrop-filter:blur(3px);
      display:none;align-items:center;justify-content:center;z-index:9999;padding:16px}
    #examPickerOverlay.open{display:flex}
    #examPickerCard{width:min(420px,100%);background:#1b1d28;border:1px solid #2e3242;border-radius:14px;
      padding:24px;color:#ece8df;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
      box-shadow:0 24px 60px #00000066}
    #examPickerCard h3{font-size:16px;margin:0 0 4px}
    #examPickerCard .sub{font-size:12px;color:#6f7283;margin-bottom:16px}
    .exam-opt{display:block;width:100%;text-align:left;padding:11px 13px;margin-bottom:8px;border-radius:9px;
      background:#0d0e14;border:1px solid #2e3242;color:#ece8df;font-size:13.5px;font-weight:600;cursor:pointer;
      font-family:inherit;transition:border-color .15s,background .15s}
    .exam-opt:hover{border-color:#7c8cf0;background:#161926}
    .exam-opt small{display:block;font-weight:500;color:#6f7283;font-size:11px;margin-top:2px}
    #examCustomRow{display:flex;gap:8px;margin-top:14px}
    #examCustomDate{flex:1;background:#0d0e14;border:1px solid #2e3242;border-radius:8px;color:#ece8df;
      padding:9px 11px;font-size:13px;font-family:inherit;color-scheme:dark}
    #examPickerCard .acts{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
    #examPickerCard button.ghost{background:none;border:1px solid #2e3242;color:#a6a8b6;border-radius:8px;
      padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit}
    #examSaveCustom{background:#7c8cf0;border:none;color:#fff;border-radius:8px;padding:9px 14px;
      font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
  `;
  document.head.appendChild(style);

  const overlay = document.createElement("div");
  overlay.id = "examPickerOverlay";
  overlay.innerHTML = `
    <div id="examPickerCard" role="dialog" aria-modal="true" aria-labelledby="examPickerTitle">
      <h3 id="examPickerTitle">When is your exam?</h3>
      <div class="sub">Your countdown and study pacing follow this date.</div>
      <div id="examOpts"></div>
      <div id="examCustomRow">
        <input id="examCustomDate" type="date" aria-label="Custom exam date">
        <button id="examSaveCustom" type="button">Set</button>
      </div>
      <div class="acts"><button class="ghost" id="examCancel" type="button">Cancel</button></div>
    </div>`;
  document.body.appendChild(overlay);

  const opts = overlay.querySelector("#examOpts");
  for (const d of nextSittings()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "exam-opt";
    b.innerHTML = `${fmt(d)}<small>Official JLPT sitting</small>`;
    b.addEventListener("click", () => commit(toISO(d)));
    opts.appendChild(b);
  }

  const custom = overlay.querySelector("#examCustomDate");
  custom.min = new Date().toISOString().slice(0, 10);
  overlay.querySelector("#examSaveCustom").addEventListener("click", () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(custom.value)) return;
    commit(`${custom.value}T09:00:00`);
  });

  const close = () => overlay.classList.remove("open");
  overlay.querySelector("#examCancel").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });

  function commit(iso) {
    window.__applyExamDate?.(iso);
    window.__pushExamDate?.(iso);
    close();
  }
}

function openPicker() {
  buildPicker();
  document.getElementById("examPickerOverlay")?.classList.add("open");
}
window.__openExamPicker = openPicker;

// The countdown block is the affordance — clicking it sets the date.
function wireCountdown() {
  const block = document.querySelector(".countdown");
  if (!block) return;
  block.style.cursor = "pointer";
  block.title = "Click to set your exam date";
  block.setAttribute("role", "button");
  block.setAttribute("tabindex", "0");
  block.addEventListener("click", openPicker);
  block.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
  });
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
      await setDoc(doc(db, "progress", activeUsername), {
        username:  activeUsername,
        [COURSE]:  readLocal(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } catch (e) { console.warn("[sync] push failed", e); }
  }, 1500);
}

window.__pushProgress = schedulePush;

window.__pushExamDate = async (iso) => {
  if (!activeUsername) return;
  try {
    await setDoc(doc(db, "progress", activeUsername), {
      username:   activeUsername,
      examDates:  { [COURSE]: iso },
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

  // Exam date: remote wins if the student has never set one here.
  const remoteExam = remote.examDates?.[COURSE];
  if (remoteExam && window.__getExamDateISO?.() !== remoteExam) {
    window.__applyExamDate?.(remoteExam);
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
