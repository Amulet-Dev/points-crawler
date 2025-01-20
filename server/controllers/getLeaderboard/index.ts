import Database from 'bun:sqlite';
import { Logger } from 'pino';
import { TRPCError } from '@trpc/server';
import {
    LeaderboardData,
    tRPCLeaderboardResponse,
} from '../../../types/tRPC/tRPCGetLeaderboard';
import { toErrMsg } from '../../../lib/utils';

interface UserPointsPublicRow {
    address: string;
    asset_id: string;
    points: number;
    change: number;
    prev_points_l1: number;
    prev_points_l2: number;
    points_l1: number;
    points_l2: number;
    place: number;
    prev_place: number;
}

function redactAddress(address: string): string {
    if (address.length < 10) return '*'.repeat(address.length);

    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function getLeaderboard(db: Database, _logger: Logger) {
    return function(): tRPCLeaderboardResponse {
        try {
            const sql = `
                SELECT *
                FROM user_points_public
                ORDER BY points DESC
                LIMIT 25
            `;
            const rows = db.query<UserPointsPublicRow, []>(sql).all();

            const leaderboardData: LeaderboardData[] = rows.map((row, idx) => {
                return {
                    redactedAddress: redactAddress(row.address),
                    points: row.points,
                    change: row.change,
                    rank: idx + 1,
                };
            });

            return {
                data: leaderboardData,
            };
        } catch (err) {
            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: toErrMsg(err),
            });
        }
    };
}
