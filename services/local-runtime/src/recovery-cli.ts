import { pathToFileURL } from 'node:url';
import { databaseConfig } from './config.js';
import { createLocalPool } from './database.js';
import { checkSchema } from './migrate.js';
import { Recovery, RecoveryFailure, recoveryRequest } from './recovery.js';

export async function main(args = process.argv.slice(2)) {
  const pool = createLocalPool(databaseConfig(process.env));
  try {
    await checkSchema(pool);
    // Local maintainer authentication is PostgreSQL password/TLS authentication,
    // not a claimed GitHub human identity. Never accept an actor name from argv.
    const identity = (await pool.query('SELECT session_user AS principal')).rows[0];
    if (identity?.principal !== 'factory_runtime')
      throw new RecoveryFailure('recovery_runtime_identity_required');
    const recovery = new Recovery(pool);
    if (args[0] === 'inspect' && args.length <= 2)
      return {
        principal: identity.principal,
        ...(await recovery.inspect(args[1])),
      };
    return {
      principal: identity.principal,
      ...(await recovery.act(recoveryRequest(args))),
    };
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error) => {
      console.error(
        error instanceof RecoveryFailure
          ? error.message
          : 'recovery_failed_check_database_authentication_schema_and_availability',
      );
      process.exitCode = 1;
    });
