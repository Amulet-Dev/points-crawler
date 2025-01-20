import { z } from 'zod';

export const tRPCGetSupplyResponseSchema = z.object({
    supply: z.number(),
});

export type tRPCSupplyResponse = {
    supply: number;
};
