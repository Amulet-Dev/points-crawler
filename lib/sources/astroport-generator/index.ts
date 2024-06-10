import { Logger } from 'pino';
import { Tendermint34Client } from '@cosmjs/tendermint-rpc';
import { CbOnUserBalances } from '../../../types/cbOnUserBalances';
import AstroportSource from '../astroport';
import { queryContractOnHeight } from '../../query';

export default class AstroportGeneratorSource extends AstroportSource {
  rpc: string;
  paginationLimit: number;
  logger: Logger<never>;
  generatorContract: string;
  assets: Record<string, { denom: string; pair_contract: string }> = {};
  sourceName: string;
  client: Tendermint34Client | undefined;

  getClient = async () => {
    if (!this.client) {
      this.client = await Tendermint34Client.connect(this.rpc);
    }
    return this.client;
  };

  constructor(rpc: string, logger: Logger<never>, params: any) {
    super(rpc, logger, params);
    this.logger = logger;

    if (!params.source) {
      throw new Error('No source name configured in params');
    }
    this.sourceName = params.source;

    if (!params.assets) {
      throw new Error('No assets configured in params');
    }
    this.assets = params.assets;

    if (!params.generator_contract) {
      throw new Error('No generator contract configured in params');
    }
    this.generatorContract = params.generator_contract;

    this.rpc = rpc;
    this.paginationLimit = parseInt(params.paginationLimit || '50', 10);
  }

  getUsersBalances = async (
    height: number,
    multipliers: Record<string, number>,
    cb: CbOnUserBalances,
  ): Promise<void> => {
    for (const [assetId, asset] of Object.entries(this.assets)) {
      const lpContract = await this.getLpContract(height, asset.pair_contract);
      const exchangeRate = await this.getLpExchangeRate(
        height,
        asset.denom,
        lpContract,
      );
      const multiplier = multipliers[assetId] * exchangeRate;

      const client = await this.getClient();
      let startAfter = undefined;
      while (true) {
        this.logger.debug(`Fetching accounts starting after ${startAfter}`);
        const balances: string[][] = await queryContractOnHeight(
          client,
          this.generatorContract,
          height,
          {
            pool_stakers: {
              lp_token: lpContract,
              start_after: startAfter,
              limit: this.paginationLimit,
            },
          },
        );
        if (balances.length == 0) {
          break;
        }
        startAfter = balances[balances.length - 1][0];

        cb(
          balances.map((balance) => ({
            address: balance[0],
            balance: String(Math.floor(Number(balance[1]) * multiplier)),
            asset: assetId,
          })),
        );
      }
    }
  };

  getLastBlockHeight = async (): Promise<number> => {
    const client = await this.getClient();
    const status = await client.status();
    return status.syncInfo.latestBlockHeight;
  };
}
