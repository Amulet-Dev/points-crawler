import { createReadStream } from 'fs';
import { join } from 'path';
import { parse } from 'fast-csv';

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
    return new Promise(async (res, rej) => {
        try {
            const script = join(import.meta.dir, '../backup.sh');
            const dir = join(import.meta.dir, `../${backupDir}`);

            const proc = Bun.spawn({
                cmd: [script, dir],
            });

            const text = await new Response(proc.stdout).text();
            const parts = text.split(':');
            if (!parts[1]) throw new Error('failed to create backup');
            res(parts[1].trim());
        } catch (err) {
            rej(err);
        }
    });
}
