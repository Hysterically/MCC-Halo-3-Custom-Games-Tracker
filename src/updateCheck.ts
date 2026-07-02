/**
 * Best-effort "your tracker is outdated" notice, printed on startup.
 *
 * The root cause behind stale #game-results posts is friends running old builds,
 * so we tell them. We compare the running build's version against the latest
 * GitHub release tag and print a prominent notice if behind. Everything here is
 * best-effort: offline, rate-limited, or an unknown local version → say nothing
 * and never block the watcher.
 *
 * Mirror of cpp/src/update_check.cpp. The TS path runs from the git checkout, so
 * the local version comes from `git describe`; the shipped C++ exe stamps it at
 * build time (cpp/src/version.h).
 */

import { execFileSync } from "node:child_process";

const REPO = "Hysterically/MCC-Halo-3-Custom-Games-Tracker";

/**
 * Local version: an explicit H3_VERSION override (mirrors the C++ build-time
 * macro; also how this is tested) else the git tag. Undefined when neither
 * yields anything — a non-tagged dev checkout, which we don't nag about.
 */
function localVersion(): string | undefined {
  const override = process.env.H3_VERSION?.trim();
  if (override) return override;
  try {
    const out = execFileSync("git", ["describe", "--tags", "--always"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** [major, minor, patch] from the first X.Y.Z in a string, or null if none. */
function semver(v: string): [number, number, number] | null {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True if `a` is strictly older than `b` (both X.Y.Z). */
function isOlder(a: string, b: string): boolean {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] < y[i]) return true;
    if (x[i] > y[i]) return false;
  }
  return false;
}

/** Latest release tag from GitHub, or undefined on any error. */
async function latestTag(): Promise<string | undefined> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "user-agent": "h3-tracker", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { tag_name?: string };
    return body.tag_name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Print an outdated-build notice if the running version is behind the latest
 * release. No-op when offline, rate-limited, or the local version is unknown
 * (a non-tagged dev checkout).
 */
export async function checkForUpdate(): Promise<void> {
  const local = localVersion();
  if (!local || !semver(local)) return; // dev checkout / unknown — don't nag
  const latest = await latestTag();
  if (!latest || !isOlder(local, latest)) return;

  const line = "─".repeat(54);
  console.warn(
    [
      "",
      line,
      ` Your tracker is OUTDATED (${local} → ${latest}).`,
      " Download the latest from #tracker-download (or the",
      " README link). Old builds post out-of-date results",
      " and miss fixes.",
      line,
      "",
    ].join("\n"),
  );
}
