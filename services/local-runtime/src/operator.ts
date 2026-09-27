import { databaseConfig } from './config.js';
import { createLocalPool } from './database.js';
import { checkSchema } from './migrate.js';
import { verifyDatabase } from './verify-database.js';

const pool = createLocalPool(databaseConfig(process.env));
try {
  await checkSchema(pool);
  if (process.argv[2] === 'demo-status') {
    console.log(
      JSON.stringify(
        (
          await pool.query(
            'SELECT work_id,agent,result FROM factory_demo_effects ORDER BY work_id DESC LIMIT 20',
          )
        ).rows,
      ),
    );
  } else if (process.argv[2] === 'verify-database') {
    console.log(JSON.stringify(await verifyDatabase(pool)));
  } else throw new Error('unknown_operator_command');
} finally {
  await pool.end();
}
