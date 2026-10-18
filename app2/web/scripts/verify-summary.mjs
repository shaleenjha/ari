// Collects e2e/verify.spec.ts rows into test-results/verify-mobile/verify-mobile.json and a markdown table, printed and
// appended to $GITHUB_STEP_SUMMARY when set. Exits 1 when a row failed or rows are missing (6 expected).
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), 'test-results', 'verify-mobile');
const dir = join(out, 'rows');
const rows = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
const expected = Number(process.env.VERIFY_EXPECTED ?? 6);
const ok = rows.length >= expected && rows.every((r) => r.pass);
const fmtLcp = (r) => (r.lcpMs == null ? 'n/a' : `${(r.lcpMs / 1000).toFixed(2)} s${r.lcpGated ? '' : ' (report-only)'}`);
const md = [
  `### verify-mobile: ${ok ? 'pass' : 'FAIL'} (${rows.length}/${expected} rows; CLS <= ${rows[0]?.clsBudget ?? 0.02}, Chromium LCP < 1.2 s throttled, 0 errors)`,
  '',
  '| Screen | Engine | CLS | LCP | Console errors | Result |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.screen} | ${r.engine} | ${r.cls.toFixed(4)} | ${fmtLcp(r)} | ${r.consoleErrors} | ${r.pass ? 'pass' : 'FAIL'} |`),
  '',
  `Screenshots (artifact verify-mobile): ${rows.flatMap((r) => r.screenshots).join(', ')}`,
  '',
].join('\n');
writeFileSync(join(out, 'verify-mobile.json'), JSON.stringify({ ok, generatedAt: new Date().toISOString(), sha: process.env.GITHUB_SHA ?? null, rows }, null, 2));
writeFileSync(join(out, 'summary.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
process.exit(ok ? 0 : 1);
