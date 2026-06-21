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

interface State {
  matchesThisSession: number;
  totalMatches: number;
  lastMatch?: string;
  lastMatchAt?: number;
  watching: boolean;
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

/**
 * The live status footer. On a TTY it patches console.{log,warn,error} so every
 * log line is colorized and the footer is wiped + redrawn around it; off a TTY
 * it's inert and logging is untouched.
 */
class StatusBar {
  private state: State = { matchesThisSession: 0, totalMatches: 0, watching: false };
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private orig?: { log: typeof console.log; warn: typeof console.warn; error: typeof console.error };
  private footerVisible = false;

  /** Begin live rendering. No-op (and logging untouched) when not a TTY. */
  start(): void {
    if (!isTTY || this.orig) return;
    this.orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a: unknown[]) => this.around(() => this.orig!.log(...a.map((x) => paint(x))));
    console.warn = (...a: unknown[]) =>
      this.around(() => this.orig!.warn(...a.map((x) => paint(x, c.yellow))));
    console.error = (...a: unknown[]) =>
      this.around(() => this.orig!.error(...a.map((x) => paint(x, c.red))));
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.draw();
    }, 200);
    this.timer.unref?.();
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
    if (isTTY) this.draw();
  }

  /** Record a freshly-handled match: bump counters and the "last" line. */
  recordMatch(label: string): void {
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

  private draw(): void {
    if (!isTTY || !this.state.watching) return;
    const s = this.state;
    const parts = [
      `${c.cyan(SPINNER[this.frame])} ${c.bold("watching")}`,
      `${c.green(String(s.matchesThisSession))} this run`,
      `${s.totalMatches} total`,
    ];
    if (s.lastMatch) {
      const when = s.lastMatchAt ? c.gray(`(${ago(s.lastMatchAt)})`) : "";
      parts.push(`last: ${s.lastMatch} ${when}`.trimEnd());
    }
    process.stdout.write("\r\x1b[K" + c.dim(parts.join(c.gray(" · "))));
    this.footerVisible = true;
  }
}

/** Colorize a string arg's leading tag; pass non-strings through untouched. */
function paint(x: unknown, force?: (s: string) => string): unknown {
  return typeof x === "string" ? colorizeTag(x, force) : x;
}

export const statusBar = new StatusBar();

/**
 * Print a startup panel: a title between two rules, then aligned label/value
 * rows. No side borders — color codes throw off width math, and a plain rule
 * stays aligned regardless. Mirrors the update-check notice style.
 */
export function banner(title: string, rows: [string, string][]): void {
  const labelW = Math.max(...rows.map(([l]) => l.length));
  const width = Math.max(title.length, ...rows.map(([l, v]) => labelW + v.length + 3)) + 1;
  const rule = "─".repeat(width);
  const body = rows.map(([l, v]) => ` ${c.gray(l.padEnd(labelW))}  ${v}`);
  console.log([rule, ` ${c.bold(c.cyan(title))}`, rule, ...body, rule].join("\n"));
}
