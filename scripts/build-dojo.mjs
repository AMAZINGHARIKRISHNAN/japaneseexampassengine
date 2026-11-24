#!/usr/bin/env node
/**
 * Builds public/dojo/ from the standalone "N3 Dojo" page so its content runs
 * inside the N3 Pass Engine (parts 22–26).
 *
 *   node scripts/build-dojo.mjs ["path/to/N3 Dojo – Kanji, Vocabulary & Grammar.html"]
 *
 * Output:
 *   public/dojo/dojo.css        Dojo's stylesheet, rewritten for a shadow root
 *   public/dojo/dojo-app.js     data + app, exposed as window.N3Dojo.mount(host)
 *   public/dojo/audio/*.mp3     lesson narration, pulled out of base64
 *
 * Dojo was written to own a whole page: it routes on location.hash, styles
 * :root/body, and reaches for `document` everywhere. Pasting it into the
 * engine would collide on both CSS class names (.opt, .btn, .gcard, .dlg …)
 * and globals. So it is mounted in a shadow root, and the script runs inside
 * a function where `document` is a small shim that resolves lookups against
 * that root. Its own code is otherwise untouched apart from the edits below,
 * each of which must match exactly the expected number of times — if the
 * source changes shape the build fails instead of shipping a half-patched app.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, process.argv[2] ?? "N3 Dojo – Kanji, Vocabulary & Grammar.html");
const out = resolve(root, "public/dojo");

const html = readFileSync(src, "utf8");

// The saved file is an artifact shell wrapping the real document.
const innerStart = html.indexOf("<!doctype html>", 10);
if (innerStart < 0) throw new Error("inner document not found");
const inner = html.slice(innerStart);

const cut = (s, a, b, from = 0) => {
  const i = s.indexOf(a, from); if (i < 0) throw new Error(`missing ${a}`);
  const j = s.indexOf(b, i + a.length); if (j < 0) throw new Error(`missing ${b}`);
  return [s.slice(i + a.length, j), j + b.length];
};
const [css] = cut(inner, "<style>", "</style>");
const [bodyAll] = cut(inner, "<body>", "</body>");
const scriptAt = bodyAll.indexOf("<script>");
let markup = bodyAll.slice(0, scriptAt).trim();
let [js] = cut(bodyAll, "<script>", "</script>", scriptAt);

function edit(text, from, to, times = 1, label = from.slice(0, 50)) {
  const n = text.split(from).length - 1;
  if (n !== times) throw new Error(`expected ${times}× but found ${n}×: ${label}`);
  return text.split(from).join(to);
}

/* ---------- audio: base64 → files ---------- */
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, "audio"), { recursive: true });
let clips = 0;
js = js.replace(/"(\d+_\d+)": ?"data:audio\/mpeg;base64,([A-Za-z0-9+/=]+)"/g, (_, key, b64) => {
  writeFileSync(resolve(out, "audio", `${key}.mp3`), Buffer.from(b64, "base64"));
  clips++;
  return `"${key}":"dojo/audio/${key}.mp3"`;
});
if (clips < 50) throw new Error(`only ${clips} audio clips extracted`);
if (/data:audio/.test(js)) throw new Error("audio left inline");

/* ---------- script edits ---------- */
// Claude runtime → our own capability shim (Firestore sync, no AI).
js = edit(js, "window.claude", "DOJO_CL", 7);

// Routing: share the hash with the engine. Dojo's home becomes #dojo, and the
// router ignores hashes that belong to the engine's own parts. #path and
// #lesson were missing from VIEWS in the original, which made the lesson path
// unreachable (both fell back to the home screen); they are added here.
js = edit(js,
  'const VIEWS=["parts","review","kanji","vocab","grammar","practice","quiz","match","write","build","sentences","roleplay","exam","notebook","work"];',
  'const VIEWS=["parts","review","kanji","vocab","grammar","practice","quiz","match","write","build","sentences","exam","notebook","work","path","lesson"];');
js = edit(js,
  'const h=location.hash.slice(1);\n  view=VIEWS.includes(h)?h:"home";',
  'let h=location.hash.slice(1);if(!DOJO_OWNS(h))return;if(h==="roleplay")h="practice";\n  view=VIEWS.includes(h)?h:"home";if(view==="lesson"&&LS.id==null)view="path";');
js = edit(js, 'location.hash="#"', 'location.hash="#dojo"', 1);
js = edit(js, 'href="#"', 'href="#dojo"', js.split('href="#"').length - 1);
markup = markup.split('href="#"').join('href="#dojo"');

// Hide the AI features: role-play and story generation need Claude, which a
// page on Firebase cannot reach. Hand-written stories and "Write my own" stay.
js = edit(js, 'const RP={sc:null,turns:[],busy:false,avail:null,', 'const RP={sc:null,turns:[],busy:false,avail:false,');
js = edit(js, '["roleplay","話","Workplace role-play","Keigo with AI feedback"],', '');
js = edit(js, '["Work Japanese",["work","roleplay"]]', '["Work Japanese",["work"]]');
js = edit(js,
  'for the rest, tap “Create a story” and Claude writes one for you.',
  'for the rest, tap “Write my own” and keep your own.');
js = edit(js, '"Progress synced to your Claude account."', '"Progress synced to your account."');
js = edit(js, "Try a practice game or role-play.", "Try a practice game or a quiz.");
js = edit(js, "Write kanji, builders, role-play, match…", "Write kanji, builders, sentences, match…");
js = edit(js,
  'Grammar checking needs Claude, which works only when this page is opened inside claude.ai, so compare it with the example.',
  'Compare it with the example to check the details.');
js = edit(js, ' (Grammar checking needs Claude inside claude.ai.)', '');

/* ---------- wrap ---------- */
const markupJS = JSON.stringify(`<div class="dojo-root">${markup}</div>`);
const app = `/* N3 Dojo — generated by scripts/build-dojo.mjs. Do not edit by hand. */
(function(){
const REAL_DOC = window.document;
let mounted = null;

/* Capabilities Dojo asks for: "db" + "user" sync progress to Firestore under
   the signed-in student; "sample" (Claude) is deliberately absent. */
function makeCL(){
  const FB = "https://www.gstatic.com/firebasejs/11.9.0/";
  const cfg = {apiKey:"AIzaSyCDfc2n8sJfesrIwbWluTmjTnTsl_x46SQ",authDomain:"japanesen3passengine.firebaseapp.com",projectId:"japanesen3passengine",storageBucket:"japanesen3passengine.firebasestorage.app",messagingSenderId:"409024055518",appId:"1:409024055518:web:c1e74cb1cf64e50fc25a4f"};
  const username = () => { try { const s = JSON.parse(sessionStorage.getItem("n3_user_session") || "null"); return s && s.verified === true && s.username ? s.username : null; } catch (e) { return null; } };
  let fs = null;
  async function firebase(){
    if (fs) return fs;
    const [a, f, au] = await Promise.all([import(FB + "firebase-app.js"), import(FB + "firebase-firestore.js"), import(FB + "firebase-auth.js")]);
    const appI = a.getApps().length ? a.getApps()[0] : a.initializeApp(cfg);
    const auth = au.getAuth(appI);
    // Rules need the Auth session, which restores asynchronously.
    const user = await new Promise(res => { const t = setTimeout(() => res(null), 8000); const off = au.onAuthStateChanged(auth, u => { if (u) { clearTimeout(t); off(); res(u); } }); });
    if (!user) return null;
    fs = { f, db: f.getFirestore(appI) };
    return fs;
  }
  return { use: async (name) => {
    const who = username();
    if (name === "user") return who ? { id: async () => who } : null;
    if (name !== "db" || !who) return null;
    const x = await firebase(); if (!x) return null;
    const { f, db } = x;
    // Each of Dojo's four documents is stored as JSON text: its state holds
    // shapes Firestore rejects (nested arrays, undefined), and one string
    // round-trips exactly.
    return { collection: () => ({ doc: (part) => {
      const ref = f.doc(db, "dojo", who, "docs", part);
      return {
        get: async () => { const s = await f.getDoc(ref); const d = s.exists() ? s.data() : null; let v = null; try { v = d && d.json ? JSON.parse(d.json) : null; } catch (e) {} return { exists: !!v, data: () => v }; },
        set: async (obj) => f.setDoc(ref, { json: JSON.stringify(obj), upd: +obj.upd || 0, updatedAt: f.serverTimestamp() }),
      };
    } }) };
  } };
}

/* \`document\` as Dojo sees it: lookups resolve inside the shadow root, and
   page-wide listeners only fire while a Dojo part is on screen. Events read
   their real target, since the shadow boundary would otherwise retarget it
   to the host element. */
function makeDoc(R, isActive){
  const real = e => new Proxy(e, { get(t, p){ if (p === "target") return t.composedPath()[0] || t.target; const v = t[p]; return typeof v === "function" ? v.bind(t) : v; } });
  const PAGE = new Set(["keydown","keyup","pointermove","pointerup","pointercancel"]);
  return {
    getElementById: id => R.getElementById(id),
    querySelector: s => R.querySelector(s),
    querySelectorAll: s => R.querySelectorAll(s),
    createElement: (...a) => REAL_DOC.createElement(...a),
    createElementNS: (...a) => REAL_DOC.createElementNS(...a),
    elementFromPoint: (x, y) => R.elementFromPoint(x, y),
    execCommand: (...a) => REAL_DOC.execCommand(...a),
    get activeElement(){ return R.activeElement || REAL_DOC.activeElement; },
    body: { contains: n => R.contains(n) },
    addEventListener(type, fn, opt){ (PAGE.has(type) ? REAL_DOC : R).addEventListener(type, e => { if (isActive()) fn(real(e)); }, opt); },
  };
}

function DOJO_APP(document, DOJO_CL, DOJO_OWNS){
${js}
return { route };
}

const OWN = new Set(["", "dojo", "home", "roleplay", "parts", "review", "kanji", "vocab", "grammar", "practice", "quiz", "match", "write", "build", "sentences", "exam", "notebook", "work", "path", "lesson"]);

window.N3Dojo = {
  /** Views that belong to Dojo, so the engine knows which part to show. */
  views: OWN,
  /** Mount once into host (Dojo routes itself on hashchange after that). */
  mount(host, isActive){
    if (mounted) return mounted;
    const R = host.attachShadow({ mode: "open" });
    R.innerHTML = '<link rel="stylesheet" href="dojo/dojo.css">' + ${markupJS};
    // Light/dark follows the engine's toggle.
    const sync = () => host.setAttribute("data-theme", REAL_DOC.documentElement.getAttribute("data-theme") || "");
    sync(); new MutationObserver(sync).observe(REAL_DOC.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const owns = h => OWN.has(h) && h !== "";
    mounted = DOJO_APP(makeDoc(R, isActive), makeCL(), owns);
    return mounted;
  },
};
})();
`;
writeFileSync(resolve(out, "dojo-app.js"), app);

/* ---------- stylesheet for the shadow root ---------- */
let sheet = css;
sheet = edit(sheet, ':root:not([data-theme="light"])', ':host(:not([data-theme="light"]))', sheet.split(':root:not([data-theme="light"])').length - 1);
sheet = sheet.split(':root[data-theme="dark"]').join(':host([data-theme="dark"])');
sheet = sheet.split(":root").join(":host");
sheet = sheet.replace(/(^|[\s,{}])html\{/g, "$1:host{");
sheet = sheet.replace(/(^|[\s,{}])body(?=[{:.\s,])/g, "$1.dojo-root");
if (/(^|[\s,{}])body[{:]/.test(sheet)) throw new Error("body selector left in CSS");
sheet += `
/* ---- inside the N3 Pass Engine ---- */
:host{display:block;padding:0 !important}
.dojo-root{background:none !important;min-height:0;font-family:var(--gothic);color:var(--ink)}
.dojo-root::before{display:none !important}
.top,.bnav{display:none !important}
main{max-width:none !important;padding:0 0 32px !important;margin:0 !important}
@media (max-width:860px){.toast{bottom:calc(84px + env(safe-area-inset-bottom,0px)) !important}}
`;
writeFileSync(resolve(out, "dojo.css"), sheet);

console.log(`dojo → public/dojo  (app ${(app.length / 1024 | 0)} KB, css ${(sheet.length / 1024 | 0)} KB, ${clips} audio clips)`);
