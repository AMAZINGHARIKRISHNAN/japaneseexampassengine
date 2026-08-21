/**
 * Renders the build stamp into any element carrying [data-version-badge].
 *
 * Reads public/version.json, which scripts/stamp-version.mjs regenerates on
 * every deploy, so the date shown is always the date the content actually
 * changed rather than a number somebody remembered to edit.
 */
(function () {
  const targets = document.querySelectorAll("[data-version-badge]");
  if (!targets.length) return;

  const fmt = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return {
      short: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
      full:  d.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" }),
      ago:   relative(d),
    };
  };

  function relative(d) {
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }

  fetch("version.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then((v) => {
      const when = fmt(v.date);
      if (!when) throw new Error("bad date");
      targets.forEach((el) => {
        el.innerHTML =
          `<span class="vb-ver">v${v.version}</span>` +
          `<span class="vb-sep">·</span>` +
          `<span class="vb-when">Updated ${when.short}</span>` +
          `<span class="vb-note">Updated regularly — new practice content and fixes ship often.</span>`;
        el.title =
          `Version ${v.version} · build ${v.builds} · ${v.commit}\n` +
          `Last updated ${when.full} (${when.ago})`;
        el.setAttribute("data-ready", "true");
      });
    })
    .catch(() => {
      // Never show a wrong date. If the stamp is unreadable, say nothing about when.
      targets.forEach((el) => {
        el.innerHTML = `<span class="vb-note">Updated regularly — new practice content and fixes ship often.</span>`;
        el.setAttribute("data-ready", "true");
      });
    });
})();
