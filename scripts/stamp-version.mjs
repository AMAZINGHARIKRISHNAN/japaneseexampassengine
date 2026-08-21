#!/usr/bin/env node
/**
 * Writes public/version.json from git + package.json.
 *
 * Run automatically by the `predeploy` hook in firebase.json, so the stamp can
 * never drift from what is actually deployed. A hand-maintained "last updated"
 * line is accurate exactly once and misleading from then on — this project has
 * already been bitten by that twice (a frozen exam countdown and a stale
 * credential note), so the date is derived, never typed.
 *
 * The human-controlled part is the semver in package.json; bump it when you
 * ship something students would notice.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;                       // shallow clone, no git, or not a repo
  }
}

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const commitISO = git("log", "-1", "--format=%cI");
const stamp = {
  version:  pkg.version ?? "0.0.0",
  commit:   git("rev-parse", "--short", "HEAD") ?? "unknown",
  // Commit date, not build date: it reflects when the content actually changed,
  // so re-deploying an unchanged site doesn't pretend to be an update.
  date:     commitISO ?? new Date().toISOString(),
  builds:   Number(git("rev-list", "--count", "HEAD") ?? 0),
  dirty:    Boolean(git("status", "--porcelain")),
};

const out = resolve(root, "public", "version.json");
writeFileSync(out, JSON.stringify(stamp, null, 2) + "\n");

console.log(
  `version.json → v${stamp.version} (build ${stamp.builds}, ${stamp.commit}` +
  `${stamp.dirty ? ", uncommitted changes" : ""}) dated ${stamp.date}`
);
