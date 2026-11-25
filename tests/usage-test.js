// Run with: gjs -m tests/usage-test.js
import {stripJsonComments, parseJsonc, pickAccount, keyringUsernames, apiBaseForHost,
    normalizeUsage, formatNumber, formatDuration} from '../usage.js';

let failed = 0;
function eq(actual, expected, name) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) { failed++; print(`FAIL ${name}\n  got      ${a}\n  expected ${e}`); }
    else print(`ok   ${name}`);
}

// JSONC: comments removed, but not "//" inside strings
const cfg = parseJsonc('// header\n// more\n{\n  "lastLoggedInUser": {"host": "https://x.ghe.com", "login": "me"}, /* c */\n  "url": "a//b"\n}\n');
eq(cfg.url, 'a//b', 'jsonc keeps // inside strings');
eq(pickAccount(cfg), {host: 'https://x.ghe.com', login: 'me'}, 'pickAccount');
eq(pickAccount({loggedInUsers: [{host: 'https://github.com/', login: 'u'}]}), {host: 'https://github.com', login: 'u'}, 'pickAccount fallback');
eq(pickAccount({}), null, 'pickAccount empty');
eq(keyringUsernames('https://x.ghe.com', 'me'), ['https://x.ghe.com:me', 'https://x.ghe.com:me:github'], 'keyringUsernames');
eq(apiBaseForHost('https://github.com'), 'https://api.github.com', 'api base github.com');
eq(apiBaseForHost('https://x.ghe.com'), 'https://api.x.ghe.com', 'api base ghe.com');

const unl = {unlimited: true, entitlement: 0, remaining: 0};
const sample = {
    copilot_plan: 'business', quota_reset_date: '2026-12-01',
    quota_snapshots: {
        chat: unl, completions: unl,
        premium_interactions: {unlimited: false, entitlement: 3000, remaining: 2595, percent_remaining: 86.5,
            credits_used: 404, overage_count: 0, token_based_billing: true},
    },
};
const now = new Date(Date.UTC(2026, 10, 25, 14, 0));
const n = normalizeUsage(sample, now);
eq([n.plan, n.unit, n.unlimited, n.total, n.used, n.remaining], ['business', 'credits', false, 3000, 404, 2596], 'normalize basics');
eq(Math.round(n.percent * 100) / 100, 13.47, 'percent');
eq(n.resetAt.toISOString(), '2026-12-01T00:00:00.000Z', 'reset date');
eq(Math.round(n.projected), 493, 'projection');
eq(n.others.map(o => [o.label, o.unlimited]), [['Chat', true], ['Completions', true]], 'others');
eq(normalizeUsage({quota_snapshots: {}}, now), null, 'no premium quota -> null');
const early = normalizeUsage(sample, new Date(Date.UTC(2026, 10, 1, 5, 0)));
eq(early.projected, null, 'no projection in first day');
const legacy = normalizeUsage({quota_reset_date: '2026-12-01', quota_snapshots: {premium_interactions: {unlimited: false, entitlement: 300, remaining: 90, token_based_billing: false, overage_count: 2}}}, now);
eq([legacy.unit, legacy.used, legacy.overage], ['requests', 210, 2], 'legacy requests');
eq(normalizeUsage({quota_snapshots: {premium_interactions: {unlimited: true}}}, now).unlimited, true, 'unlimited');
eq(formatNumber(3000), '3,000', 'formatNumber');
eq(formatDuration(5 * 86400000 + 9 * 3600000), '5d 9h', 'formatDuration');

if (failed) { print(`${failed} FAILED`); imports.system.exit(1); }
print('all passed');
