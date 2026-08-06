/**
 * lib/notify.mjs — say something when the nightly run matters.
 *
 * career-ops was the only one of VP's services that never contacted him.
 * newsfeed, constitutional, llm-gateway, uptime-kuma and netalertx all have a
 * Telegram path; the one about his income did not, and `grep -ril
 * "telegram\\|ntfy\\|smtp"` across the whole repo returned nothing. The
 * consequence measured on 2026-08-06: 8 broken cards survived two nightly runs
 * and 40 hours of uptime, and the only detector in the entire system was VP
 * clicking a dead button.
 *
 * CREDENTIALS ARE NOT INVENTED HERE. Set these in .env to switch it on:
 *
 *   CAREER_OPS_TELEGRAM_TOKEN=<bot token>
 *   CAREER_OPS_TELEGRAM_CHAT=<chat id>
 *
 * With them unset this is a no-op that still prints to stdout, so the nightly
 * log is unchanged and nothing silently fails. Note VP runs eight separate bots
 * on a deliberate one-identity-one-purpose rule, so which bot this uses is his
 * choice, not a default.
 */

const TOKEN = process.env.CAREER_OPS_TELEGRAM_TOKEN || '';
const CHAT = process.env.CAREER_OPS_TELEGRAM_CHAT || '';

export const notifyEnabled = Boolean(TOKEN && CHAT);

/**
 * @param {string} text  plain text; no parse_mode is used deliberately.
 *
 * Telegram's MarkdownV2 escaping has bitten this fleet before (a nightly agent
 * shipped subtly-wrong escaping under a legacy parse_mode), and a job title is
 * exactly the kind of string full of parentheses, dashes and dots that breaks
 * it. Plain text cannot be mangled and cannot fail to send.
 */
export async function notify(text) {
  console.log(`\n[notify] ${text.split('\n')[0]}`);
  if (!notifyEnabled) {
    console.log('[notify] CAREER_OPS_TELEGRAM_TOKEN/CHAT unset — not sent');
    return { sent: false, reason: 'unconfigured' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.log(`[notify] telegram HTTP ${res.status}`);
      return { sent: false, reason: `http ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    // A notifier that throws would take down the run it exists to report on.
    console.log(`[notify] failed: ${String(e.message).slice(0, 80)}`);
    return { sent: false, reason: String(e.message).slice(0, 80) };
  }
}
