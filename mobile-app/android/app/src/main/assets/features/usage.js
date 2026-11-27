// DeepSeek official prices checked 2026-11-25, yuan per million tokens (peak). Off-peak is half.
export const PRICE_DATE = '2026-11-25';
const PRICES = {
  'deepseek-flash': { hit: 0.04, miss: 2, out: 8 },
  'deepseek-v4-pro': { hit: 0.3, miss: 9, out: 27 },
};

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Turns the API usage object into the fields shown on the message, or null when the gateway omits it. */
export function usageOf(raw, model, at) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = number(raw.prompt_tokens);
  const completion = number(raw.completion_tokens);
  if (prompt == null && completion == null) return null;
  const hit = number(raw.prompt_cache_hit_tokens) ?? number(raw.prompt_tokens_details?.cached_tokens);
  const miss = number(raw.prompt_cache_miss_tokens) ??
    (prompt != null && hit != null ? Math.max(0, prompt - hit) : null);
  const reasoning = number(raw.completion_tokens_details?.reasoning_tokens);
  return {
    model, at, prompt, hit, miss, completion, reasoning,
    total: number(raw.total_tokens),
  };
}

/** Peak is a Beijing-time weekday 9:00-12:00 or 14:00-18:00. */
export function isPeak(at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(at));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const hour = Number(get('hour'));
  return !['Sat', 'Sun'].includes(get('weekday')) && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}

/** Estimated yuan for one turn, or null when the model has no published price in this build. */
export function estimate(usage) {
  const price = PRICES[usage?.model];
  if (!price) return null;
  const hit = usage.hit ?? 0;
  const miss = usage.miss ?? usage.prompt ?? 0;
  const cost = (hit * price.hit + miss * price.miss + (usage.completion ?? 0) * price.out) / 1_000_000;
  return isPeak(usage.at) ? cost : cost / 2;
}

const beijingDay = (at) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(at));

/** Sums the estimates for messages from the same Beijing day; unknown models add nothing. */
export function todayCost(dialogs, at = Date.now()) {
  const day = beijingDay(at);
  let total = 0;
  for (const dialog of dialogs) {
    for (const message of dialog.messages ?? []) {
      if (message.usage && beijingDay(message.usage.at) === day) {
        const cost = estimate(message.usage);
        if (cost != null) total += cost;
      }
      if (message.toolCost && beijingDay(message.usage?.at ?? message.at) === day)
        total += message.toolCost;
    }
    for (const summary of dialog.summaries ?? [])
      if (summary.usage && beijingDay(summary.usage.at) === day) {
        const cost = estimate(summary.usage);
        if (cost != null) total += cost;
      }
  }
  return total;
}

export function formatTokens(value) {
  return value == null ? '' : value.toLocaleString('zh-CN');
}

export function formatCost(value) {
  if (value == null) return '';
  if (value < 0.01) return '¥' + value.toFixed(4);
  if (value < 1) return '¥' + value.toFixed(3);
  return '¥' + value.toFixed(2);
}
