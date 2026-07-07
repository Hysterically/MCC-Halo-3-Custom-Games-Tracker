/**
 * The shared ingest pipeline — the single path every carnage report takes into
 * the tracker, whether it came from the local MCC folder (the host playing) or
 * from a friend's upload in #carnage-inbox. Both sources converge on the same
 * record → rate → post → leaderboard steps, so a remote game is processed
 * byte-for-byte identically to a local one.
 *
 * All processing is serialized through one promise chain: a burst of inbox
 * uploads landing while a local game finishes can't interleave leaderboard
 * edits or reorder history mid-rating.
 *
 * Error semantics matter for the inbox queue: parse failures return "invalid"
 * (the upload is junk — mark it and move on), but DB/network failures THROW so
 * the caller can leave the inbox message unmarked and the next startup scan
 * retries it. recordMatch's atomic insert makes retries safe.
 */

import { config } from "./config.ts";
import {
  recordMatch,
  matchesChrono,
  setMatchResultsMsg,
  setMatchResultsFmt,
  hiddenXuids,
  type DB,
} from "./db.ts";
import {
  matchCsrChanges,
  matchWinChances,
  type CsrChange,
  type MatchWinChances,
} from "./trueskill2.ts";
import {
  parseCarnageFile,
  parseCarnageXml,
  type CarnageReport,
} from "./parseCarnage.ts";
import { findMapInfo } from "./mapInfo.ts";
import { postCsrMatchResultWithControls, upsertCsrLeaderboard } from "./discord.ts";
import { RESULTS_FMT_VERSION } from "./version.ts";

export type IngestSource = "local" | "inbox";

export type IngestStatus =
  | "recorded" // new match: recorded, rated, posted
  | "duplicate" // already in the DB (here or another instance) — nothing to do
  | "untracked" // parsed fine but not a completed Halo 3 custom
  | "invalid"; // couldn't parse at all

export interface IngestResult {
  status: IngestStatus;
  report?: CarnageReport;
  csrChanges?: Map<string, CsrChange> | null;
  /** Why an "invalid" report was rejected. */
  reason?: string;
}

/** Metadata that travels with an inbox upload (from the watcher's h3meta line). */
export interface ReportMeta {
  /** When the game was played — the XML has no timestamp, so the uploader's file mtime. */
  playedAt?: Date;
  mapName?: string;
  mapVariant?: string;
  /** The uploading watcher's WATCHER_VERSION — drives the 🆙 outdated nudge. */
  watcherVersion?: string;
}

export interface PipelineOpts {
  log?: (line: string) => void;
  /** Fires after a new match is recorded + rated — the console/status-bar hook. */
  onRecorded?: (
    report: CarnageReport,
    csrChanges: Map<string, CsrChange> | null,
    source: IngestSource,
  ) => void;
  /** Fires after each Discord delivery attempt (result post / leaderboard edit). */
  onPost?: (ok: boolean) => void;
}

export interface Pipeline {
  /** Full local flow: parse the file, poll for the map breadcrumbs, process. */
  ingestLocalFile(path: string): Promise<IngestResult>;
  /** Inbox flow: parse uploaded XML text, attach the watcher's meta, process. */
  ingestXml(xml: string, meta: ReportMeta): Promise<IngestResult>;
}

export function createPipeline(db: DB, opts: PipelineOpts = {}): Pipeline {
  const log = opts.log ?? console.log;

  // One-at-a-time processing (same trick as db.ts serializeWrite).
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** record → rate → post → leaderboard. Throws on DB errors (caller retries). */
  async function process(report: CarnageReport, source: IngestSource): Promise<IngestResult> {
    if (!(await recordMatch(db, report))) return { status: "duplicate", report };

    // Per-player CSR changes for the result post — replayed from the recorded
    // history, so they match exactly what the leaderboard will apply.
    // Best effort: a computation hiccup just posts the result without ratings.
    const history = await matchesChrono(db);
    const hidden = await hiddenXuids(db);
    let csrChanges: Map<string, CsrChange> | null = null;
    let winChances: MatchWinChances | null = null;
    try {
      csrChanges = matchCsrChanges(history, report.matchId, hidden);
      winChances = matchWinChances(history, report.matchId);
    } catch (e) {
      log(`[ts2] CSR change computation failed: ${(e as Error).message}`);
    }

    opts.onRecorded?.(report, csrChanges, source);

    try {
      // Capture the #game-results message id so the game can later be voided via
      // /delete or the Void button. Posts with buttons when the bot's app-owned
      // webhook is available, else a plain post to the configured webhook.
      const msgId = await postCsrMatchResultWithControls(
        db,
        report,
        csrChanges ?? undefined,
        winChances ?? undefined,
      );
      if (msgId) {
        await setMatchResultsMsg(db, report.matchId, msgId);
        // Stamp the layout version so the startup heal never re-styles a fresh post.
        await setMatchResultsFmt(db, report.matchId, RESULTS_FMT_VERSION);
        opts.onPost?.(true);
      }
    } catch (e) {
      opts.onPost?.(false);
      log(`[discord] result post failed: ${(e as Error).message}`);
    }
    try {
      await upsertCsrLeaderboard(config.discordLeaderboardWebhookUrl, db);
    } catch (e) {
      opts.onPost?.(false);
      log(`[discord] leaderboard upsert failed: ${(e as Error).message}`);
    }

    return { status: "recorded", report, csrChanges };
  }

  return {
    async ingestLocalFile(path: string): Promise<IngestResult> {
      let report: CarnageReport;
      try {
        report = await parseCarnageFile(path);
      } catch (e) {
        return { status: "invalid", reason: (e as Error).message };
      }
      if (!report.tracked) return { status: "untracked", report };
      // Best-effort map lookup: the theater film lands a few seconds after the
      // XML, so poll for it briefly before recording.
      try {
        const map = await findMapInfo(config.carnageDir, report.playedAt.getTime(), 45_000);
        report.mapName = map.mapName;
        report.mapVariant = map.mapVariant;
      } catch {
        // no map info — the post and the DB row just omit it
      }
      return serialize(() => process(report, "local"));
    },

    async ingestXml(xml: string, meta: ReportMeta): Promise<IngestResult> {
      let report: CarnageReport;
      try {
        report = parseCarnageXml(xml, meta.playedAt ?? new Date());
      } catch (e) {
        return { status: "invalid", reason: (e as Error).message };
      }
      // The map breadcrumbs only exist on the uploader's PC — trust the watcher.
      if (meta.mapName) report.mapName = meta.mapName;
      if (meta.mapVariant) report.mapVariant = meta.mapVariant;
      if (!report.tracked) return { status: "untracked", report };
      return serialize(() => process(report, "inbox"));
    },
  };
}
