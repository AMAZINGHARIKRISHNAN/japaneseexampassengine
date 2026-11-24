/**
 * Keeps a student signed in until they press Sign Out.
 *
 * Every page decides "signed in or not" from a flag in sessionStorage
 * (n3_user_session for students, n3_admin_verified for admins). The browser
 * throws sessionStorage away when the tab or browser closes, so students were
 * sent back to the sign-in page all the time even though Firebase Auth itself
 * still had them signed in (its session lives in IndexedDB).
 *
 * When "Keep me signed in" is ticked at sign-in, the flag is also kept in
 * localStorage. This script runs first on every page — before any page's own
 * guard — and copies a kept flag back into sessionStorage, so those guards
 * work unchanged. Nothing password-shaped is stored: the flag only says who
 * signed in; Firebase Auth and the Firestore rules remain the real gate.
 *
 * Load as the first script in <head>:  <script src="session-keep.js"></script>
 */
(function () {
  var KEYS = ["n3_user_session", "n3_admin_verified"];
  var PREFIX = "keep.";

  try {
    KEYS.forEach(function (k) {
      var kept = localStorage.getItem(PREFIX + k);
      if (kept && !sessionStorage.getItem(k)) sessionStorage.setItem(k, kept);
    });
  } catch (e) { /* storage blocked (private mode): behave as before */ }

  /** After a successful sign-in: remember (or stop remembering) this flag. */
  window.__keepSession = function (key, remember) {
    try {
      var v = sessionStorage.getItem(key);
      if (remember && v) localStorage.setItem(PREFIX + key, v);
      else localStorage.removeItem(PREFIX + key);
    } catch (e) {}
  };

  /** Sign Out, or Firebase says nobody is signed in: forget everything. */
  window.__forgetSession = function () {
    try {
      KEYS.forEach(function (k) {
        sessionStorage.removeItem(k);
        localStorage.removeItem(PREFIX + k);
      });
    } catch (e) {}
  };
})();
