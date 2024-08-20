import { Tendermint34Client } from '@cosmjs/tendermint-rpc';
import { queryContractOnHeight } from '../../query';
import { CbOnUserBalances } from '../../../types/sources/cbOnUserBalances';
import pLimit from 'p-limit';
import { SourceInterface } from '../../../types/sources/source';
import { MarsPositionResponse } from '../../../types/sources/marsPositionResponse';
import { Logger } from 'pino';

export default class MarsSource implements SourceInterface {
  rpc: string;
  concurrencyLimit: number;
  paginationLimit: number;
  logger: Logger<never>;
  assets: Record<string, { denom: string }> = {};
  sourceName: string;
  client: Tendermint34Client | undefined;
  nftContract: string;
  creditContract: string;

  getClient = async () => {
    if (!this.client) {
      this.client = await Tendermint34Client.connect(this.rpc);
    }
    return this.client;
  };

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

    if (!params.nft_contract) {
      throw new Error('No mars nft contract configured in params');
    }
    this.nftContract = params.nft_contract;

    if (!params.credit_contract) {
      throw new Error('No mars credit contract configured in params');
    }
    this.creditContract = params.credit_contract;

    this.rpc = rpc;
    this.concurrencyLimit = parseInt(params.concurrency_limit || '3', 10);
    this.paginationLimit = parseInt(params.pagination_limit || '100', 10);
  }

  getAccountTokens = async (
    nftContract: string,
    height: number,
    limit: number,
    startAfter?: string,
  ): Promise<string[]> => {
    const client = await this.getClient();

    this.logger.debug(
      'Fetching %d account tokens starting after %s',
      limit,
      startAfter,
    );

    const data = await queryContractOnHeight<{ tokens: string[] }>(
      client,
      nftContract,
      height,
      {
        all_tokens: { limit, start_after: startAfter },
      },
    );

    this.logger.debug(
      'Finished fetching %d account tokens starting after %s',
      limit,
      startAfter,
    );

    return data.tokens;
  };

  getAccountTokensOwned = async (
    nftContract: string,
    height: number,
    owner: string,
  ): Promise<string[]> => {
    const client = await this.getClient();

    const data = await queryContractOnHeight<{ tokens: string[] }>(
      client,
      nftContract,
      height,
      {
        tokens: { owner },
      },
    );

    return data.tokens;
  };

  getAccountPosition = async (
    creditContract: string,
    height: number,
    account: string,
  ): Promise<MarsPositionResponse> => {
    const client = await this.getClient();

    const data = await queryContractOnHeight<MarsPositionResponse>(
      client,
      creditContract,
      height,
      {
        positions: { account_id: account },
      },
    );

    return data;
  };

  getAccountOwner = async (
    nftContract: string,
    height: number,
    account: string,
  ): Promise<string> => {
    const client = await this.getClient();

    const data = await queryContractOnHeight<{ owner: string }>(
      client,
      nftContract,
      height,
      {
        owner_of: { token_id: account },
      },
    );

    return data.owner;
  };

  getBalanceAndDebt = (
    positions: MarsPositionResponse,
    denom: string,
  ): { balance: bigint; debted: boolean } => {
    if (positions.deposits.length > 0) {
      const foundAsset = positions.deposits.find(
        (deposit) => deposit.denom === denom,
      );
      if (foundAsset)
        return {
          balance: BigInt(foundAsset.amount),
          debted: positions.debts.length > 0,
        };
    }

    return { balance: BigInt(0), debted: positions.debts.length > 0 };
  };

  getAddressAndBalances = async (
    height: number,
    multipliers: Record<string, number>,
    accountToken: string,
  ): Promise<{ address: string; balance: string; asset: string }[]> => {
    const owner = await this.getAccountOwner(
      this.nftContract,
      height,
      accountToken,
    );

    this.logger.debug('Fetching address and balances for %s', owner);

    const accountTokensOwned = await this.getAccountTokensOwned(
      this.nftContract,
      height,
      owner,
    );

    this.logger.debug('accountTokensOwned: %o', accountTokensOwned);

    const result: { address: string; balance: string; asset: string }[] = [];

    if (accountTokensOwned.length === 1) {
      const positions = await this.getAccountPosition(
        this.creditContract,
        height,
        accountToken,
      );
      this.logger.debug('positions: %o', positions);

      for (const [assetId, asset] of Object.entries(this.assets)) {
        const { denom } = asset;
        if (!denom) {
          this.logger.warn('Denom %s is invalid, skipping', assetId);
          break;
        }

        const { balance, debted } = this.getBalanceAndDebt(positions, denom);
        if (balance) {
          result.push({
            address: owner,
            balance: (
              (balance *
                BigInt(
                  Math.round((debted ? multipliers[assetId] : 1) * 10000),
                )) /
              BigInt(10000)
            ).toString(),
            asset: assetId,
          });
        }
      }

      return result;
    }

    if (accountToken !== accountTokensOwned[0]) return [];

    const ownerPositions: Record<string, MarsPositionResponse> = {};
    for (const accountToken of accountTokensOwned) {
      const tokenPosition = await this.getAccountPosition(
        this.creditContract,
        height,
        accountToken,
      );
      ownerPositions[accountToken] = tokenPosition;
    }

    for (const [assetId, asset] of Object.entries(this.assets)) {
      const { denom } = asset;
      if (!denom) {
        this.logger.warn('Denom %s is invalid, skipping', assetId);
      }

      let aggregatedBalance = BigInt(0);
      let hasFittingPosition = false;

      for (const accountToken of accountTokensOwned) {
        const tokenPosition = ownerPositions[accountToken];
        const { balance, debted } = this.getBalanceAndDebt(
          tokenPosition,
          denom,
        );
        if (balance && !hasFittingPosition) hasFittingPosition = true;
        aggregatedBalance +=
          (balance *
            BigInt(Math.round((debted ? multipliers[assetId] : 1) * 10000))) /
          BigInt(10000);
      }

      if (hasFittingPosition) {
        result.push({
          address: owner,
          balance: aggregatedBalance.toString(),
          asset: assetId,
        });
      }
    }

    return result;
  };

  getUsersBalances = async (
    height: number,
    multipliers: Record<string, number>,
    cb: CbOnUserBalances,
  ): Promise<void> => {
    let startAfter = undefined;
    let accountTokens: string[] = [];

    while (true) {
      startAfter =
        accountTokens.length > 0
          ? accountTokens[accountTokens.length - 1]
          : undefined;
      accountTokens = await this.getAccountTokens(
        this.nftContract,
        height,
        this.paginationLimit,
        startAfter,
      );
      if (accountTokens.length === 0) break;
      this.logger.debug(
        'Fetching assets info from current batch of %d balances',
        this.paginationLimit,
      );

      const withConcurrencyLimit = pLimit(this.concurrencyLimit);
      const settledResults = await Promise.allSettled(
        accountTokens.map((accountToken) =>
          withConcurrencyLimit(
            async () =>
              await this.getAddressAndBalances(
                height,
                multipliers,
                accountToken,
              ),
          ),
        ),
      );

      this.logger.debug(
        'Finished fetching assets info from current batch of %d balances',
        settledResults.length,
      );
      cb(
        settledResults.reduce(
          (
            filteredResult: {
              address: string;
              balance: string;
              asset: string;
            }[],
            settledResult,
          ) => {
            if (settledResult.status === 'fulfilled' && settledResult.value) {
              filteredResult.push(...settledResult.value);
            }
            return filteredResult;
          },
          [],
        ),
      );
    }

    this.logger.debug(
      'Finished fetching all balances for %s source',
      this.sourceName,
    );
  };

  getLastBlockHeight = async (): Promise<number> => {
    const client = await this.getClient();
    const status = await client.status();
    return status.syncInfo.latestBlockHeight;
  };
}
