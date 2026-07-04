/**
 * Bot-side config for the new architecture. Re-exports the existing tracker
 * config (src/config.ts — which also loads .env) and adds the #carnage-inbox
 * settings on top. Everything inbox-related is opt-in: with no channel id set,
 * the new entry point behaves exactly like the current tracker.
 */

export { config } from "../../src/config.ts";

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

export interface InboxConfig {
  /** The #carnage-inbox channel the bot reads uploads from. Unset = inbox off. */
  channelId?: string;
  /** How many recent channel messages the startup backlog scan walks, newest-first. */
  backlogMessages: number;
}

export const inboxConfig: InboxConfig = {
  channelId: env("H3_INBOX_CHANNEL_ID"),
  backlogMessages: Number(env("H3_INBOX_BACKLOG_MESSAGES") ?? 300),
};
