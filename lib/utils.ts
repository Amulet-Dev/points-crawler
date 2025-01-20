import { createReadStream } from 'fs';
import { join } from 'path';
import { parse } from 'fast-csv';
import Database from 'bun:sqlite';
import { table as createTable } from 'table';

export async function parseCSV(filePath: string): Promise<string[][]> {
    return new Promise((res, rej) => {
        const rows: string[][] = [];

        createReadStream(filePath)
            .pipe(parse({ headers: false }))
            .on('data', (row) => {
                // Store each row making sure each value is cast to a string
                rows.push(Object.values(row).map(String));
            })
            .on('end', () => res(rows))
            .on('error', (err) => rej(err));
    });
}

export function toErrMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/*
 * backupDb()
 * Creates a backup of the SQLite data.db file
 * @returns the file path of the backup
 * */
export async function backupDb(backupDir: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
        try {
            const script = join(import.meta.dir, '../backup.sh');
            const dir = join(import.meta.dir, `../${backupDir}`);

            const proc = Bun.spawn({
                cmd: [script, dir],
                stdout: 'pipe',
                stderr: 'pipe',
            });

            const output = await new Response(proc.stdout).text();
            const errorOutput = await new Response(proc.stderr).text();

            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                return reject(
                    new Error(
                        `Backup script exited with code ${exitCode}\nStderr: ${errorOutput}`,
                    ),
                );
            }

            if (output.includes('Backup failed!')) {
                return reject(
                    new Error(`Backup script reported failure.\nOutput: ${output}`),
                );
            }

            const match = output.match(/Backup created successfully:\s+(.*)/);
            if (!match || !match[1]) {
                return reject(
                    new Error(`Could not parse backup path.\nOutput: ${output}`),
                );
            }
            resolve(match[1].trim());
        } catch (err) {
            reject(err);
        }
    });
}

export function compareUserPoints(db: Database, backupConn: Database) {
    type QueryReturnType = {
        address: string;
        points: number;
        change: number;
    };
    const currentRows = db
        .query<
            QueryReturnType,
            null
        >('SELECT address, points, change FROM user_points_public')
        .all(null);
    const backupRows = backupConn
        .query<
            QueryReturnType,
            null
        >('SELECT address, points, change FROM user_points_public')
        .all(null);

    const currentMap = buildUserPointMap(currentRows);
    const backupMap = buildUserPointMap(backupRows);
    const allAddresses = new Set([...currentMap.keys(), ...backupMap.keys()]);

    // Setup output table headers
    const tableData = [];
    tableData.push([
        'Address',
        'Old Points',
        'New Points',
        'Pts Δ',
        'Old Change',
        'New Change',
        'Chg Δ',
        'State',
    ]);

    for (const address of allAddresses) {
        const oldVal = backupMap.get(address);
        const newVal = currentMap.get(address);

        // If a row doesn't exist in backup or current, treat missing values as 0
        const oldPoints = oldVal?.points ?? 0;
        const newPoints = newVal?.points ?? 0;
        const oldChange = oldVal?.change ?? 0;
        const newChange = newVal?.change ?? 0;

        let state: 'new' | 'deleted' | 'updated' | 'unchanged';

        if (!oldVal && newVal) {
            state = 'new';
        } else if (oldVal && !newVal) {
            state = 'deleted';
        } else if (oldVal && newVal) {
            if (oldPoints !== newPoints || oldChange !== newChange) {
                state = 'updated';
            } else {
                state = 'unchanged';
            }
        } else {
            state = 'unchanged';
        }

        if (state === 'unchanged') {
            continue;
        }

        tableData.push([
            address,
            oldPoints,
            newPoints,
            newPoints - oldPoints,
            oldChange,
            newChange,
            newChange - oldChange,
            state,
        ]);
    }

    if (tableData.length === 1) {
        // Means we only have the header row => everything was unchanged
        return 'No changes found.\n';
    }

    // 4. Produce the table string
    const output = createTable(tableData);
    return output;
}

function buildUserPointMap(
    rows: { address: string; points: number; change: number }[],
): Map<string, { points: number; change: number }> {
    const map = new Map<string, { points: number; change: number }>();
    for (const row of rows) {
        map.set(row.address, { points: row.points, change: row.change });
    }
    return map;
}
