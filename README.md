# Japanese JLPT Pass Engine

A Firebase-hosted JLPT study web app focused on N3 and N4 exam preparation. The project is built as a set of static HTML pages with Firebase Authentication, locked-down Firestore rules, dashboards, mock tests, boost plans, stats pages, and admin tooling.

**Live:** https://japanesen3passengine.web.app

## Features

- N3 and N4 pass-engine study dashboards
- Full mock-test pages for N3 and N4 practice
- Boost-plan pages for focused revision
- **One-step sign-up** — a student enters their name and date of birth and starts
  studying immediately. No approval queue, no waiting.
- Same two details sign them back in on any device, anywhere
- **Progress follows the student across devices** — engine state is mirrored to
  Firestore and merged back on load (`public/progress-sync.js`)
- **Student-set exam date** — click the countdown to pick your sitting; it drives
  the live countdown and falls back to the next official JLPT date on its own
- Student dashboard with per-course progress and latest mock scores
- Admin page for managing accounts and watching the live sign-in log
- Locked-down Firestore rules — each student can only touch their own data
- Content-Security-Policy and hardening headers on every hosted page
- Firebase Hosting and Firestore configuration
- `scripts/manage-auth.mjs` — admin credential management
  (see [MIGRATION.md](MIGRATION.md) for the go-live steps)

## How sign-in works

A student types their **name** and **date of birth**. Those two values are folded
into a Firebase Authentication credential:

- the name becomes the account's username (`Hari Krishnan` → `hari_krishnan`)
- the date of birth becomes the password half

Firebase Auth still performs the actual verification and stores the credential
hashed. **Nothing password-shaped is ever written to Firestore** — the profile doc
holds only a display name, a username, and a uid.

The admin signs in separately with a real email and password via the **Admin**
link on the login page, and is recognised by having a doc in the `admins/`
collection.

## Staged for a future release

These were built out and deliberately held back so that sign-up stays a single
step while the student base grows. The code paths were removed from the shipping
pages, but the design is settled and the collections stay reserved in
`firestore.rules`, so they can be switched back on without a migration:

- **Device-fingerprint lock** — pins an account to the browser/device it
  registered from (SHA-256 over user agent, screen, timezone and hardware
  signals) and blocks sign-in from anywhere else.
- **Admin device-approval queue** — new devices raise a request that the admin
  approves or denies from the dashboard, with full device details attached.
- **Admin-reviewed registration** — new accounts land in a pending queue instead
  of going live immediately.
- **Per-course access grants** — issue N3 and N4 independently per student
  rather than giving every account the whole catalogue.

Turning any of these on is an intentional trade: each one adds friction to the
current one-step flow, so they stay staged until the class size justifies it.

## Project Structure

```text
.
├── public/                     # Everything Firebase Hosting deploys
│   ├── login.html              # Sign in / register (name + date of birth)
│   ├── dashboard.html          # Student dashboard
│   ├── admin.html              # Admin interface
│   ├── progress-sync.js        # Cross-device progress sync + exam-date picker
│   ├── n3-pass-engine.html     # Main N3 study engine
│   ├── n3-mock-test.html       # N3 mock test
│   ├── n3-boost.html           # N3 boost plan
│   ├── n3-stats.html           # N3 stats page
│   ├── n4-pass-engine.html     # Main N4 study engine
│   ├── n4-mock-test.html       # N4 mock test
│   ├── n4-boost.html           # N4 boost plan
│   └── n4-stats.html           # N4 stats page
├── scripts/
│   └── manage-auth.mjs         # Admin credential management (Admin SDK)
├── .github/scripts/            # CI helpers (inline-script parser)
├── .github/workflows/ci.yml    # Rules compile check + security regression guards
├── firestore.rules             # Firestore security rules
├── firestore.indexes.json      # Firestore indexes
├── firebase.json               # Hosting, headers + Firestore config
├── MIGRATION.md                # Go-live / account runbook
└── package.json                # Firebase dependencies
```

## Requirements

- Node.js
- npm
- Firebase CLI
- A Firebase project configured for Hosting and Firestore

## Setup

Install dependencies:

```bash
npm install
```

Log in to Firebase:

```bash
firebase login
```

Check the linked Firebase project:

```bash
firebase projects:list
```

## Local Preview

Because this is a static HTML project, you can open `public/login.html` directly in a browser for a quick check. For a Firebase-style local preview, use:

```bash
firebase emulators:start
```

## Deploy

Deploy hosting and Firestore configuration:

```bash
firebase deploy
```

Ship rules and hosting together — deploying only one leaves pages and rules
disagreeing about what a client is allowed to write.

## Roles

Two tiers, both recognised by a document in the `admins/` collection:

| | Monitor students, logs, accounts | Grant / revoke admin access |
|---|---|---|
| **owner** | yes | yes |
| **admin** | yes | no |

An owner promotes people from the dashboard's **Admins** tab — pick any student
and "Make admin". They keep signing in exactly as before; the `admins/` record
is what decides where they land.

The **owner tier is deliberately unreachable from a browser.** `firestore.rules`
refuses to create or elevate an owner no matter who is signed in, so owners can
only be minted with `manage-auth.mjs`, which needs the service-account key. That
ties "who can hand out access" to something a stolen session does not include.

Two more guards, enforced in the rules rather than the UI: nobody can change or
revoke their own admin record, and no owner can be revoked from the browser — so
the last owner cannot lock everyone out by accident.

## Admin tasks

Browsers can only manage the credential of the account they are signed in as, so
these run locally with a service-account key:

```bash
node scripts/manage-auth.mjs audit                                --service-account=…
node scripts/manage-auth.mjs list-admins                          --service-account=…
node scripts/manage-auth.mjs make-admin you@example.com --role=owner --service-account=…
node scripts/manage-auth.mjs set-admin-role you@example.com admin  --service-account=…
node scripts/manage-auth.mjs revoke-admin them@example.com        --service-account=…
node scripts/manage-auth.mjs add "Hari Krishnan" 2005-06-12       --service-account=…
node scripts/manage-auth.mjs set-dob "Hari Krishnan" 2005-06-12   --service-account=…
node scripts/manage-auth.mjs delete "Hari Krishnan"               --service-account=…
node scripts/manage-auth.mjs list                                 --service-account=…
```

Creating accounts also works directly from `admin.html`.

## Security model

- Passwords are stored and verified only by **Firebase Authentication**.
  Nothing password-shaped is kept in Firestore.
- `firestore.rules` restricts every collection: students read and write only
  their own profile, progress and scores; account listings and logs require the
  admin account. Retired collections are explicitly closed rather than deleted,
  so a stale client cannot resurrect one.
- The sign-in log accepts writes only from a signed-in account, only about
  itself, and only with allowlisted fields of bounded length.
- Everything the admin dashboard renders from Firestore is HTML-escaped, and
  values that drive CSS classes are allowlisted rather than escaped.
- A date of birth is low-entropy and public-ish by nature. This is a deliberate
  trade for a frictionless classroom sign-up — it protects study progress, not
  secrets. Do not store anything sensitive behind it.
- Service-account keys and `backups/` are gitignored — never commit them.

## Notes

- `firebase.json` serves `public/` as the hosting directory — config files,
  scripts, and docs at the repo root are never deployed.
- All unmatched hosting routes rewrite to `login.html`.
- CI (`.github/workflows/ci.yml`) compiles the Firestore rules and fails if an
  open rule, a hardcoded password, or an unescaped admin render is reintroduced.
- `node_modules`, Firebase cache files, and local editor settings are ignored by git.
