import { z } from 'zod';

const tRPCLeaderboardDataSchema = z.object({
    redactedAddress: z.string(),
    points: z.number(),
    change: z.number(),
    rank: z.number(),
});

export const tRPCGetLeaderboardResponseSchema = z.object({
    data: z.array(tRPCLeaderboardDataSchema),
});

export type LeaderboardData = {
    redactedAddress: string;
    points: number;
    change: number;
    rank: number;
};

export type tRPCLeaderboardResponse = {
    data: LeaderboardData[];
};
