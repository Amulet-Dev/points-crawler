import { SourceInterface } from '../../../types/sources/source';
import { Tendermint34Client } from '@cosmjs/tendermint-rpc';
import { Logger } from 'pino';
import { CbOnUserBalances } from '../../../types/sources/cbOnUserBalances';
import { getContractStateKeys } from '../../query';

interface UserInfoData {
    locked: string;
    boosted_amount: string;
    pending_lockup_withdrawals: any[];
}

export default class AstrovaultSource implements SourceInterface {
    rpc: string;
    concurrencyLimit: number;
    paginationLimit: number;
    logger: Logger<never>;
    assets: Record<string, { denom: string; staking_contract: string }> = {};
    sourceName: string;
    client: Tendermint34Client | undefined;

    constructor(rpc: string, logger: Logger<never>, params: any) {
        this.logger = logger;

        if (!params.source) {
            throw new Error('No source name configured in params');
        }
        this.sourceName = params.source;

        if (!params.assets) {
            throw new Error('No assets configured in params');
        }
        this.assets = params.assets;

        this.rpc = rpc;
        this.concurrencyLimit = parseInt(params.concurrency_limit || '3', 10);
        this.paginationLimit = parseInt(params.paginationLimit || '30', 10);
    }

    async getLastBlockHeight(): Promise<number> {
        try {
            const client = await this.getClient();
            const status = await client.status();
            return status.syncInfo.latestBlockHeight;
        } catch (err) {
            return Promise.reject(err);
        }
    }

    async getUsersBalances(
        height: number,
        multipliers: Record<string, number>,
        cb: CbOnUserBalances,
    ): Promise<void> {
        try {
            for (const [
                assetId,
                { staking_contract: stakingContract },
            ] of Object.entries(this.assets)) {
                const balances = await this.getLockedBalances(height, stakingContract);
                const mult = multipliers[assetId];
                const returnableBalances = balances.map((b) => {
                    return {
                        address: b.address,
                        balance: String(Math.floor(Number(b.balance) * mult)),
                        asset: assetId,
                    };
                });

                cb(returnableBalances);
            }
        } catch (err) {
            return Promise.reject(err);
        }
    }

    private async getLockedBalances(
        height: number,
        contract: string,
    ): Promise<{ address: string; balance: string }[]> {
        try {
            const client = await this.getClient();
            const balances: { address: string; balance: string }[] = [];

            let nextKey: Uint8Array | undefined = undefined;
            do {
                const response = await getContractStateKeys(
                    client,
                    height,
                    contract,
                    nextKey,
                );

                for (const model of response.models) {
                    const rawKey = model.key; // raw bytes
                    const rawValue = model.value; // raw bytes

                    const keyAscii = Buffer.from(rawKey).toString('utf8');

                    const jsonValue = new TextDecoder().decode(rawValue);
                    let parsed;
                    try {
                        parsed = JSON.parse(jsonValue);
                    } catch (e) {
                        parsed = jsonValue;
                    }

                    const address = this.extractAddressFromUserInfoKey(keyAscii);
                    const balance = this.getLockedAmount(parsed);

                    if (address) {
                        balances.push({
                            address,
                            balance,
                        });
                    }
                }

                nextKey = response.pagination?.nextKey;
            } while (nextKey && nextKey.length > 0);

            return balances;
        } catch (err) {
            return Promise.reject(err);
        }
    }

    private extractAddressFromUserInfoKey(keyAscii: string): string | null {
        // Remove leading non-printable characters using a regex:
        // This drops all control chars (ASCII < 32), for instance.
        const cleaned = keyAscii.replace(/[^\x20-\x7E]+/g, '');

        const marker = 'userinfo';
        const idx = cleaned.indexOf(marker);
        if (idx === -1) {
            return null; // Not found
        }

        const addressPart = cleaned.substring(idx + marker.length);

        if (!addressPart.startsWith('neutron')) {
            return null;
        }

        return addressPart.trim();
    }

    private getLockedAmount(some: unknown): string {
        if (!some || typeof some !== 'object') {
            return '0';
        }

        const obj = some as Partial<UserInfoData>;
        if (obj.locked) {
            return obj.locked;
        }

        return '0';
    }

    private async getClient(): Promise<Tendermint34Client> {
        try {
            if (!this.client) {
                this.client = await Tendermint34Client.connect(this.rpc);
            }

            return this.client;
        } catch (err) {
            return Promise.reject(err);
        }
    }
}
