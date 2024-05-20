import 'dotenv/config';
import { Command } from 'commander';
import { connect } from '../db';
import { logger } from '../lib/logger';
import sources from '../lib/sources';

const program = new Command();
const db = connect(true);

if (!process.env.LOG_LEVEL) {
  throw new Error('LOG_LEVEL environment variable not set');
}

program
  .command('prepare')
  .description('Prepare tasks for processing sources')
  .action(async () => {
    const enabledSources = process.env.ENABLED_SOURCES?.split(',') || [];
    if (!enabledSources.length) {
      throw new Error('No active sources found, please define ENABLED_SOURCES');
    }
    logger.info('Enabled sources: %s', enabledSources);
    const getHeights = enabledSources.filter(Boolean).map((key) => {
      const source = sources[key as keyof typeof sources];
      if (!source) {
        throw new Error(`Source ${key} not found`);
      }
      return source.getLastBlockHeight();
    });

    const maxBatchId =
      db
        .query<
          { batch_id: number },
          null
        >('SELECT max(batch_id) as batch_id FROM tasks')
        .get(null)?.batch_id || 0;

    const results = await Promise.all(getHeights);
    const heights = enabledSources.reduce(
      (acc, key, idx) => [...acc, { $source: key, $height: results[idx] }],
      [] as { $source: string; $height: number }[],
    );
    logger.info('Heights: %o', heights);
    const heightJitter = parseInt(process.env.HEIGHT_JITTER || '0', 10);
    const statement = db.prepare(
      'INSERT INTO tasks (source_id, height, status, batch_id) VALUES ($source, $height, $status, $batch_id)',
    );
    const insert = db.transaction((tasks) => {
      for (const task of heights)
        statement.run({
          $source: task.$source,
          $height: task.$height - Math.floor(heightJitter * Math.random()),
          $status: 'new',
          $batch_id: maxBatchId + 1,
        });
      return tasks.length;
    });
    const res = insert(heights);
    logger.info('Inserted %d tasks', res);
  });

program
  .command('finish')
  .option('-c, --batch_id <batch_id>', 'batch ID  to finish')
  .action((options) => {
    const enabledSources = process.env.ENABLED_SOURCES?.split(',') || [];
    if (!enabledSources.length) {
      throw new Error(
        'No enabled sources found, please define ENABLED_SOURCES',
      );
    }
    const batchId = (() => {
      if (options.batch_id === undefined) {
        const row = db.query<{ batch_id: number }, null>(
          'SELECT batch_id FROM tasks WHERE status = "ready" ORDER BY height ASC LIMIT 1',
        );
        if (!row) {
          logger.info('No tasks found');
        }
        if (!row.get(null)) {
          return;
        }
        const batchId = row.get(null)?.batch_id;
        row.finalize();
        return batchId;
      } else {
        const query = db.query<{ batch_id: number }, [number, string]>(
          'SELECT batch_id FROM tasks WHERE status = "ready" AND height = ? AND source_id IN (?) ORDER BY batch_id ASC LIMIT 1',
        );
        const row = query.get(options.batch_id, enabledSources.join(', '));
        if (!row) {
          logger.info('No tasks found for batch_id %s', options.batch_id);
        }
        query.finalize();
        return row?.batch_id;
      }
    })();
    if (!batchId) {
      return;
    }
    logger.info('Finishing task for batch_id %s', batchId);
    const query = db.query<{ cnt: number }, number>(
      'SELECT count(*) as cnt FROM tasks WHERE batch_id = ? AND status = "ready"',
    );
    const cnt = query.get(batchId)?.cnt;
    if (cnt !== enabledSources.length) {
      logger.info('Not all tasks are ready');
    }
    logger.debug('All tasks are ready');
    // Calculate points for each user based on all sources
    // Update user points locally
    // Update user points in CW20 contract
    db.prepare<null, number>(
      'UPDATE tasks SET status="processed" WHERE batch_id=$batch_id',
    ).run(batchId);
  });

program
  .command('process <source>')
  .description('Process the specified source')
  .option('-b --batch_id <batch_id>', 'Batch ID to process')
  .action((source) => {
    // Logic for processing the source
    console.log(`Processing source: ${source}`);
  });

program.parse(process.argv);
