// kyte-ai edge function entry (PENDING). The code lives in main.ts; ../ari-ai/index.ts serves the same code under the legacy
// slug ari-ai. secretKey('ari_ai') stays here so the entry fails closed (and check_no_legacy_keys.py sees it).
import { secretKey } from './db.ts';
import { serveAi } from './main.ts';

serveAi('kyte-ai', () => secretKey('ari_ai'));
