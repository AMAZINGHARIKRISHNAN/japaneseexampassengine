# Go-live: name + date-of-birth sign-in

Students sign in with their **name** and **date of birth**. Both are folded into
a Firebase Authentication credential, so Firebase Auth still does the actual
verification and the password is only ever stored hashed, by Google. Firestore
holds no credential material.

Sign-up is one step: fill in the two fields, and the account is live. There is no
approval queue.

## 1. Enable the Email/Password provider

Firebase Console → **Authentication** → *Sign-in method* → enable
**Email/Password**. Without this every sign-in fails.

## 2. Get a service-account key

Firebase Console → Project settings → *Service accounts* →
**Generate new private key**. Save it OUTSIDE the repo or as
`service-account.json` (gitignored). Never commit it.

## 3. Create the admin account

```bash
npm install   # installs firebase-admin (devDependency)
node scripts/manage-auth.mjs make-admin you@example.com "<strong password>" --service-account=service-account.json
```

The admin signs in through the **Admin** link on the login page, using this email
and password — not a name and date of birth.

## 4. Convert accounts created before this model

Older profiles have no `fullName` and a password that the sign-in form can no
longer reproduce, so those students cannot get in until they are re-pointed.
Find them:

```bash
node scripts/manage-auth.mjs audit --service-account=service-account.json
```

Then, for each one, set the date of birth they will type:

```bash
node scripts/manage-auth.mjs set-dob "Haifa" 2005-06-12 --service-account=service-account.json
```

The name must reduce to the same username the account already has
(`Haifa` → `haifa`), which is normally just their existing username with proper
capitalisation. `set-dob` also writes the display name onto the profile.

Alternatively, delete the old account and let the student register themselves:

```bash
node scripts/manage-auth.mjs delete "Haifa" --service-account=service-account.json
```

## 5. Deploy rules + hosting together

```bash
firebase deploy
```

Deploying only one of the two leaves a broken window — new pages write fields the
old rules reject, or old pages hit rules they can no longer satisfy. Ship both.

## 6. Verify

- Register a throwaway name + date of birth → lands straight on the dashboard.
- Sign out, sign back in with the same two values → works.
- Sign in with the right name and the wrong date → refused.
- Admin sign-in via the **Admin** link → dashboard loads accounts and activity.
- Open an incognito window, dev console: an unauthenticated
  `getDocs(collection(db, "users"))` must fail with `permission-denied`, and an
  unauthenticated `addDoc(collection(db, "login_log"), …)` must fail too.

## Ongoing admin tasks

Browsers can only manage the credential of the account they are signed in as, so
these run locally:

```bash
node scripts/manage-auth.mjs audit                              --service-account=…
node scripts/manage-auth.mjs add "Full Name" 2005-06-12         --service-account=…
node scripts/manage-auth.mjs set-dob "Full Name" 2005-06-12     --service-account=…
node scripts/manage-auth.mjs delete "Full Name"                 --service-account=…
node scripts/manage-auth.mjs list                               --service-account=…
```

Creating accounts still works from `admin.html` directly.

## What is and isn't protected

- **Hard guarantees (server-side).** Credential checks, per-student data
  isolation, and admin-only access to the account list and logs. Enforced by
  Firebase Auth and `firestore.rules` regardless of what a client does.
- **The sign-in log** accepts appends only from a signed-in account, only about
  itself, with allowlisted fields — so no anonymous client can write into the
  admin's view.
- **The credential is a date of birth.** It is low-entropy, often guessable, and
  cannot be rotated by the student. That is an accepted trade for one-step
  classroom sign-up: it gates study progress, not anything sensitive. If the app
  ever holds real personal data, move to a proper password first.
- **Page HTML/JS is public by design.** Study content ships to the browser; only
  Firestore data is access-controlled.
- **Duplicate names collide.** Two students whose names reduce to the same
  username cannot both register — the second is told to add a middle name or
  initial.
