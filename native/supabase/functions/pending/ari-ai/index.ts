// ari-ai: LEGACY ALIAS of kyte-ai (Oct 30 2026, naming plan A+; docs/engineering/code-names.md). Same code, other slug.
// Kept because staging runs ari-ai and these callers use the slug: the database kicks (ari_ai_kick in 0041, the pipeline
// kick in 0047) and ari-gmail-push. Deploy it from this file (entrypoint ari-ai/index.ts) next to kyte-ai until a
// migration repoints those callers; then undeploy it and delete this folder. Never put code here.
import { secretKey } from '../kyte-ai/db.ts';
import { serveAi } from '../kyte-ai/main.ts';

serveAi('ari-ai', () => secretKey('ari_ai'));
