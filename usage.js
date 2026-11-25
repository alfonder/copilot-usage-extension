// Pure logic for the Copilot usage extension. No GNOME imports, so it can be tested with plain gjs.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Remove // line comments and block comments from JSONC text.
 * String contents (e.g. "https://github.com") are left untouched.
 */
export function stripJsonComments(text) {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        if (inString) {
            out += c;
            if (c === '\\') {
                out += next ?? '';
                i++;
            } else if (c === '"') {
                inString = false;
            }
        } else if (c === '"') {
            inString = true;
            out += c;
        } else if (c === '/' && next === '/') {
            while (i < text.length && text[i] !== '\n')
                i++;
            out += '\n';
        } else if (c === '/' && next === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/'))
                i++;
            i++;
        } else {
            out += c;
        }
    }
    return out;
}

export function parseJsonc(text) {
    return JSON.parse(stripJsonComments(text));
}

/** Pick the account the Copilot CLI is logged in with: {host, login} or null. */
export function pickAccount(config) {
    const user = config?.lastLoggedInUser ?? config?.loggedInUsers?.[0];
    if (!user?.host || !user?.login)
        return null;
    return {host: user.host.replace(/\/+$/, ''), login: user.login};
}

/** Candidate libsecret `username` attributes used by the Copilot CLI, most likely first. */
export function keyringUsernames(host, login) {
    return [`${host}:${login}`, `${host}:${login}:github`];
}

export function hostname(host) {
    return /^https?:\/\/([^/:]+)/.exec(host)?.[1] ?? null;
}

/** github.com -> api.github.com, <tenant>.ghe.com -> api.<tenant>.ghe.com */
export function apiBaseForHost(host) {
    const name = hostname(host);
    if (!name)
        return null;
    return name === 'github.com' ? 'https://api.github.com' : `https://api.${name}`;
}

function firstOfNextMonthUTC(now) {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

function parseResetDate(value, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : firstOfNextMonthUTC(now);
}

function quotaInfo(snapshot) {
    const total = Number(snapshot.entitlement ?? 0);
    const remaining = Number(snapshot.remaining ?? snapshot.quota_remaining ?? 0);
    // `remaining` is rounded to a whole number; `credits_used` is more precise
    // on token-based billing, so prefer it there.
    const creditsUsed = Number(snapshot.credits_used);
    const used = snapshot.token_based_billing === true && Number.isFinite(creditsUsed)
        ? creditsUsed
        : total - remaining;
    return {
        unlimited: snapshot.unlimited === true || !(total > 0),
        total,
        used: Math.max(0, used),
    };
}

/**
 * Convert the response of GET /copilot_internal/user to the shape the UI needs.
 * Returns null when the response has no premium_interactions quota
 * (e.g. an unsupported plan layout).
 */
export function normalizeUsage(raw, now = new Date()) {
    const premium = raw?.quota_snapshots?.premium_interactions;
    if (!premium)
        return null;

    const {unlimited, total, used} = quotaInfo(premium);
    const resetAt = parseResetDate(raw.quota_reset_date, now);
    const start = new Date(resetAt);
    start.setUTCMonth(start.getUTCMonth() - 1);

    let percent = 0;
    if (!unlimited)
        percent = total > 0 ? (used / total) * 100 : 0;

    let projected = null;
    const elapsedMs = now.getTime() - start.getTime();
    const periodMs = resetAt - start.getTime();
    if (!unlimited && elapsedMs >= DAY_MS && elapsedMs <= periodMs)
        projected = used / (elapsedMs / periodMs);

    const others = [];
    for (const [id, label] of [['chat', 'Chat'], ['completions', 'Completions']]) {
        const snap = raw.quota_snapshots[id];
        if (snap)
            others.push({id, label, ...quotaInfo(snap)});
    }

    return {
        plan: raw.copilot_plan ?? null,
        unit: premium.token_based_billing ? 'credits' : 'requests',
        unlimited,
        total,
        used,
        remaining: Math.max(0, total - used),
        percent,
        projected,
        projectedPercent: projected !== null && total > 0 ? (projected / total) * 100 : null,
        overage: Number(premium.overage_count ?? 0),
        resetAt: new Date(resetAt),
        others,
    };
}

export function formatNumber(n) {
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatDuration(ms) {
    if (ms <= 0)
        return 'now';
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0)
        return `${days}d ${hours % 24}h`;
    if (hours > 0)
        return `${hours}h ${mins % 60}m`;
    return `${mins}m`;
}
