import 'dotenv/config';
import { Command } from 'commander';
import { HydroAllocation, connect } from '../db';
import { getLogger } from '../lib/logger';
import sources from '../lib/sources';
import { UserBalance } from '../types/sources/userBalance';
import { writeFileSync, readFileSync } from 'fs';
import toml from 'toml';
import { updateReferralData } from '../lib/referral';
import { toNeutronAddress } from '../lib/neutron-address';
import PriceFeed from '../lib/pricefeed';
import { insertKYCRecord } from '../lib/kyc';
import { neutronAddress } from '../types/tRPC/neutronAddress';
import { executeSetBalances } from '../lib/execute';
import { getSigningCosmWasmClient } from '../lib/stargate';
import { validateOnChainContractInfo } from '../lib/validations/config';
import { getValidData } from '../types/utils';
import { dropletRuleSchema } from '../types/config/dropletRule';
import { backupDb, compareUserPoints, parseCSV } from '../lib/utils';
import { join } from 'path';
import Database from 'bun:sqlite';

const HYDRO_POT_SIZE = 250000;

const program = new Command();
program.option('--config <config>', 'Config file path', 'config.toml');

const config = toml.parse(
    readFileSync(program.getOptionValue('config'), 'utf-8'),
);
if (!config.log_level) {
    throw new Error('LOG_LEVEL environment variable not set');
}

function fromDenom(amount: number, decimals: number): number {
    return amount / Math.pow(10, decimals);
}

validateOnChainContractInfo(config);

const logger = getLogger(config);
const db = connect(true, config, logger);

const getAssetMulsByProtocolAndBatchId = (
    protocolId: string,
    batchId: number,
) => {
    const query = db.query<
        { protocol_id: string; asset_id: string; multiplier: number },
        [number, string]
    >(
        `
    WITH batch_ts AS (
      SELECT ts FROM batches WHERE batch_id = ?
    )
    SELECT 
      protocol_id, asset_id, multiplier
    FROM
    (
      SELECT * FROM 
        (
          SELECT 
            * 
          FROM schedule s
          LEFT JOIN 
            batches bt ON (bt.ts > s.start AND bt.ts < s.end)
          WHERE 
            protocol_id = ? AND
            ((s.start = 0 AND s.end = 0) OR bt.ts IS NOT NULL)
          ORDER BY protocol_id, schedule_id DESC
        ) a 
      GROUP BY a.protocol_id, a.asset_id
    ) b
    WHERE b.enabled = 1;
    `,
    );
    return query
        .all(batchId, protocolId)
        .reduce((acc, row) => ({ ...acc, [row.asset_id]: row.multiplier }), {});
};

program
    .command('manual-task')
    .description('Manually add tasks with specified block height and timestamp')
    .option('-t --timestamp <timestamp>', 'Timestamp to use')
    .option('-h --height <height>', 'Block height to use')
    .option('-j --jitter <jitter>', 'Jitter to use')
    .action(async (options) => {
        const ts = parseInt(options.timestamp, 10);
        const height = parseInt(options.height, 10);
        const jitter = parseInt(options.jitter, 10);

        if (!ts || !height || !jitter) {
            throw new Error('Timestamp and height must be provided.');
        }

        // Check if batch already exists with the given timestamp
        const existingBatchQuery = db.prepare<{ batch_id: number }, number>(
            'SELECT batch_id FROM batches WHERE ts = ?',
        );
        const existingBatch = existingBatchQuery.get(ts);

        let batchId;
        if (existingBatch) {
            // Reuse existing batch
            batchId = existingBatch.batch_id;
            logger.info('Reusing existing batch %d for timestamp %d', batchId, ts);
        } else {
            // Insert new batch
            const queryInsertBatch = db.prepare<
                { batch_id: number },
                [number, string]
            >('INSERT INTO batches (ts, status) VALUES (?, ?) RETURNING batch_id');
            batchId = queryInsertBatch.get(ts, 'manual')?.batch_id;
            if (!batchId) {
                throw new Error('Failed to insert batch');
            }
            logger.info('Inserted manual batch %d', batchId);
        }

        // Pre-check if all tasks already exist
        const existingTasksCheck = db.prepare<{ count: number }, [number, number]>(`
          SELECT COUNT(*) as count FROM tasks
          WHERE batch_id = ? AND height = ? AND protocol_id IN (
              SELECT protocol_id FROM schedule WHERE enabled = 1
          )`);
        const existingTasksCount = existingTasksCheck.get(batchId, height);
        if (!existingTasksCount) {
            logger.error('Task count query failed');
            return;
        }

        // If the count of existing tasks matches the number of enabled protocols, exit early
        const protocolCountQuery = db.prepare<{ count: number }, null>(
            'SELECT COUNT(DISTINCT protocol_id) as count FROM schedule WHERE enabled = 1',
        );
        const totalProtocols = protocolCountQuery.get(null);
        if (!totalProtocols) {
            logger.error('Protocol count query failed');
            return;
        }

        if (existingTasksCount.count >= totalProtocols.count) {
            logger.info(
                'All tasks already exist for batch %d and height %d. Exiting early.',
                batchId,
                height,
            );
            return;
        }

        const tasksCheck = db.prepare<{ count: number }, [string, number, number]>(
            'SELECT COUNT(*) as count FROM tasks WHERE protocol_id = ? AND batch_id = ? AND height = ?',
        );

        const tasksTx = db.prepare(
            'INSERT INTO tasks (protocol_id, batch_id, height, status, jitter, ts) VALUES (?, ?, ?, ?, ?, ?)',
        );

        const query = db.query<
            { protocol_id: string; asset_id: number; multiplier: number },
            null
        >(
            `SELECT protocol_id, asset_id, multiplier FROM schedule WHERE enabled = 1`,
        );
        const protocolsInDb = query.all(null);

        if (!protocolsInDb.length) {
            logger.info('No protocols found in the schedule');
            return;
        }

        for (const protocol of protocolsInDb) {
            const c = tasksCheck.get(protocol.protocol_id, batchId, height);
            const taskExists = c && c.count > 0;
            if (!taskExists) {
                tasksTx.run(protocol.protocol_id, batchId, height, 'new', jitter, ts);
                logger.info('Inserted new task for protocol %s', protocol.protocol_id);
            } else {
                logger.info(
                    'Task already exists for protocol %s',
                    protocol.protocol_id,
                );
            }
        }

        tasksTx.finalize();
        logger.info(
            'Manually added tasks with height %d and timestamp %d',
            height,
            ts,
        );
    });

program
    .command('prepare')
    .description('Prepare tasks for processing sources')
    .option('-t --timestamp <timestamp>', 'Timestamp to use')
    .action(async (options) => {
        const ts = parseInt(
            options.timestamp || (Date.now() / 1000).toString(),
            10,
        );

        const query = db.query<
            { protocol_id: string; asset_id: number; multiplier: number },
            [number, number]
        >(
            `
      SELECT 
        protocol_id, asset_id, multiplier
      FROM
      (
        SELECT * FROM 
          (
              SELECT 
                * 
              FROM schedule s
              LEFT JOIN 
                batches bt ON  bt.ts > s.start AND bt.ts < s.end
              WHERE 
                ((s.start = 0 AND s.end = 0) OR bt.ts IS NOT NULL)
              ORDER BY protocol_id, schedule_id DESC
        ) a GROUP BY a.protocol_id
      ) b
      WHERE b.enabled = 1`,
        );
        const protocolsInDb = query.all(ts, ts);
        if (!protocolsInDb.length) {
            logger.info('No protocols found in the schedule');
            return;
        }
        const queryInsertBatch = db.prepare<{ batch_id: number }, [number, string]>(
            'INSERT INTO batches (ts, status) VALUES (?, ?) RETURNING batch_id',
        );
        const batchId = queryInsertBatch.get(ts, 'new')?.batch_id;
        if (!batchId) {
            throw new Error('Failed to insert batch');
        }
        logger.info('Inserted batch %d', batchId);
        const pricesTx = db.prepare(
            'INSERT INTO prices (asset_id, batch_id, price, ts) VALUES (?, ?, ?, ?)',
        );
        const assetsToGetPrice = new Set<string>();
        const tasksTx = db.prepare(
            'INSERT INTO tasks (protocol_id, batch_id, height, status, jitter, ts) VALUES (?, ?, ?, ?, ?, ?)',
        );

        const timeShift = Math.random(); //same for all protocols bc of IBC and stuff
        for (const protocol of protocolsInDb) {
            const protocolObj = config.protocols[protocol.protocol_id];

            for (const assetId of Object.keys(protocolObj.assets)) {
                assetsToGetPrice.add(assetId);
            }

            const jitter = (protocolObj.jitter * timeShift) | 0;
            if (!jitter) {
                logger.warn('Jitter is 0 for protocol %s', protocol.protocol_id);
            }

            const source = new sources[protocolObj.source as keyof typeof sources](
                protocolObj.rpc,
                logger,
                protocolObj,
            );
            const height = await source.getLastBlockHeight();

            logger.debug(
                'Got height %d for protocol %s',
                height,
                protocol.protocol_id,
            );

            tasksTx.run(
                protocol.protocol_id,
                batchId,
                height - jitter,
                'new',
                jitter,
                ts,
            );
        }
        tasksTx.finalize();
        const priceFeed = new PriceFeed(
            config.pricefeed.rpc,
            logger,
            config.pricefeed,
        );
        const priceFeedHeight = await priceFeed.getLastHeight();
        logger.debug('Got pricefeed height %d', priceFeedHeight);
        for (const assetId of assetsToGetPrice) {
            logger.debug('Getting price for asset %s', assetId);
            const price = await priceFeed.getPrice(
                assetId,
                (priceFeedHeight - config.pricefeed.jitter * timeShift) | 0,
            );
            pricesTx.run(assetId, batchId, price, ts);
        }
        pricesTx.finalize();
    });

program
    .command('crawl')
    .argument('<protocol_id>', 'protocol to crawl')
    .description('Process the specified protocol')
    .option('-b --batch_id <batch_id>', 'Batch ID to process')
    .action(async (protocolId: string, options) => {
        // Get the batch ID and height of the task
        const { batchId, height } = (() => {
            if (options.batch_id) {
                const batchId = parseInt(options.batch_id, 10);
                if (isNaN(batchId)) {
                    logger.error('Invalid batch ID %s', options.batch_id);
                    throw new Error('Invalid batch ID');
                }
                const row = db
                    .query<
                        { height: number; ts: number },
                        [number, string]
                    >('SELECT height, ts FROM tasks WHERE batch_id = ? AND protocol_id = ? AND status = "new" ORDER BY batch_id ASC LIMIT 1')
                    .get(batchId, protocolId);
                if (!row) {
                    logger.info('No tasks found for batch_id %s', options.batch_id);
                    throw new Error('No tasks found');
                }
                return { batchId, height: row.height };
            } else {
                const row = db
                    .query<
                        { height: number; batch_id: number; ts: number },
                        string
                    >('SELECT height, batch_id, ts FROM tasks WHERE protocol_id = ? AND status = "new" ORDER BY batch_id ASC LIMIT 1')
                    .get(protocolId);
                if (!row) {
                    logger.info('No tasks found for protocol %s', protocolId);
                    throw new Error('No tasks found');
                }
                return {
                    batchId: row.batch_id,
                    height: row.height,
                };
            }
        })();
        const multipliers = getAssetMulsByProtocolAndBatchId(protocolId, batchId);
        logger.info(
            'Processing task for protocol %s, height %d and batch_id %d multipliers %o',
            protocolId,
            height,
            batchId,
            multipliers,
        );
        // Processing the source
        const sourceObj = new sources[
            config.protocols[protocolId].source as keyof typeof sources
        ](config.protocols[protocolId].rpc, logger, config.protocols[protocolId]);
        await sourceObj.getUsersBalances(
            height,
            multipliers,
            (balances: UserBalance[]) => {
                const query = db.prepare<
                    unknown,
                    [number, string, string, number, string, string]
                >(
                    'INSERT INTO user_data (batch_id, address, protocol_id, height, asset, balance) VALUES (?, ?, ?, ?, ?, ?);',
                );
                const insert = db.transaction((balances) => {
                    for (const balance of balances) {
                        // Get the decimals from the config for the asset
                        // const decimals =
                        //     config.protocols.neutron.assets[balance.asset]?.decimals || 6; // Default to 6 if undefined

                        // Convert the balance to a human-readable format
                        const humanReadableBalance = fromDenom(Number(balance.balance), 6);

                        // Save the converted balance to the database
                        query.run(
                            batchId,
                            toNeutronAddress(balance.address),
                            protocolId,
                            height,
                            balance.asset,
                            humanReadableBalance.toFixed(6),
                        );
                    }
                    return balances.length;
                });
                const res = insert(balances);
                logger.info('Inserted %d user balances', res);
            },
        );
        // Update the status of the task to "ready"
        db.exec<[string, number]>(
            'UPDATE tasks SET status = "ready" WHERE protocol_id = ? AND batch_id = ?',
            [protocolId, batchId],
        );
        logger.info('Task has been processed');
    });

program
    .command('finish')
    .description('Calculate points for users and finish the task')
    .option('-b, --batch_id <batch_id>', 'batch ID  to finish')
    .option('-p --publish', 'Publish the points to the blockchain')
    .action((options) => {
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
                const query = db.query<{ batch_id: number }, [number]>(
                    'SELECT batch_id FROM tasks WHERE status = "ready" AND batch_id = ? ORDER BY batch_id ASC LIMIT 1',
                );
                const row = query.get(options.batch_id);
                if (!row) {
                    logger.info('No tasks found for batch_id %s', options.batch_id);
                }
                query.finalize();
                return row?.batch_id;
            }
        })();
        if (!batchId) {
            logger.info('No tasks for finishing found');
            return;
        }
        logger.info('Finishing task for batch_id %s', batchId);

        const query = db.query<{ cnt: number }, number>(
            'SELECT count(*) as cnt FROM tasks WHERE batch_id = ? AND status NOT IN ("ready", "processed")',
        );

        const cnt = query.get(batchId)?.cnt;
        if (cnt !== 0) {
            logger.error('Not all tasks are ready');
            return;
        }

        logger.info('All tasks are ready');

        let tsKf = 0;
        if (batchId > 1) {
            const query = db.query<{ ts: number }, [number, number]>(
                'SELECT ts FROM batches WHERE batch_id = ? OR batch_id = ? - 1 ORDER BY batch_id DESC LIMIT 2',
            );
            const [ts1, ts2] = query.all(batchId, batchId).map((row) => row.ts);
            tsKf = (ts1 - ts2) / (24 * 60 * 60);
        } else {
            tsKf = config.default_interval / (24 * 60 * 60);
        }
        logger.debug('tsKf = %d', tsKf);

        // Fetch the total points in the system
        const tx = db.transaction(() => {
            const readyTasksQuery = db.query<{ count: number }, [number]>(
                'SELECT COUNT(*) as count FROM tasks WHERE batch_id = ? AND status = "ready"',
            );
            const readyTaskCount = readyTasksQuery.get(batchId)?.count;

            if (readyTaskCount === 0) {
                logger.info('No "ready" tasks found to process');
                return;
            }

            // Calculate points for each user based on all sources
            db.exec<[number]>(
                `
            INSERT OR REPLACE
              INTO user_points (batch_id, address, asset_id, points)
              SELECT
                batch_id, address, xasset_id asset_id, points
              FROM
                (
                  SELECT
                    ud.batch_id,
                    ud.address,
                    CASE
                      WHEN INSTR(ud.asset, '_') > 0
                      THEN SUBSTR(ud.asset, 1, INSTR(ud.asset, '_') - 1)
                      ELSE ud.asset
                END AS xasset_id,
                    FLOOR(SUM(p.price * ud.balance * ${tsKf})) points
                  FROM
                    user_data ud
                  LEFT JOIN
                    prices p ON (p.asset_id = xasset_id AND p.batch_id = ud.batch_id)
                  WHERE
                    ud.batch_id = ?
                  AND
                    address NOT IN (select address from blacklist)
                  GROUP BY
                    ud.batch_id, ud.address, xasset_id
                ) x
            `,
                [batchId],
            );

            db.exec<[number]>(
                'UPDATE tasks SET status = "processed" WHERE batch_id = ?',
                [batchId],
            );

            if (options.publish) {
                logger.debug('Publishing points to users_points_public');

                const query = db.query<{ batch_id: number; ts: number }, string>(
                    `SELECT batch_id, ts FROM batches WHERE status = ? ORDER BY batch_id ASC`,
                );
                const all = query.all('new');
                const batchIds = all.map((row) => row.batch_id);
                logger.debug('Batch IDs: %s', batchIds.join(','));
                const firstTs = all[0].ts;

                db.exec(`UPDATE user_points_public SET change = 0`);

                db.exec(
                    `
          INSERT INTO user_points_public (address, asset_id, points, change, prev_points_l1, prev_points_l2, points_l1, points_l2, place, prev_place)
          SELECT 
            address, asset_id, SUM(points) points, SUM(points) change, 0, 0, 0, 0, 0, 0
          FROM
            user_points
          WHERE
            batch_id IN (${batchIds.join(',')})
          GROUP BY 
            address, asset_id
          ON CONFLICT (address, asset_id) DO UPDATE SET
            change = excluded.change,
            points = user_points_public.points + excluded.points
          `,
                );

                // select all referrers who are not in user_points_public and insert them into user_points_public for all assets
                // bc we need to calculate L1, L2 points for users who have no points
                db.exec(
                    `
            INSERT OR IGNORE INTO user_points_public
                (address, asset_id, points, "change", prev_points_l1, prev_points_l2, points_l1, points_l2, place, prev_place)
            SELECT 
              r.referrer address,
              replace(replace(replace(s.asset_id, '_NTRN',''), '_ATOM', ''), '_USDC','') asset_id,
              0 points,
              0 change,
              0 prev_points_l1,
                0 prev_points_l2,
                0 points_l1,
                0 points_l2,
                0 place,
                0 prev_place
            FROM referrals r
            LEFT JOIN schedule s
            GROUP BY address;
            `,
                );

                // calc L1, L2 points
                const stmt = db.prepare<null, { $ts: number }>(
                    `
          UPDATE 
            user_points_public
          SET 
            prev_points_l1 = points_l1,
            prev_points_l2 = points_l2,
            points_l1 = COALESCE(points_l1,0) + COALESCE((
              SELECT 
                FLOOR(SUM(upp1.change) * ${config.l1_percent / 100})
              FROM 
                referrals r
              LEFT JOIN user_points_public upp1 ON (upp1.address = r.referral AND r.ts <= $ts)
              LEFT JOIN user_kyc k ON (k.address = r.referrer AND k.ts <= $ts)
              WHERE
                r.referrer = user_points_public.address AND
                k.address IS NOT NULL
            ),0),
            points_l2 = COALESCE(points_l2,0) + COALESCE((
              SELECT 
                FLOOR(SUM(upp2.change) * ${config.l2_percent / 100})
              FROM 
                referrals r2
              LEFT JOIN referrals r3 ON (r3.referrer = r2.referral AND r3.ts <= $ts)
              LEFT JOIN user_points_public upp2 ON (upp2.address = r3.referral AND r3.ts <= $ts)
              LEFT JOIN user_kyc k2 ON (k2.address = r2.referrer AND k2.ts <= $ts)
              WHERE
                r2.referrer = user_points_public.address AND
                k2.address IS NOT NULL
            ),0)
          `,
                );
                stmt.run({ $ts: firstTs });

                db.exec(
                    `
            UPDATE 
              user_points_public
            SET
              change = change + (points_l1 + points_l2) - (prev_points_l1 + prev_points_l2)
          `,
                );

                db.exec(
                    `
                    WITH aggregated AS (
                        SELECT 
                            address, 
                            SUM(points + points_l1 + points_l2) AS total_points
                        FROM user_points_public
                        GROUP BY address
                    ),
                    ranked AS (
                        SELECT 
                            address,
                            ROW_NUMBER() OVER (ORDER BY total_points DESC) AS new_place
                        FROM aggregated
                    )
                    UPDATE user_points_public
                    SET 
                    prev_place = place,
                    place = (SELECT new_place 
                        FROM ranked 
                            WHERE ranked.address = user_points_public.address);
                    `,
                );

                db.exec(
                    `UPDATE batches SET status="processed" WHERE batch_id IN (${batchIds.join(',')})`,
                );
            }
        });

        tx();
        logger.info('Task has been finished');
    });

program
    .command('publish_on_chain')
    .description('Publish points to CW20 contract')
    .action(async () => {
        const publicPointsQuery = db.query<
            {
                address: string;
                points: number;
            },
            null
        >(
            'SELECT address, points + points_l1 + points_l2 as points FROM user_points_public',
        );
        const publicPoints = publicPointsQuery.all(null);

        const {
            on_chain_storage: {
                sender,
                contract,
                rpc,
                gas,
                mnemonic,
                batch_size: batchSize = null,
                gas_adjustment: gasAdjustment = null,
            },
        } = config;

        const signingClient = await getSigningCosmWasmClient(rpc, gas, mnemonic);

        while (publicPoints.length) {
            await executeSetBalances(
                signingClient,
                sender,
                contract,
                publicPoints.splice(0, batchSize || 1000),
                gasAdjustment,
                logger,
            );
        }

        logger.info('Points have been saved to the on chain contract');
    });

program
    .command('recalculate')
    .description(
        'Recalculate user points and user data for a specific batch or set of batch IDs',
    )
    .option(
        '-b, --batch_ids <batch_ids>',
        'Comma-separated list of batch IDs to recalculate',
    )
    .option(
        '-p, --protocol_id <protocol_id>',
        'Protocol to recalculate user data for',
    )
    .action(async (options: { protocol_id: string; batch_ids: string }) => {
        const protocolId = options.protocol_id;
        const batchIds = options.batch_ids
            .split(',')
            .map((id) => parseInt(id.trim(), 10));

        if (batchIds.some(isNaN)) {
            logger.error('Invalid batch IDs provided');
            return;
        }

        logger.info(
            'Recalculating points and user data for batch IDs: %s',
            batchIds.join(', '),
        );

        const recalculateUserData = async (batchId: number) => {
            // Find the height for the given batch ID and protocol
            const row = db
                .query<
                    { height: number },
                    [number, string]
                >('SELECT height FROM tasks WHERE batch_id = ? AND protocol_id = ? LIMIT 1')
                .get(batchId, protocolId);

            if (!row) {
                logger.error(
                    'No height found for batch ID %d and protocol %s',
                    batchId,
                    protocolId,
                );
                throw new Error('Height not found for this batch');
            }

            const height = row.height;
            logger.info(
                'Found height %d for batch ID %d and protocol %s',
                height,
                batchId,
                protocolId,
            );

            // Delete existing user_data for the batch
            db.exec<[number, string]>(
                'DELETE FROM user_data WHERE batch_id = ? AND protocol_id = ?',
                [batchId, protocolId],
            );
            logger.info('Removed old user data for batch %d', batchId);

            // Logic to re-fetch balances and reinsert them into user_data
            const multipliers = getAssetMulsByProtocolAndBatchId(protocolId, batchId);
            const sourceObj = new sources[
                config.protocols[protocolId].source as keyof typeof sources
            ](config.protocols[protocolId].rpc, logger, config.protocols[protocolId]);
            await sourceObj.getUsersBalances(
                height, // Adjust height as per your needs
                multipliers,
                (balances: UserBalance[]) => {
                    const query = db.prepare<
                        unknown,
                        [number, string, string, number, string, string]
                    >(
                        'INSERT INTO user_data (batch_id, address, protocol_id, height, asset, balance) VALUES (?, ?, ?, ?, ?, ?);',
                    );
                    const insert = db.transaction((balances) => {
                        for (const balance of balances) {
                            // const decimals =
                            //     config.protocols.neutron.assets[balance.asset]?.decimals || 6;
                            const humanReadableBalance = fromDenom(
                                Number(balance.balance),
                                6,
                            ).toFixed(6);
                            query.run(
                                batchId,
                                toNeutronAddress(balance.address),
                                protocolId,
                                height,
                                balance.asset,
                                humanReadableBalance,
                            );
                        }
                        return balances.length;
                    });
                    const res = insert(balances);
                    logger.info(
                        'Recalculated and inserted %d user balances for batch %d',
                        res,
                        batchId,
                    );
                },
            );
        };

        const recalculatePoints = async (batchId: number) => {
            let tsKf = 0;

            if (batchId > 1) {
                const query = db.query<{ ts: number }, [number, number]>(
                    'SELECT ts FROM batches WHERE batch_id = ? OR batch_id = ? - 1 ORDER BY batch_id DESC LIMIT 2',
                );
                const [ts1, ts2] = query.all(batchId, batchId).map((row) => row.ts);
                tsKf = (ts1 - ts2) / (24 * 60 * 60);
            } else {
                tsKf = config.default_interval / (24 * 60 * 60);
            }

            logger.debug('tsKf for batch %d = %d', batchId, tsKf);

            // Remove the existing points for this batch
            db.exec<[number]>('DELETE FROM user_points WHERE batch_id = ?', [
                batchId,
            ]);

            logger.info('Removed old points for batch %d', batchId);

            // Recalculate points for this batch
            db.exec<[number]>(
                `
                INSERT OR REPLACE INTO user_points (batch_id, address, asset_id, points)
                SELECT
                  ud.batch_id, ud.address,
                  CASE
                    WHEN INSTR(ud.asset, '_') > 0
                    THEN SUBSTR(ud.asset, 1, INSTR(ud.asset, '_') - 1)
                    ELSE ud.asset
                  END AS xasset_id,
                  FLOOR(SUM(p.price * ud.balance * ${tsKf})) AS points
                FROM
                  user_data ud
                LEFT JOIN
                  prices p ON (p.asset_id = xasset_id AND p.batch_id = ud.batch_id)
                WHERE
                  ud.batch_id = ?
                AND
                  ud.address NOT IN (SELECT address FROM blacklist)
                GROUP BY
                  ud.batch_id, ud.address, xasset_id
                `,
                [batchId],
            );
            logger.info('Recalculated and inserted new points for batch %d', batchId);
        };

        const recalculateUserPointsPublic = async (batchId: number) => {
            logger.debug(
                'Publishing points to user_points_public for batch %d',
                batchId,
            );

            db.exec(
                `
                    DELETE FROM user_points_public
                    WHERE EXISTS (
                        SELECT 1
                        FROM user_points
                        WHERE user_points.batch_id = ?
                            AND user_points_public.address = user_points.address
                        AND user_points_public.asset_id = user_points.asset_id
                    );
                 `,
                [batchId],
            );
            logger.info(
                'Cleared entries from user_points_public for batch %d',
                batchId,
            );

            // Sum points from all batches (not just the current one)
            db.exec(
                `INSERT INTO user_points_public (address, asset_id, points, change, prev_points_l1, prev_points_l2, points_l1, points_l2, place, prev_place)
                 SELECT address, asset_id, SUM(points) points, SUM(points), 0, 0, 0, 0, 0, 0
                 FROM user_points
                 WHERE address NOT IN (SELECT address FROM blacklist)
                 GROUP BY address, asset_id
                 ON CONFLICT (address, asset_id) DO UPDATE 
                 SET points = user_points_public.points + excluded.points,
                     change = excluded.change;`,
            );
            logger.info('Updated user_points_public for batch %d', batchId);

            // Perform other updates like L1/L2 points calculation
            db.exec(
                `UPDATE user_points_public 
                 SET prev_points_l1 = points_l1, 
                     prev_points_l2 = points_l2, 
                     points_l1 = 0,  /* Add your logic for L1 here */
                     points_l2 = 0   /* Add your logic for L2 here */
                 WHERE address IN (SELECT address FROM user_points WHERE batch_id = ?);`,
                [batchId],
            );

            db.exec(
                `UPDATE user_points_public 
                 SET change = change + (points_l1 + points_l2) - (prev_points_l1 + prev_points_l2);`,
            );

            db.exec(`UPDATE batches SET status="processed" WHERE batch_id = ?`, [
                batchId,
            ]);

            logger.info(
                'Recalculated and published user points public for batch %d',
                batchId,
            );
        };

        for (const batchId of batchIds) {
            await recalculateUserData(batchId);
            await recalculatePoints(batchId);
            await recalculateUserPointsPublic(batchId);

            // After successfully recalculating, mark the tasks as processed
            db.exec<[number, string]>(
                'UPDATE tasks SET status = "processed" WHERE batch_id = ? AND protocol_id = ?',
                [batchId, protocolId],
            );

            logger.info(
                'Marked tasks as processed for batch ID %d and protocol %s',
                batchId,
                protocolId,
            );
        }

        logger.info(
            'Recalculation of points and user data complete for batch IDs: %s',
            batchIds.join(', '),
        );
    });

const hydroCli = program
    .command('hydro')
    .description('Manage rewards to Hydro voting participants');

hydroCli
    .command('prepare')
    .argument('<csv_file>', 'CSV file of Hydro votes')
    .argument('<bid_id>', 'Hydro bid id to process')
    .option(
        '-p, --pot <number>',
        'Pot of points to distribute porportionally among voters',
    )
    .action(async (csvFilePath, bidId, options) => {
        try {
            const csv = await parseCSV(csvFilePath);
            const pot: number = options.pot ? Number(options.pot) : HYDRO_POT_SIZE;
            if (!pot) throw new Error('Invalid pot size');

            let totalVotingPower = 0;
            const filteredRows: { address: string; votingPower: number }[] = [];

            // 1. Filter valid voters and sum their total voting power
            for (const row of csv) {
                // CSV is expected to be address, voting power, bid choice
                if (!row[0] || !row[1] || !row[2]) {
                    throw new Error('malfored csv data. Look for missing cells.');
                }

                const address = row[0].trim();
                const votingPower = Number.parseInt(row[1]);
                const bidVoted = row[2];

                if (bidVoted === String(bidId)) {
                    totalVotingPower += votingPower;
                    filteredRows.push({ address, votingPower });
                }
            }

            // 2. Compute user's share of the pot
            let allocated = 0;
            const results = filteredRows.map((row) => {
                const exactShare = pot * (row.votingPower / totalVotingPower);
                const flooredShare = Math.floor(exactShare);
                const fraction = exactShare - flooredShare;

                allocated += flooredShare;
                return { address: row.address, reward: flooredShare, fraction };
            });

            // 3. Distribute any leftovers
            const leftover = pot - allocated;
            if (leftover > 0) {
                logger.info(`Found ${leftover} leftover rewards.`);
                results.sort((a, b) => b.fraction - a.fraction);

                let leftoverCount = leftover;
                let index = 0;
                while (leftoverCount > 0) {
                    results[index].reward += 1;
                    leftoverCount--;
                    index++;
                    if (index >= results.length) {
                        index = 0;
                    }
                }

                logger.info(`Leftover rewards were distributed`);
            }

            // 4. Save output as JSON
            const out = join(import.meta.dir, '../static/hydro_allocation.json');
            writeFileSync(out, JSON.stringify(results, null, 2));
            logger.info(
                `Successfully prepared hydro allocation. See ${out} for results.`,
            );
        } catch (err) {
            logger.error(err);
            process.exit(1);
        }
    });

hydroCli
    .command('allocate')
    .description('Allocate rewards from a hydro_allocation.json file')
    .argument('<json>', 'JSON file of the reward distribution')
    .argument(
        '<backup dir name>',
        'Backup directory name expected to be found in project root.',
    )
    .option('-d, --debug')
    .action(async (jsonFilePath, backupDir, options) => {
        try {
            // 1. Create hydro_allocations if it doesn't exist.
            const createTable = `
                CREATE TABLE IF NOT EXISTS hydro_allocations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    address TEXT NOT NULL,
                    reward INTEGER NOT NULL,
                    group_id INTEGER NOT NULL,
                    processed INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER DEFAULT CURRENT_TIMESTAMP
                );
            `;
            db.exec(createTable);

            // 2. Find the last group id
            let groupId = 1;

            const lastGroupSql = `
                SELECT MAX(group_id) as lastGroup FROM hydro_allocations;
            `;
            const queryLastGroup = db.query<{ lastGroup: number }, null>(
                lastGroupSql,
            );
            const lastGroup = queryLastGroup.get(null)?.lastGroup;
            if (lastGroup) {
                groupId = lastGroup + 1;
            }

            // 3. Parse JSON and create db entries
            const dbEntries = [];
            const file = Bun.file(jsonFilePath);
            const contents: { address: string; reward: number }[] = await file.json();
            for (const entry of contents) {
                if (entry.reward <= 0) continue;
                dbEntries.push({
                    $address: entry.address,
                    $reward: entry.reward,
                    $group_id: groupId,
                });
            }

            // 4. Backup the database
            const backupFilePath = await backupDb(backupDir);

            // 5. Insert dbEntries into hydro_allocations
            const insertEntry = db.prepare(
                'INSERT INTO hydro_allocations (address, reward, group_id) VALUES ($address, $reward, $group_id);',
            );
            const insertEntries = db.transaction((entries) => {
                for (const entry of entries) insertEntry.run(entry);
                return entries.length;
            });

            const count = insertEntries(dbEntries);
            logger.info(`Inserted ${count} entries into hydro_allocations`);

            // 6. Update user_public_points based on hydro_allocations
            const allocationsSql = `
                SELECT * FROM hydro_allocations WHERE group_id = ? and processed = 0;
            `;
            const allocationsQuery = db.query<HydroAllocation, [number]>(
                allocationsSql,
            );
            const allocations = allocationsQuery.all(groupId);
            const selectUser = db.prepare<
                { address: string; points: number; change: number },
                [string]
            >(
                "SELECT * FROM user_points_public WHERE address = ? AND asset_id = 'hydro';",
            );
            const updateUserSql = `
                UPDATE user_points_public
                SET points = points + ?, change = change + ?
                WHERE address = ? AND asset_id = 'hydro';
            `;
            const updateUser = db.prepare<null, [number, number, string]>(
                updateUserSql,
            );

            const insertUserSql = `
                INSERT INTO user_points_public
                (address, asset_id, points, change, prev_points_l1, prev_points_l2, points_l1, points_l2, place, prev_place)
                VALUES (?, 'hydro', ?, ?, 0, 0, 0, 0, 0, 0);
            `;
            const insertUser = db.prepare<null, [string, number, number]>(
                insertUserSql,
            );

            const updateAllocationSql = `
                UPDATE hydro_allocations SET processed = 1 WHERE id = ?;
            `;
            const updateAllocation = db.prepare<null, [number]>(updateAllocationSql);

            const mergeAllocations = db.transaction((allocations) => {
                for (const a of allocations) {
                    if (!a.address) throw new Error('Found no address for allocation');
                    if (!a.reward) throw new Error('Found no reward for allocation');
                    if (!a.id) throw new Error('Found no id for allocation');

                    const user = selectUser.all(a.address);
                    if (user.length > 1)
                        throw new Error(
                            `Somehow found multiple rows for (address, asset_id='hydro') => address: ${a.address}`,
                        );

                    if (user[0]) {
                        updateUser.run(a.reward, a.reward, user[0].address);
                    } else {
                        insertUser.run(a.address, a.reward, a.reward);
                    }

                    updateAllocation.run(a.id);
                }
            });

            mergeAllocations(allocations);

            // 7. Print info based on backup and current database changes
            if (options.debug) {
                logger.info('Comparing old database and new database changes...');
                const backupConn = new Database(backupFilePath, { readonly: true });
                const tableOutput = compareUserPoints(db, backupConn);

                if (tableOutput === 'No changes found.\n') {
                    logger.info(tableOutput);
                } else {
                    logger.info('\n' + tableOutput);
                }

                backupConn.close();
            }
        } catch (err) {
            logger.error(err);
            process.exit(1);
        }
    });

const scheduleCli = program
    .command('schedule')
    .description('Schedule commands');

scheduleCli
    .command('add')
    .description('add a schedule')
    .argument('<protocol_id>', 'Protocol id')
    .argument('<asset_id>', 'dATOM, dTIA, etc')
    .argument('<start>', 'Datetime YYYY-MM-DDTHH:MM:SS.MSZ"')
    .argument('<end>', 'Datetime YYYY-MM-DDTHH:MM:SS.MSZ')
    .argument('<multiplier>', 'Decimal number')
    .argument('<enabled>', 'true or false')
    .option('-f --force')
    .action((protocolId, assetId, start, end, multiplier, enabled, options) => {
        const protocolObject = config.protocols[protocolId];
        const assetObject = config.protocols[protocolId].assets[assetId];

        if (protocolObject === undefined) {
            logger.error('Protocol %s not found', protocolId);
            throw new Error(`Protocol ${protocolId} not found`);
        }
        if (assetObject === undefined) {
            logger.error('Asset %s not found', assetId);
            throw new Error(`Asset ${assetId} not found`);
        }

        if (protocolObject.frontend_data === undefined) {
            logger.error('Protocol frontend data %s not found', protocolId);
            throw new Error(`Protocol ${protocolId} frontend data not found`);
        }
        if (assetObject.frontend_data === undefined) {
            logger.error('Asset frontend data %s not found', assetId);
            throw new Error(`Asset ${assetId} frontend data not found`);
        }

        const m = parseFloat(multiplier);
        if (isNaN(m)) {
            logger.error('Invalid multiplier %s', multiplier);
            throw new Error('Invalid multiplier');
        }
        const dateStart = (new Date(start).getTime() / 1000) | 0;
        const dateEnd = (new Date(end).getTime() / 1000) | 0;
        if (isNaN(dateStart)) {
            logger.error('Invalid start date %s', start);
            return;
        }
        if (isNaN(dateEnd) || dateEnd < Date.now() / 1000) {
            logger.error('Invalid end date %s', end);
            return;
        }
        if (dateStart >= dateEnd) {
            logger.error('End date must be greater than start date');
            return;
        }

        const enabledBool = enabled === 'true';

        if (!options.force) {
            const query = db.query<
                { count: number },
                [number, number, number, number, boolean]
            >(
                'SELECT COUNT(*) as count FROM schedule WHERE protocol_id = ? AND asset_id = ? AND start >= ? AND end <= ? AND enabled = ?',
            );
            if (
                query.get(protocolId, assetId, dateStart, dateEnd, enabledBool)?.count
            ) {
                logger.error('Schedule for this timeframe already exists');
                return;
            }
        }

        const tx = db.transaction(() => {
            const scheduleStatement = db.prepare(
                'INSERT INTO schedule (protocol_id, asset_id, multiplier, start, end, enabled) VALUES (?, ?, ?, ?, ?, ?)',
            );
            scheduleStatement.run(
                protocolId,
                assetId,
                multiplier,
                dateStart,
                dateEnd,
                enabledBool,
            );
            logger.info('Schedule has been inserted');

            let dropletRule;
            try {
                dropletRule = getValidData(
                    {
                        strategy: assetObject.frontend_data.strategy,
                        description: assetObject.frontend_data.description,
                        multiplier: assetObject.frontend_data.multiplier,
                        chain: protocolObject.frontend_data.chain_name,
                        status: assetObject.frontend_data.status,
                        link: protocolObject.frontend_data.link,
                        link_text: protocolObject.frontend_data.link_text,
                        type: assetObject.frontend_data.type,
                        featured: assetObject.frontend_data.featured,
                        visible: assetObject.frontend_data.visible,
                    },
                    dropletRuleSchema,
                    logger,
                );
            } catch (e) {
                logger.error('Cannot build valid rule for the schedule');
                return;
            }

            const ruleStatement = db.prepare(
                'INSERT INTO user_points_rules (strategy, description, multiplier, chain, status, link, link_text, type, featured, visible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            );
            ruleStatement.run(
                dropletRule.strategy,
                dropletRule.description,
                dropletRule.multiplier,
                dropletRule.chain,
                dropletRule.status,
                dropletRule.link,
                dropletRule.link_text,
                dropletRule.type,
                dropletRule.featured,
                dropletRule.visible,
            );
            logger.info('Rule has been inserted');
        });
        tx();
    });

scheduleCli
    .command('list')
    .description('Display the schedule')
    .action(() => {
        logger.info('Schedule list');
        const query = db.query<
            {
                schedule_id: number;
                protocol_id: string;
                asset_id: string;
                multiplier: number;
                start: number;
                end: number;
                enabled: boolean;
            },
            null
        >('SELECT * FROM schedule ORDER BY protocol_id, asset_id, start, end');
        for (const row of query.all(null)) {
            logger.info(
                'ID: %s\t Protocol: %s \t Asset: %s\t Mul: %s\tStart: %s End: %s %s',
                row.schedule_id.toString().padEnd(0),
                row.protocol_id.padEnd(20 - row.protocol_id.length),
                row.asset_id,
                row.multiplier.toString().padEnd(4),
                row.start.toString().padEnd(11 - row.start.toString().length),
                row.end.toString().padEnd(11 - row.end.toString().length),
                row.enabled ? 'enabled' : 'disabled',
            );
        }
    });

scheduleCli
    .command('delete')
    .description('Delete a schedule')
    .argument('<schedule_id>', 'Schedule ID')
    .action((scheduleId: string) => {
        logger.info('Deleting schedule');
        const id = parseInt(scheduleId, 10);
        if (isNaN(id)) {
            logger.error('Invalid schedule ID %s', scheduleId);
            return;
        }
        const query = db.query<{ count: number }, number>(
            'SELECT COUNT(*) as count FROM schedule WHERE schedule_id = ?',
        );
        if (!query.get(id)?.count) {
            logger.error('Schedule not found');
            return;
        }
        db.prepare<null, number>('DELETE FROM schedule WHERE schedule_id = ?').run(
            id,
        );
        logger.info('Schedule has been deleted');
    });

const referralCli = program
    .command('referral')
    .description('Referral commands');

referralCli
    .command('add')
    .argument('<referrer>', 'Address')
    .argument('<referral>', 'Address of the referral')
    .description('Add a referral')
    .action((referrer, referral) => {
        logger.info('Adding referral %s -> %s', referrer, referral);
        db.prepare<null, [string, string]>(
            'INSERT INTO referrals (referrer, referral, ts) VALUES (?, ?, 0)',
        ).run(referrer, referral);
    });

referralCli
    .command('list')
    .argument('<address>', 'Address')
    .description('List referrals')
    .action((address) => {
        logger.info('Referral list');
        const query = db.query<{ address: string; referral: string }, string>(
            'SELECT * FROM referrals WHERE address = ?',
        );
        for (const row of query.all(address)) {
            logger.info('Address: %s\t Referral: %s', row.address, row.referral);
        }
    });

referralCli
    .command('sync')
    .description('retrieve last Referral data')
    .action(async () => {
        await updateReferralData(db, config, logger);
    });

const blacklistCli = program
    .command('blacklist')
    .description('Edit address blacklist');

blacklistCli
    .command('add')
    .argument('<address>', 'Address')
    .description('Insert address into blacklist')
    .action((address) => {
        db.prepare('INSERT INTO blacklist (address) VALUES (?)').run(address);
        logger.info('Inserted %s into blacklist', address);
    });

blacklistCli
    .command('remove')
    .argument('<address>', 'Address')
    .description('Remove address from blacklist')
    .action((address) => {
        db.prepare('DELETE FROM blacklist WHERE address = ?').run(address);
        logger.info('Removed %s from blacklist', address);
    });

const kycCli = program.command('kyc').description('KYC commands');

kycCli
    .command('add')
    .argument('<address>', 'Address')
    .option('-p --provider <provider>', 'KYC provider')
    .option('-i --id <kyc_id>', 'KYC id')
    .option('-c --code <code>', 'Referral code')
    .action((address, options) => {
        address = neutronAddress.parse(address).toString();
        const kycId = options.id || `local_${address}`;
        const kycProvider = options.provider || 'local';
        const userCode = options.code as string | undefined;
        logger.info(
            'Adding KYC for address %s, kyc id: %s, kyc provider: %s',
            address,
            kycId,
            kycProvider,
        );
        const code = insertKYCRecord(
            db,
            logger,
            address,
            kycId,
            kycProvider,
            userCode,
        );
        logger.info('Referral code: %s', code);
    });

kycCli
    .command('get')
    .argument('<address>', 'Address')
    .action((address) => {
        address = neutronAddress.parse(address).toString();
        const query = db.query<
            { kyc_id: string; kyc_provider: string; ts: number },
            string
        >('SELECT kyc_id, kyc_provider, ts FROM user_kyc WHERE address = ?');
        const row = query.get(address);
        if (!row) {
            logger.info('No KYC found for address %s', address);
        } else {
            logger.info(
                'KYC id: %s, provider: %s, ts: %s',
                row.kyc_id,
                row.kyc_provider,
                new Date(row.ts * 1000).toISOString(),
            );
        }
    });

program.parse(process.argv);
