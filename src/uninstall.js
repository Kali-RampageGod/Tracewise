import sql from '@forge/sql';
import { runCleanup } from './uninstall-plan';

// Forge runs this before the app is removed. It is not blocking: if it fails, removal goes ahead.
export async function preUninstall(event, context) {
  const installContext = (context && context.installContext) || (event && event.context && event.context.installContext) || null;
  const r = await runCleanup(installContext, (text) => sql.prepare(text).execute());
  console.log('TW_PREUNINSTALL', JSON.stringify(r));
}
