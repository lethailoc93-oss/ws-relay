import { randomBytes } from 'crypto';

// ── Test: Empty Return Fix Logic ──
function rand64() { return randomBytes(32).toString('hex'); }

function normRole(r) {
    if (r === 'assistant' || r === 'model') return 'model';
    if (r === 'user') return 'user';
    return r || '';
}

function applyEmptyReturnFix(rawMessages) {
    const msgs = Array.isArray(rawMessages) ? [...rawMessages] : [];
    if (msgs.length === 0) return msgs;
    const lastIdx = msgs.length - 1;
    const last = msgs[lastIdx];
    const lastRole = normRole(last.role);
    const prev = msgs[lastIdx - 1];
    const prevRole = prev ? normRole(prev.role) : '';

    if (lastRole === 'model') {
        if (prevRole !== 'model') {
            msgs.splice(lastIdx, 0, { role: 'assistant', content: rand64() });
        }
        return msgs;
    }

    if (lastRole === 'user') {
        msgs[lastIdx] = { ...last, role: 'assistant' };
        const newPrev = msgs[lastIdx - 1];
        const newPrevRole = newPrev ? normRole(newPrev.role) : '';
        if (newPrevRole !== 'model') {
            msgs.splice(lastIdx, 0, { role: 'assistant', content: rand64() });
        }
        return msgs;
    }
    return msgs;
}

function parseThinkingBudget(headers, queryParams) {
    const raw = headers['x-thinking-budget'] || queryParams.thinking_budget;
    if (raw == null) return null;
    const num = parseInt(raw, 10);
    if (isNaN(num) || num < 0) return null;
    return Math.min(num, 32768);
}

function parseGoogleSearch(headers, queryParams) {
    const raw = headers['x-google-search'] || queryParams.google_search;
    if (raw == null) return null;
    const val = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(val)) return true;
    if (['0', 'false', 'no', 'off'].includes(val)) return false;
    return null;
}

// ── Tests ──
let passed = 0;
let failed = 0;

function assert(condition, name) {
    if (condition) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}`); }
}

console.log('=== Empty Return Fix ===');

// Test 1: Messages ending with model role — should insert dummy
const t1 = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' }
];
const r1 = applyEmptyReturnFix(t1);
assert(r1.length === 3, 'Inserts dummy message when last is model');
assert(r1[1].role === 'assistant' && r1[1].content.length === 64, 'Dummy is 64-char hex');
assert(r1[2].role === 'assistant', 'Original last preserved');

// Test 2: Normal messages — no fix needed
const t2 = [{ role: 'user', content: 'hi' }];
const r2 = applyEmptyReturnFix(t2);
assert(r2.length === 2, 'User role gets converted and dummy inserted');

// Test 3: Empty messages
const t3 = [];
const r3 = applyEmptyReturnFix(t3);
assert(r3.length === 0, 'Empty array returns empty');

// Test 4: Two model messages in a row — should NOT insert
const t4 = [
    { role: 'model', content: 'a' },
    { role: 'model', content: 'b' }
];
const r4 = applyEmptyReturnFix(t4);
assert(r4.length === 2, 'Two consecutive model roles: no insertion');

console.log('\n=== Thinking Budget ===');

assert(parseThinkingBudget({ 'x-thinking-budget': '2048' }, {}) === 2048, 'Header: 2048');
assert(parseThinkingBudget({}, { thinking_budget: '4096' }) === 4096, 'Query: 4096');
assert(parseThinkingBudget({}, {}) === null, 'Not provided: null');
assert(parseThinkingBudget({ 'x-thinking-budget': '-1' }, {}) === null, 'Negative: null');
assert(parseThinkingBudget({ 'x-thinking-budget': '99999' }, {}) === 32768, 'Over max: clamped to 32768');
assert(parseThinkingBudget({ 'x-thinking-budget': 'abc' }, {}) === null, 'NaN: null');

console.log('\n=== Google Search Toggle ===');

assert(parseGoogleSearch({ 'x-google-search': 'true' }, {}) === true, 'true string');
assert(parseGoogleSearch({ 'x-google-search': '1' }, {}) === true, '1 string');
assert(parseGoogleSearch({ 'x-google-search': 'false' }, {}) === false, 'false string');
assert(parseGoogleSearch({ 'x-google-search': '0' }, {}) === false, '0 string');
assert(parseGoogleSearch({}, { google_search: 'on' }) === true, 'query on');
assert(parseGoogleSearch({}, { google_search: 'off' }) === false, 'query off');
assert(parseGoogleSearch({}, {}) === null, 'Not provided: null');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
