/**
 * Terminal presentation: ANSI color helpers, a boxed startup banner, and a
 * persistent live status footer with a spinner. All of it degrades to plain
 * text when stdout isn't a TTY (piped, redirected to a log file, or a dumb
 * terminal), so captured output stays clean.
 *
 * Mirror of cpp/src/status_bar.{h,cpp} — keep the look and the tag colors in
 * step. The footer is the watcher's at-a-glance dashboard:
 *
 *   ⠙ watching · 3 this run · 142 total · last: Slayer on Guardian — Alpha (2m ago)
 *
 * It's redrawn on a timer (spinner) and re-painted under every log line so the
 * scrolling log never collides with it.
 */

const isTTY = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

const ESC = "\x1b[";
const sgr = (code: string, s: string): string => (isTTY ? `${ESC}${code}m${s}${ESC}0m` : s);

/** Minimal ANSI palette — no-ops when not a TTY. */
export const c = {
  dim: (s: string) => sgr("2", s),
  bold: (s: string) => sgr("1", s),
  red: (s: string) => sgr("31", s),
  green: (s: string) => sgr("32", s),
  yellow: (s: string) => sgr("33", s),
  blue: (s: string) => sgr("34", s),
  cyan: (s: string) => sgr("36", s),
  gray: (s: string) => sgr("90", s),
};

/** Color for a known `[tag]` prefix; gray for anything unrecognized. */
const TAG_COLOR: Record<string, (s: string) => string> = {
  db: c.gray,
  watch: c.gray,
  exit: c.gray,
  match: c.green,
  discord: c.cyan,
  heal: c.cyan,
  recap: c.cyan,
  ts2: c.cyan,
  skip: c.yellow,
  warn: c.yellow,
};

/** Colorize a leading `[tag]` token. `force` overrides the map (warn/error). */
function colorizeTag(line: string, force?: (s: string) => string): string {
  if (!isTTY) return line;
  return line.replace(/^(\s*)\[(\w+)\]/, (_m, pre: string, tag: string) => {
    const paint = force ?? TAG_COLOR[tag.toLowerCase()] ?? c.gray;
    return `${pre}${paint(`[${tag}]`)}`;
  });
}

type BotState = "off" | "connecting" | "online";
type PostState = "none" | "ok" | "fail";
type CatKey = "2v2" | "FFA" | "4v4";

interface State {
  matchesThisSession: number;
  totalMatches: number;
  lastMatch?: string;
  lastMatchAt?: number;
  watching: boolean;
  startedAt: number;
  bot: BotState;
  lastPost: PostState;
  cat: Record<CatKey, number>; // per-category matches this session
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** "just now" / "2m ago" / "3h ago" for the footer's last-match stamp. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Compact uptime: "45s" / "12m" / "1h3m". */
function uptime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

/** Local HH:MM:SS for log-line timestamps. */
function hhmmss(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * The live status footer. On a TTY it patches console.{log,warn,error} so every
 * log line is timestamped + colorized and the footer is wiped + redrawn around
 * it; off a TTY it's inert and logging is untouched. It also keeps the console
 * window title in sync with the match count / watch state.
 */
class StatusBar {
  private state: State = {
    matchesThisSession: 0,
    totalMatches: 0,
    watching: false,
    startedAt: Date.now(),
    bot: "off",
    lastPost: "none",
    cat: { "2v2": 0, FFA: 0, "4v4": 0 },
  };
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private orig?: { log: typeof console.log; warn: typeof console.warn; error: typeof console.error };
  private footerVisible = false;
  private lastTitle = "";

  /** Begin live rendering. No-op (and logging untouched) when not a TTY. */
  start(): void {
    if (!isTTY || this.orig) return;
    this.state.startedAt = Date.now();
    this.orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a: unknown[]) => this.around(() => this.orig!.log(...this.decorate(a)));
    console.warn = (...a: unknown[]) =>
      this.around(() => this.orig!.warn(...this.decorate(a, c.yellow)));
    console.error = (...a: unknown[]) =>
      this.around(() => this.orig!.error(...this.decorate(a, c.red)));
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.draw();
    }, 200);
    this.timer.unref?.();
  }

  /** Colorize tags, and prefix a dim timestamp on tagged log lines only. */
  private decorate(args: unknown[], force?: (s: string) => string): unknown[] {
    const painted = args.map((x) => paint(x, force));
    const first = args[0];
    if (typeof first === "string" && /^\s*\[\w+\]/.test(first)) {
      return [c.dim(hhmmss()), ...painted];
    }
    return painted;
  }

  /** Restore console and wipe the footer (used on shutdown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.clear();
    if (this.orig) {
      console.log = this.orig.log;
      console.warn = this.orig.warn;
      console.error = this.orig.error;
      this.orig = undefined;
    }
  }

  setState(p: Partial<State>): void {
    Object.assign(this.state, p);
    if (isTTY) {
      this.updateTitle();
      this.draw();
    }
  }

  /** Mark the bot's gateway state (drives the footer's `bot ●` indicator). */
  setBot(bot: BotState): void {
    this.setState({ bot });
  }

  /** Record the outcome of the last Discord post (footer `post ✓/⚠`). */
  setLastPost(ok: boolean): void {
    this.setState({ lastPost: ok ? "ok" : "fail" });
  }

  /** Record a freshly-handled match: bump counters, category tally, last line. */
  recordMatch(label: string, category?: string): void {
    if (category && category in this.state.cat) this.state.cat[category as CatKey]++;
    if (isTTY && process.env.H3_BELL) process.stdout.write("\x07"); // opt-in bell
    this.setState({
      matchesThisSession: this.state.matchesThisSession + 1,
      totalMatches: this.state.totalMatches + 1,
      lastMatch: label,
      lastMatchAt: Date.now(),
    });
  }

  private around(write: () => void): void {
    this.clear();
    write();
    this.draw();
  }

  private clear(): void {
    if (this.footerVisible) {
      process.stdout.write("\r\x1b[K");
      this.footerVisible = false;
    }
  }

  /** Keep the terminal window title in sync (OSC 0). Only writes on change. */
  private updateTitle(): void {
    const title = `H3 Tracker — ${this.state.totalMatches} matches · ${
      this.state.watching ? "watching" : "idle"
    }`;
    if (title === this.lastTitle) return;
    this.lastTitle = title;
    process.stdout.write(`\x1b]0;${title}\x07`);
  }

  private draw(): void {
    if (!isTTY || !this.state.watching) return;
    const s = this.state;
    const parts: string[] = [
      `${c.cyan(SPINNER[this.frame])} ${c.bold("watching")}`,
      `up ${uptime(s.startedAt)}`,
    ];
    const tally = (["2v2", "FFA", "4v4"] as const)
      .filter((k) => s.cat[k] > 0)
      .map((k) => `${k} ${s.cat[k]}`)
      .join("·");
    parts.push(`${c.green(String(s.matchesThisSession))} run${tally ? ` (${tally})` : ""}`);
    parts.push(`${s.totalMatches} total`);
    if (s.bot !== "off") {
      const dot = s.bot === "online" ? c.green("●") : c.gray("○");
      parts.push(`bot ${dot}${s.bot}`);
    }
    if (s.lastPost !== "none") {
      parts.push(s.lastPost === "ok" ? `post ${c.green("✓")}` : `post ${c.yellow("⚠")}`);
    }
    if (s.lastMatch) {
      const when = s.lastMatchAt ? c.gray(`(${ago(s.lastMatchAt)})`) : "";
      parts.push(`last: ${s.lastMatch} ${when}`.trimEnd());
    }
    process.stdout.write("\r\x1b[K" + parts.join(c.gray(" · ")));
    this.footerVisible = true;
  }
}

/** Colorize a string arg's leading tag; pass non-strings through untouched. */
function paint(x: unknown, force?: (s: string) => string): unknown {
  return typeof x === "string" ? colorizeTag(x, force) : x;
}

export const statusBar = new StatusBar();

/** Visible width of a string: length with any ANSI color codes stripped. */
const visibleLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Pad a (possibly colored) string to a visible width. */
const padVis = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleLen(s)));

/**
 * Print the startup panel as a proper box: title row, separator, then aligned
 * label/value rows. Values may be pre-colored — cells are padded by their
 * VISIBLE width (ANSI codes stripped for the math), so the borders line up.
 */
export function banner(title: string, rows: [string, string][]): void {
  const labelW = Math.max(...rows.map(([l]) => l.length));
  // Cap the box to the terminal width; too-long values (usually paths) keep
  // their tail — the end of a path is the informative part.
  const maxInner = Math.max(40, (process.stdout.columns ?? 100) - 4);
  const valueW = maxInner - labelW - 2;
  // (only plain values are truncated — slicing a colored one would cut codes)
  rows = rows.map(([l, v]) =>
    visibleLen(v) > valueW && visibleLen(v) === v.length ? [l, `…${v.slice(-(valueW - 1))}`] : [l, v],
  );
  const innerW = Math.min(
    maxInner,
    Math.max(title.length, ...rows.map(([, v]) => labelW + 2 + visibleLen(v))),
  );
  const top = c.gray(`┌─${"─".repeat(innerW)}─┐`);
  const mid = c.gray(`├─${"─".repeat(innerW)}─┤`);
  const bot = c.gray(`└─${"─".repeat(innerW)}─┘`);
  const bar = c.gray("│");
  const line = (s: string): string => `${bar} ${padVis(s, innerW)} ${bar}`;
  const body = rows.map(([l, v]) => line(`${c.gray(l.padEnd(labelW))}  ${v}`));
  console.log([top, line(c.bold(c.cyan(title))), mid, ...body, bot].join("\n"));
}

/** Print a short dim usage hint below the banner (one indented line each). */
export function hint(lines: string[]): void {
  for (const l of lines) console.log(c.dim(` ${l}`));
}
