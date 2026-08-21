#!/usr/bin/env node
/**
 * Firebase Auth management for the JLPT Pass Engine.
 *
 * The admin tasks that can't be done from the browser, because a browser can
 * only manage the credential of the account it is signed in as.
 *
 * Commands:
 *   audit                            Report profiles that predate the name +
 *                                    date-of-birth model and need a set-dob.
 *   list-admins                      Show every admin and their role.
 *   set-admin-role <email> <role>    Move an existing admin between owner/admin.
 *   revoke-admin <email>             Remove admin access (refuses the last owner).
 *   make-admin <email> [password]    Create (or reuse) an Auth account for the
 *                                    admin and write admins/{uid}. If password
 *                                    is omitted the account must already exist.
 *   add "<full name>" <dob>          Create a student credential + profile doc.
 *                                    dob is YYYY-MM-DD.
 *   set-dob "<full name>" <dob>      Re-point an existing account at a new date
 *                                    of birth (this is a password reset).
 *   delete "<full name>"             Delete a student's Auth credential AND
 *                                    their users/ profile doc.
 *   list                             List all Auth accounts.
 *
 * Students sign in with their full name and date of birth. Both are folded into
 * a Firebase Auth credential by slugName()/passwordFor() below — these MUST stay
 * byte-identical to the versions in public/login.html and public/admin.html, or
 * an account made here won't match what the student types.
 *
 * Usage:
 *   node scripts/manage-auth.mjs <command> [...args] --service-account=<path>
 *
 * The service-account JSON comes from Firebase Console → Project settings →
 * Service accounts → "Generate new private key". Keep it out of git.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const STUDENT_DOMAIN = "students.japanesen3passengine.app"; // must match login.html / admin.html / firestore.rules

// ── CLI parsing ───────────────────────────────────────────────────────────
const positional = [];
const flags = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] ?? true;
  else positional.push(a);
}
const [command, ...args] = positional;

if (!command) {
  console.error("Usage: node scripts/manage-auth.mjs <audit|make-admin|add|set-dob|delete|list> [...] --service-account=<path>");
  process.exit(1);
}
if (!flags["service-account"]) {
  console.error("Missing --service-account=<path to service-account JSON>");
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(readFileSync(resolve(flags["service-account"]), "utf8"))) });
const db   = getFirestore();
const auth = getAuth();

const emailFor = (username) => `${username}@${STUDENT_DOMAIN}`;

// "Hari Krishnan" → "hari_krishnan". Keep in sync with public/login.html.
function slugName(name) {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Keep in sync with credentialsFor() in public/login.html.
const passwordFor = (dob, username) => `${dob}:${username}`;

function requireDob(dob) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00Z`))) {
    console.error(`Invalid date of birth "${dob}" — expected YYYY-MM-DD`);
    process.exit(1);
  }
  return dob;
}

function requireUsername(fullName) {
  const username = slugName(fullName ?? "");
  if (!/^[a-z0-9_]{2,30}$/.test(username)) {
    console.error(`"${fullName}" does not reduce to a usable username (got "${username}")`);
    process.exit(1);
  }
  return username;
}

async function findAuthUser(email) {
  try { return await auth.getUserByEmail(email); }
  catch (e) { if (e.code === "auth/user-not-found") return null; throw e; }
}

// ── audit ─────────────────────────────────────────────
// Accounts created before the name + date-of-birth model have no fullName and
// a password nobody can reproduce from the sign-in form. They keep working only
// once an admin re-points them with set-dob.
async function audit() {
  const snap = await db.collection("users").get();
  const stale = [];

  for (const d of snap.docs) {
    const data = d.data();
    const problems = [];
    if (!data.fullName) problems.push("no fullName");
    if ("password" in data) problems.push("LEGACY PLAINTEXT PASSWORD FIELD");
    if ("approvedFingerprint" in data) problems.push("stale device-lock field");
    if (problems.length) stale.push([d.id, problems]);
  }

  console.log(`${snap.size} profile doc(s) total.`);
  if (!stale.length) {
    console.log("All profiles match the name + date-of-birth model.");
    return;
  }
  console.log(`\n${stale.length} need attention:\n`);
  for (const [username, problems] of stale) {
    console.log(`  @${username}\t${problems.join(", ")}`);
  }
  console.log("\nRe-point each one so their name + DOB signs them in:");
  console.log('  node scripts/manage-auth.mjs set-dob "<full name>" <YYYY-MM-DD> --service-account=...');
}

// ── make-admin ────────────────────────────────────────────────────────────
async function makeAdmin() {
  const [email, password] = args;
  if (!email) { console.error("Usage: make-admin <email> [password] [--role=owner|admin]"); process.exit(1); }

  const role = flags.role ?? "owner";
  if (!["owner", "admin"].includes(role)) {
    console.error(`--role must be "owner" or "admin" (got "${role}")`);
    process.exit(1);
  }

  let user = await findAuthUser(email);
  if (!user) {
    if (!password) { console.error(`No Auth account for ${email} — pass a password to create one.`); process.exit(1); }
    user = await auth.createUser({ email, password });
    console.log(`Created Auth account ${email} (${user.uid})`);
  } else if (password) {
    await auth.updateUser(user.uid, { password });
    console.log(`Updated password for ${email}`);
  }

  // The owner tier only ever comes from here. firestore.rules refuses to create
  // or elevate an owner from a browser, so possession of the service-account
  // key is what separates "can monitor" from "can hand out access".
  await db.collection("admins").doc(user.uid).set({
    uid:       user.uid,
    email,
    role,
    grantedAt: FieldValue.serverTimestamp(),
    grantedBy: "manage-auth-script",
  }, { merge: true });
  console.log(`admins/${user.uid} written — ${email} is now ${role === "owner" ? "an OWNER" : "an admin"}.`);
}

// ── set-admin-role / list-admins ──────────────────────────────────────────
async function setAdminRole() {
  const [email, role] = args;
  if (!email || !["owner", "admin"].includes(role)) {
    console.error('Usage: set-admin-role <email> <owner|admin>');
    process.exit(1);
  }
  const user = await findAuthUser(email);
  if (!user) { console.error(`No Auth account for ${email}`); process.exit(1); }
  const ref = db.collection("admins").doc(user.uid);
  if (!(await ref.get()).exists) { console.error(`${email} is not an admin — use make-admin first.`); process.exit(1); }
  await ref.set({ role }, { merge: true });
  console.log(`${email} is now ${role}.`);
}

async function listAdmins() {
  const snap = await db.collection("admins").get();
  if (snap.empty) { console.log("No admins."); return; }
  const owners = snap.docs.filter(d => d.data().role === "owner").length;
  for (const d of snap.docs) {
    const a = d.data();
    console.log(`${(a.role ?? "admin").padEnd(6)} ${(a.email ?? "?").padEnd(34)} ${d.id}`);
  }
  console.log(`\n${snap.size} admin(s), ${owners} owner(s).`);
  if (!owners) console.log("WARNING: no owner — nobody can grant or revoke access from the dashboard.");
}

// ── revoke-admin ──────────────────────────────────────────────────────────
async function revokeAdmin() {
  const [email] = args;
  if (!email) { console.error("Usage: revoke-admin <email>"); process.exit(1); }
  const user = await findAuthUser(email);
  if (!user) { console.error(`No Auth account for ${email}`); process.exit(1); }
  const ref = db.collection("admins").doc(user.uid);
  const snap = await ref.get();
  if (!snap.exists) { console.log(`${email} is not an admin.`); return; }
  if (snap.data().role === "owner") {
    const owners = (await db.collection("admins").get()).docs.filter(d => d.data().role === "owner");
    if (owners.length <= 1) {
      console.error("Refusing: that is the only owner. Promote someone else first or you lock yourself out.");
      process.exit(1);
    }
  }
  await ref.delete();
  console.log(`Admin access revoked for ${email}. Their sign-in still works; they are just no longer an admin.`);
}

// ── add / set-password / delete / list ────────────────────────────────────
async function addUser() {
  const [fullName, dob] = args;
  if (!fullName || !dob) { console.error('Usage: add "<full name>" <YYYY-MM-DD>'); process.exit(1); }
  const username = requireUsername(fullName);
  requireDob(dob);

  const user = await auth.createUser({
    email:    emailFor(username),
    password: passwordFor(dob, username),
  });
  await db.collection("users").doc(username).set({
    username,
    fullName,
    uid: user.uid,
    status: "active",
    createdAt: FieldValue.serverTimestamp(),
    createdBy: "manage-auth-script",
  });
  console.log(`Created @${username} (${user.uid}) — signs in as "${fullName}" + ${dob}`);
}

async function setDob() {
  const [fullName, dob] = args;
  if (!fullName || !dob) { console.error('Usage: set-dob "<full name>" <YYYY-MM-DD>'); process.exit(1); }
  const username = requireUsername(fullName);
  requireDob(dob);

  const user = await findAuthUser(emailFor(username));
  if (!user) { console.error(`No Auth account for @${username}`); process.exit(1); }
  await auth.updateUser(user.uid, { password: passwordFor(dob, username) });

  // Keep the profile's display name aligned with whatever they now type.
  await db.collection("users").doc(username).set({ fullName }, { merge: true });
  console.log(`@${username} now signs in as "${fullName}" + ${dob}`);
}

async function deleteUser() {
  const [fullName] = args;
  if (!fullName) { console.error('Usage: delete "<full name>"'); process.exit(1); }
  const username = requireUsername(fullName);
  const user = await findAuthUser(emailFor(username));
  if (user) { await auth.deleteUser(user.uid); console.log(`Deleted Auth credential for @${username}`); }
  else console.log(`No Auth credential found for @${username}`);
  await db.collection("users").doc(username).delete();
  console.log(`Deleted users/${username}`);
}

async function list() {
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    for (const u of page.users) console.log(`${u.email}\t${u.uid}\tlastSignIn=${u.metadata.lastSignInTime ?? "never"}`);
    token = page.pageToken;
  } while (token);
}

// ── dispatch ──────────────────────────────────────────────────────────────
const commands = {
  audit, "make-admin": makeAdmin, "set-admin-role": setAdminRole,
  "list-admins": listAdmins, "revoke-admin": revokeAdmin,
  add: addUser, "set-dob": setDob, delete: deleteUser, list,
};
if (!commands[command]) { console.error(`Unknown command: ${command}`); process.exit(1); }
commands[command]().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
