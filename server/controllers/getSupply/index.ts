import Database from 'bun:sqlite';
import { Logger } from 'pino';
import { TRPCError } from '@trpc/server';
import { toErrMsg } from '../../../lib/utils';
import { tRPCSupplyResponse } from '../../../types/tRPC/tRPCGetSupply';

export function getSupply(db: Database, _logger: Logger) {
    return function(): tRPCSupplyResponse {
        try {
            const sql = `
                SELECT SUM(points) AS total_points 
                FROM user_points_public
            `;
            const supply = db.query<{ total_points: number }, []>(sql).get();
            if (!supply) throw new Error('failed to find total supply of ingots');

            return {
                supply: supply.total_points,
            };
        } catch (err) {
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: toErrMsg(err),
            });
        }
    };
}
