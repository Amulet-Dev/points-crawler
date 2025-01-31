import dotenv from 'dotenv';
dotenv.config();

import * as trpcExpress from '@trpc/server/adapters/express';
import express from 'express';
import toml from 'toml';
import fs from 'fs';
import cors from 'cors';

import { publicProcedure, router } from './trpc';

import { getLeaderboard } from './controllers/getLeaderboard';
import { getSupply } from './controllers/getSupply';
import { getDroplets } from './controllers/getDroplets';
import { postKyc } from './controllers/postKyc';
import { getReferralCode } from './controllers/getReferralCode';
import { getReferrer } from './controllers/getReferrer';
import { getReferrals } from './controllers/getReferrals';
import { getRules } from './controllers/getRules';
import { getLogger } from '../lib/logger';
import {
    tRPCGetDropletsRequestSchema,
    tRPCGetDropletsResponseSchema,
} from '../types/tRPC/tRPCGetDroplets';
import {
    tRPCPostKycRequestSchema,
    tRPCPostKycResponseSchema,
} from '../types/tRPC/tRPCPostKyc';
import {
    tRPCGetReferralCodeRequestSchema,
    tRPCGetReferralCodeResponseSchema,
} from '../types/tRPC/tRPCGetReferralCode';
import {
    tRPCGetReferrerRequestSchema,
    tRPCGetReferrerResponseSchema,
} from '../types/tRPC/tRPCGetReferrer';
import {
    tRPCGetReferralsRequestSchema,
    tRPCGetReferralsResponseSchema,
} from '../types/tRPC/tRPCGetReferrals';
import { tRPCGetRulesResponseSchema } from '../types/tRPC/tRPCGetRules';
import { connect } from '../db';
import { Command } from 'commander';
import { getRegistry } from './prometeus';
import {
    tRPCPostKVDataRequestSchema,
    tRPCPostKVDataResponseSchema,
} from '../types/tRPC/tRPCPostKVData';
import { postKVData } from './controllers/postKVData';
import { getKVData } from './controllers/getKVData';
import {
    tRPCGetKVDataRequestSchema,
    tRPCGetKVDataResponseSchema,
} from '../types/tRPC/tRPCGetKVData';
import {
    tRPCGetStakerStatusRequestSchema,
    tRPCGetStakerStatusResponseSchema,
} from '../types/tRPC/tRPCGetStakerStatus';
import { GetStakerStatus } from './controllers/getStakerStatus';
import { tRPCGetLeaderboardResponseSchema } from '../types/tRPC/tRPCGetLeaderboard';
import { tRPCGetSupplyResponseSchema } from '../types/tRPC/tRPCGetSupply';

const expressApp = express();

const program = new Command();
program.option('--config <config>', 'Config file path', 'config.toml');

const config = toml.parse(
    fs.readFileSync(program.getOptionValue('config'), 'utf-8'),
);
if (!config.log_level) {
    throw new Error('LOG_LEVEL environment variable not set');
}
const logger = getLogger(config);
const db = connect(true, config, logger);

const appRouter = router({
    getDroplets: publicProcedure
        .input(tRPCGetDropletsRequestSchema)
        .output(tRPCGetDropletsResponseSchema)
        .query(getDroplets(db, logger)),
    postKyc: publicProcedure
        .input(tRPCPostKycRequestSchema)
        .output(tRPCPostKycResponseSchema)
        .mutation(postKyc(db, logger)),
    postKVData: publicProcedure
        .input(tRPCPostKVDataRequestSchema)
        .output(tRPCPostKVDataResponseSchema)
        .mutation(postKVData(db, logger)),
    getKVData: publicProcedure
        .input(tRPCGetKVDataRequestSchema)
        .output(tRPCGetKVDataResponseSchema)
        .query(getKVData(db, logger)),
    getReferralCode: publicProcedure
        .input(tRPCGetReferralCodeRequestSchema)
        .output(tRPCGetReferralCodeResponseSchema)
        .query(getReferralCode(db, logger)),
    getReferrer: publicProcedure
        .input(tRPCGetReferrerRequestSchema)
        .output(tRPCGetReferrerResponseSchema)
        .query(getReferrer(db, logger)),
    getStakerStatus: publicProcedure
        .input(tRPCGetStakerStatusRequestSchema)
        .output(tRPCGetStakerStatusResponseSchema)
        .query(GetStakerStatus(config.referral.graphql_url, logger)),
    getReferrals: publicProcedure
        .input(tRPCGetReferralsRequestSchema)
        .output(tRPCGetReferralsResponseSchema)
        .query(getReferrals(db, config, logger)),
    getRules: publicProcedure
        .output(tRPCGetRulesResponseSchema)
        .query(getRules(db, logger)),
    getLeaderboard: publicProcedure
        .output(tRPCGetLeaderboardResponseSchema)
        .query(getLeaderboard(db, logger)),
    getSupply: publicProcedure
        .output(tRPCGetSupplyResponseSchema)
        .query(getSupply(db, logger)),
});

const port = Number(process.env.CRAWLER_PORT) || 3000;

const register = getRegistry(config, db);

function getAllowedOrigins(): string[] {
    const origins = process.env.CRAWLER_ALLOWED_ORIGINS;
    logger.info(`Found allowed origins: ${process.env.CRAWLER_ALLOWED_ORIGINS}`);
    if (!origins) {
        return [];
    }

    return origins
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

expressApp.get('/metrics', async (_req, res, next) => {
    res.setHeader('Content-type', register.contentType);
    res.send(await register.metrics());
    next();
});

expressApp.use((req, res, next) => {
    if (req.url !== '/metrics') {
        if (config.api_key) {
            if (req.headers['authorization'] !== config.api_key) {
                res.status(401).send('Unauthorized');
            }
        } else if (req.headers['authorization']) {
            logger.info(
                'Authorization header is not configured but set: %s',
                req.headers['authorization'],
            );
        }
        next();
    }
});

expressApp.use(
    cors({
        origin: getAllowedOrigins(),
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true,
    }),
);

expressApp.use(
    '/',
    trpcExpress.createExpressMiddleware({
        router: appRouter,
    }),
);

expressApp.listen(port, '0.0.0.0', () => {
    logger.debug(`Server is running on http://0.0.0.0:${port}`);
});
