# points-crawler

## Table of Contents

- [Overview](#overview)
  - [Key differences between ingots and droplets](#key-differences-between-ingots-and-droplets)
  - [Core components](#core-components)
  - [Available data source](#available-data-sources)
  - [Available server routes](#available-server-routes)
  - [How to run](#how-to-run)
- [Configuration](#configuration)
  - [Adding more assets](#adding-more-assets)
  - [Adding new sources](#adding-new-sources)
  - [Adding a protocol](#adding-a-protocol)
  - [Adding protocol assets](#adding-protocol-assets)
  - [Adding asset prices](#adding-asset-prices)
- [Production](#production)
  - [Debugging](#debugging)
- [Common Workflows](#common-workflows)
  - [Adding a new source](#adding-a-new-source-protocol)
  - [Handling Hydro allocations](#handling-hydro-allocations)
  - [Recovering from backups](#recovering-from-backups)
- [Data Layer](#data-layer)

## Overview

`points-crawler` is the engine behind Amulet Finance’s [Ingot Program](https://ingots.amulet.finance), adapted from Drop Protocol’s [drop-points-crawler](https://github.com/hadronlabs-org/drop-points-crawler).

It awards users **ingots** (points) for participation in the Cosmos ecosystem, based on usage of Amulet-issued assets like `amATOM`. It tracks activity across multiple protocols and chains and calculates rewards from on-chain data such as:

- Holding amAssets in wallets
- Staking assets in liquidity pools (Astroport, Osmosis)
- Providing collateral or participating in lending/derivatives platforms (Levana, Mars)

By finding the answers to these questions we can assign point values based on the _dollar value_ of their positions across many blockchains and protocols.

### Key differences between ingots and droplets

Amulet's Ingot program differs in several ways from Drop's Droplet program:

- Ingots are points that exist only in a `SQLite` database. Ingots do not have a smart contract associated with them.
- Ingots do not make use of the `kyc` or `referral` modules.
- Ingot issuance is scaled down in comparison to Droplets.

> Droplets are generated essentially like this `udenom_amount * asset_price * source_multiplier * time_factor`. As a preference, Amulet uses a `human_readable_amount` rather than the `udenom_amount` to generate fewer points. You can see where points are generated on line `491` of [crawler/index.ts](crawler/index.ts).

### Core components

| Path                   | Description                                                                                                                            |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/crawler/index.ts` | **Critical File**: Defines a commander CLI tool for all `bun crawl` commands                                                           |
| `config.toml`          | **Critical File**: Defines the configuration for every available source for the crawler to search. See [configuration](#configuration) |
| `lib/source`           | Contains `SourceInterfaces` which define what protocols and blockchains we can source data from                                        |
| `lib/static`           | Contains static files for handling hydro manual point allocations. See [common workflows](#common-workflows)                           |
| `lib/server/index.ts`  | Entrypoint to start and configure a tRPC backend                                                                                       |

### Available data sources

All available sources can be found in [lib/sources/index.ts](lib/sources/index.ts)

| Source Name  | Source                     |
| :----------- | :------------------------- |
| `neutron`    | `BankModuleSource`         |
| `kujira`     | `BankModuleSource`         |
| `mars`       | `MarsSource`               |
| `levana`     | `LevanaSource`             |
| `osmosis`    | `BankModuleSource`         |
| `astroport`  | `AstroportSource`          |
| `generator`  | `AstroportGeneratorSource` |
| `apollo`     | `ApolloSource`             |
| `nolus`      | `NolusSource`              |
| `demex`      | `DemexSource`              |
| `osmosis-lp` | `OsmosisLPSource`          |
| `astrovault` | `AstrovaultSource`         |

> Note: Sometimes a protocol will use a shared `BankModuleSource` rather than a custom source. Sources that use the `BankModuleSource` are expected to only be tracking assets held in a user's wallet rather than through some protocol specific investment vehicle. Take for instance the difference between `osmosis` and `osmosis-lp`. `osmosis` uses the `BankModuleSource` because we are only concerned with tracking the amAssets in a user's osmosis wallet. `osmosis-lp` uses the `OsmosisLPSource` because we need a custom way to track amAssets invested in Osmosis liquidity pools.

> Note: Sources are often build using CosmJS and sending queries directly to a protocol's smart contracts. However, in some instances like `osmosis-lp` our source is built using a [SubQuery Indexer](https://subquery.network/). For more information on the subquery indexer view the [subquery-indexer](https://github.com/Amulet-Dev/subquery-indexer) repository.

### Available server routes

tRCP routes can be found at `lib/server/index.ts`. For additional documentation on how these routes are used see the [ingots.amulet.finance](https://github.com/Amulet-Dev/ingots.amulet.finance) repository for more documentation.

| Route              | Type | Notes    |
| :----------------- | :--- | :------- |
| `/getDroplets`     | GET  |          |
| `/getRules`        | GET  |          |
| `/getLeaderboard`  | GET  |          |
| `/getSupply`       | GET  |          |
| `/postKyc`         | POST | Not used |
| `/postKVData`      | POST | Not used |
| `/getKVData`       | GET  | Not used |
| `/getReferralCode` | GET  | Not used |
| `/getReferrer`     | GET  | Not used |
| `/getReferrals`    | GET  | Not used |
| `/getStakerStatus` | GET  | Not used |

### How to run

- install [bun](https://bun.sh/)
- run `bun install`
- run `bun run crawl --help` to get the list of available commands
- run `bun run crawl <command> --help` to get the list of available options for the command
- to browse the database you can use any SQLite3 client and connect to the `./data.db` file. `sqlite3` and `sqlitebrowser` are available on [production](#production).

> Note: `bun serve` is used to start the tRPC backend on `0.0.0.0:3000`

## Configuration

[config.toml](/config.toml) is home to the production configuration of the `points-crawler` for the Amulet Ingot Program. At bottom, you should know how to extend the configuration in the following ways.

### Adding more assets

```toml
assets = ["amATOM"] # add additional asset symbols here
```

### Adding new sources

```toml
# add additional source names here
sources = ["neutron", "astroport", "generator", "levana", "osmosis", "osmosis-lp", "astrovault"]
```

### Adding a protocol

Protocols are defined by crawler specific metadata and metadata discoverable by a frontend client through the `points-crawler`'s tRPC backend. Both should be configured when adding a new protocol.

```toml
[protocols.protocol_name]
rpc = "rpc.link"
source = "my_protocol_source_name"
jitter = 10000 # used to randomize block heights when indexing data
concurrency_limit = 5
pagination_limit = 30 # pagination offset

[protocols.protocol_name.frontend_data]
chain_name = "some_chain"
link = "chain.url"
link_text = "Go check out this chain"
```

### Adding protocol assets

Any number of assets can be assigned to a protocol.

```toml
[protocols.protocol_name.myAsset]
multiplier = 5 # Earn 5x more ingots when investing in this source
denom = "myAsset.denom"
# Optional: used when myAsset represents an investment vehicle rather than a single asset held in a wallet.
pair_contract = "some bech32 address"

[protocols.protocol_name.myAsset.frontend_data]
multiplier = 5 # should be same as protocols.protocol_name.myAsset.multiplier
visible = true # Should the frontend see this data entry?
strategy = "myAsset Staking" # label for the investment strategy
description = "Earn ingots by holding amATOM in your wallet on Neutron"
type = "single-sided" # another kind of descriptor. Not used by ingots.amulet.finance
featured = false # Not used by ingots.amulet.finance
status = true # should be true if active
```

In this example we use `myAsset` to represent an investment vehicle on `protocol_name`. However it may be the case that we want to track `myAsset` across multiple investment vehicles such as liquidity pools. In that instance `myAsset` should always prefix our label and we use and underscore to create a unique asset label. For example:

```sh
# We track three liquidity pools on Astroport for amATOM like this:
[protocols.neutron-astroport.assets.amATOM_USDC]
[protocols.neutron-astroport.assets.amATOM_dATOM]
[protocols.neutron-astroport.assets.amATOM_stATOM]
```

> Note: Whatever the prefixed symbol is before the "\_" is the asset that will be used to find the amount calculated in awarding user points. The crawler will only ever track the value of the prefixed asset and will **not** track any asset symbols after the underscore, even if they are listed as trackable assets. If you wanted to track both, I would assume you could have two entries for the same pool like amATOM_USDC and USDC_amATOM, but you would need to experiment on your own.

> **Important Note:** Configuration changes for frontend data made in config.toml are not updated retroactively once your `SQLite` database is created. That means any frontend metadata changes made must be manually changed in the proper `SQLite` table. Additionally adding new protocols requires the additional step of running the `bun crawl schedule` command. However, in order for that command to succeed, you still must add new `protocols` to this config first. See [common workflows](#common-workflows) to understand adding a new protocol with `bun crawl schedule`

### Adding asset prices.

The crawler use Pyth Network to discover pricing data through Pyth oracles. You must assign an asset a Pyth Oracle near the bottom of the `config,toml` file.

```toml
[pricefeed]
jitter = 10000 # must equal to the jitter of neutron
rpc = "https://rpc-solara.neutron-1.neutron.org"
contract = "neutron1m2emc93m9gpwgsrsf2vylv9xvgqh654630v7dfrhrkmr5slly53spg85wv" #mainnet

[pricefeed.assets.amATOM]
pyth_id = "b00b60f88b03a6a625a8d1c048c3f66653edf217439983d037e7222c4e612819"
core_contract = "neutron1r8t7mc62gtlqqe9zfur0g73ppfgulqqhlzh82r9uggca5hq2336qmv2xj0"

[pricefeed.assets.myAsset]
pyth_id = "some_pyth_id with 0x removed"
core_contract = "" # core_contract has been deprecated and is no longer used
```

## Production

`points-crawler` is running in production on the `amulet-v1` GCP project. It is running in it's own VM instance called `ingots-crawler`. The code itself runs in two ways.

1. The tRPC backend is running over NGINX and is managed by [pm2](https://pm2.keymetrics.io/). You can see the running server by running `pm2 ls` after ssh'ing into the VM. You will see something like:

```sh
┌────┬────────────────────┬──────────┬──────┬───────────┬──────────┬──────────┐
│ id │ name               │ mode     │ ↺    │ status    │ cpu      │ memory   │
├────┼────────────────────┼──────────┼──────┼───────────┼──────────┼──────────┤
│ 0  │ crawler            │ fork     │ 332  │ online    │ 0%       │ 151.9mb  │
└────┴────────────────────┴──────────┴──────┴───────────┴──────────┴──────────┘
```

You can target the publicly available production crawler at [crawler.amulet.finance](https://crawler.amulet.finance)

```sh
# Example request
points-crawler(main) ✗: curl https://crawler.amulet.finance/getLeaderboard | jq .
{
  "result": {
    "data": {
      "data": [
        {
          "redactedAddress": "neutro...a44f",
          "points": 7727722,
          "change": 21986,
          "rank": 1
        },
        {
          "redactedAddress": "neutro...wp0n",
          "points": 3594433,
          "change": 16086,
          "rank": 2
        },
        # ...
      ]
}
```

> Note: You should not need to mess with the NGINX configuration, but it can be found on `ingots-crawler` at `/etc/nginx/nginx.conf`.

Additionally, the `points-crawler` crawls the sources defined in `config.toml` once a day via a CRON job configured by `crontab`. You can view the script on the VM that is ran daily at `~/run_crawler.sh`.

The full file:

1. Ensures `nvm` is installed
2. Ensures the proper `nodejs` version is installed.
3. Ensures `pm2` is installed
4. Ensures `bun` is installed
5. Creates a backup of the `SQLite` database
6. Runs the crawler

You can see what commands are run to perform the crawling operation and generate user ingots below:

```sh
# run_crawler.sh as of 5/15/2025
# ...
bun crawl prepare # Get blockheights, asset prices, setup tasks for each protocol asset
bun crawl crawl neutron # Find all user_data for neutron tasks
bun crawl crawl neutron-astroport # Find all user_data for neutron-astroport
bun crawl crawl neutron-astroport-generator # ...
bun crawl crawl neutron-levana # ...
bun crawl finish -p # Aggregate all user_data for each address and derive point totals in user_points_public
```

### Debugging

In production there are several log files produced by the crawler. They can be found on the `ingots-crawler` VM at the following locations

- `~/crawler.log`
- `~/purge-pool-positions.log`
- `~/relcaim_docker_space.log`

`crawler.log` contains all the logging information related to the `run_crawler.sh` script that runs daily. To verify the crawler has run smoothly, you can run

`tail -f crawler.log`

You should something like:

```sh
[PM2] [crawler](0) ✓
┌────┬────────────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┬──────────┬──────────┬──────────┬──────────┐
│ id │ name       │ namespace   │ version │ mode    │ pid      │ uptime │ ↺    │ status    │ cpu      │ mem      │ user     │ watching │
├────┼────────────┼─────────────┼─────────┼─────────┼──────────┼────────┼──────┼───────────┼──────────┼──────────┼──────────┼──────────┤
│ 0  │ crawler    │ default     │ N/A     │ fork    │ 936659   │ 0s     │ 332  │ online    │ 0%       │ 26.6mb   │ alex     │ disabled │
└────┴────────────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┴──────────┴──────────┴──────────┴──────────┘
Script completed successfully at Wed May 14 23:50:30 UTC 2025
```

`purge-pool_positions.log` and `reclaim_docker_space.log` are ancillary log files concerned with disk management related to a sister repository of `points-crawler` called [subquery-indexer](https://github.com/Amulet-Dev/subquery-indexer). More information can on those scripts can found in the subquery-indexer repository.

## Common Workflows

### Adding a new source (protocol)

The `points-crawler` is modular by design when it comes to adding additional sources. The real complexity of adding an additional source is understanding the implementation details required by your new source. If you know how to communicate with your new source the process to add it to the crawler is fairly straight forward.

#### 1. Create a new source in `lib/sources`

Create a new directory like `MySource` and an index.ts file. Your new source must adhere to the `SourceInterface`

```ts
export interface SourceInterface {
  logger: Logger<never>;
  getLastBlockHeight(): Promise<number>;
  getUsersBalances(
    height: number,
    multipliers: Record<string, number>,
    cb: CbOnUserBalances,
  ): Promise<void>;
}
```

Once complete, add your source to `lib/sources/index.ts` and it will be available to the crawler during `crawl` commands.

```ts
// sources/index.ts

// ...
import MySource from './mySource';

const out = {
  neutron: BankModuleSource,
  // ...
  mySourceName: MySource,
};
```

#### 2. Add your source to `config.toml`

See [configuration](#configuration) for details on adding new protocol metadata and assigning a protocol to your new source.

#### 3. Schedule your source

When you add a new protocol after the crawler has already run the first time and produced a `data.db` file, you will have to use the `bun crawl schedule` command to have the crawler recognize the metadata you've put in `config.toml`. Here's an example of using the schedule command:

```sh
bun crawl schedule add osmosis amOSMO 2025-05-19T00:00:00.000Z 2026-12-30T00:00:00.000Z 2 true

# bun crawl schedule add protocol_name asset_name start_date end_date multiplier isVisible
```

> Note: If you would like your new source to have no end date. You can enter `data.db` via `sqlite3` or `sqlitebrowser` (both are available on the `ingots-crawler` VM) and change the end_date timestamp to `0`. Your protocol will then be crawled indefinitely.

#### 4. Update run_crawler.sh

The last thing you need to do to fully implement your new source is make sure that your source will be processed daily with the rest of the protocols tracked by the crawler. Open `~/run_crawler.sh` on the `ingots-crawler` VM and add the crawl command like so:

```sh
# run_crawler.sh

# ...

bun crawl prepare
bun crawl crawl neutron
bun crawl crawl neutron-astroport
bun crawl crawl neutron-astroport-generator
bun crawl crawl neutron-levana
# bun crawl crawl mySource
bun crawl finish -p

# ...
```

### Handling Hydro allocations

A unique source of ingots is through [Hydro](https://hydro.cosmos.network/). Hydro allocates liquidity to participating protocols which sometimes includes Amulet Finance. Amulet has offered ingots as rewards for user votes in order to secure liquidity on Astroport for example. After the voting is done, Hydro can provide a CSV that represents the voting breakdown.

To award users their ingots for voting on Amulet's bid, the process is simple.

1. Process the CSV file to ensure it matches the format found in [hydro_round_3.csv](/static/hydro_round_3.csv)
2. Run `bun crawl hydro prepare "./static/new_round.csv" <BID_ID> -p <POT_SIZE>`

`BID_ID` represents the Amulet Finance bid for liquidity. You can go to the hydro website and view the active bids to find the proper `BID_ID` or ask the Hydro team when they handoff the CSV. `POT_SIZE` represents how many ingots are going to be proportionally distributed to voters and should be agreed upon by the Amulet Team.

> Note: There is a default `POT_SIZE` of 250,000, but `POT_SIZE` will more than likely be unique in the future and should be supplied to the above command.

`bun crawl hydro prepare` will create a new `hydro_allocations.json` file in the `static` directory that proportionally distributes points to users based on their voting power.

3. Run `bun crawl hydro allocate './static/hydro_allocation.json' <BACKUP_DIRECTORY>`

`bun crawl hydro allocate` will create a backup of `data.db` in case anything fails and proceed to process `hydro_allocation.json`. New points for users are saved to the table `hydro_allocations` with a `group_id`. Then `hydro_allocations` entries are merged based on the current `group_id` into `user_points_public`.

4 Run `pm2 restart crawler`

Assuming all has gone well, simply restart the crawler's tRPC backend and the changes will be live for users to see on [ingots.amulet.finance](https://ingots.amulet.finance)

> Note: All of these kinds of database altering activities should be done first on a development machine to ensure safety. Backups of the `SQLite` database are taken frequently enough that there's always a way to rollback, but it's still good practice to avoid jumping immediately to production to run commands.

### Recovering from backups

Sometimes the crawler can break. It hasn't happened in weeks, but it can happen. Most often a break occurs because a node provider for one or more sources is broken. For example, we've defined for our neutron source to use the following node via RPC:

```sh
rpc = "https://rpc-solara.neutron-1.neutron.org"
```

One day the Solara node might limit our requests too much and return 429 errors. Receiving these kinds of errors would leave our database in a corrupted state. Additional `bun crawl` commands have been added to try to correct for corrupted state issues such as `bun crawl manual-task` and `bun crawl recalculate` and I encourage any maintainer to look into those functions, but the easiest, most reliable way to solve the issue is going to be to:

1. Verify from `crawler.log` that a backup was created and find the back from the last successful crawl.
2. Find the backup in production at `~/points-crawler/backup/your_sqlite_backup.db`
3. Verify the integrity of your backup using a sqlite3 [pragma integrity check](https://www.sqlite.org/pragma.html#pragma_integrity_check)
4. Remove the corrupted data.db files from `~/points-crawler`
5. Copy the backup into `~/points-crawler`
6. Run `bun crawl prepare -t NUMERIC_TIMESTAMP` for all days where the crawler failed to run.

> Note: an improvement to make for the `ingots-crawler` VM would be to set up a GCP alert to detect when a new error has occurred in `crawler.log` so that you know right away when a problem has occurred. In some instances we cannot reasonably expect to go back too far in time and still receive data from our nodes as blockchain data can be pruned or is short lived on public nodes.

## Data Layer

Our database used to manage the crawler and store user points is `SQLite3`. It contains the following schemas:

### `batches`

| Column   | Type    | Constraints               |
| -------- | ------- | ------------------------- |
| batch_id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| ts       | INTEGER |                           |

### `prices`

| Column   | Type    | Constraints                           |
| -------- | ------- | ------------------------------------- |
| asset_id | TEXT    |                                       |
| batch_id | INTEGER | PRIMARY KEY (batch_id DESC, asset_id) |
| price    | NUMERIC |                                       |
| ts       | INTEGER |                                       |

### `hydro_allocations`

| Column     | Type    | Constraints        |
| ---------- | ------- | ------------------ |
| id         | INTEGER | PRIMARY KEY        |
| address    | TEXT    | NOT NULL           |
| reward     | INTEGER | NOT NULL           |
| group_id   | INTEGER | NOT NULL           |
| processed  | INTEGER | NOT NULL DEFAULT 0 |
| created_at | INTEGER | CURRENT_TIMESTAMP  |

### `tasks`

| Column      | Type    | Constraints                              |
| ----------- | ------- | ---------------------------------------- |
| protocol_id | TEXT    |                                          |
| batch_id    | INTEGER | PRIMARY KEY (batch_id DESC, protocol_id) |
| height      | INTEGER |                                          |
| status      | TEXT    |                                          |
| jitter      | NUMERIC |                                          |
| ts          | INTEGER |                                          |

### `user_data`

| Column      | Type    | Constraints                                       |
| ----------- | ------- | ------------------------------------------------- |
| batch_id    | INTEGER | PRIMARY KEY (batch_id DESC, address, protocol_id) |
| address     | TEXT    |                                                   |
| protocol_id | TEXT    |                                                   |
| height      | INTEGER |                                                   |
| asset       | TEXT    |                                                   |
| balance     | NUMERIC |                                                   |

### `user_points`

| Column            | Type    | Constraints                                    |
| ----------------- | ------- | ---------------------------------------------- |
| batch_id          | INTEGER | PRIMARY KEY (batch_id DESC, address, asset_id) |
| address           | TEXT    |                                                |
| asset_id          | TEXT    |                                                |
| points            | NUMERIC |                                                |
| referal_points_l1 | NUMERIC |                                                |
| referal_points_l2 | NUMERIC |                                                |

### `user_points_public`

| Column         | Type    | Constraints |
| -------------- | ------- | ----------- |
| address        | TEXT    | PRIMARY KEY |
| asset_id       | TEXT    | FOREIGN KEY |
| points         | NUMERIC |             |
| change         | NUMERIC |             |
| prev_points_l1 | NUMERIC |             |
| prev_points_l2 | NUMERIC |             |
| points_l1      | NUMERIC |             |
| points_l2      | NUMERIC |             |
| place          | INTEGER |             |
| prev_place     | INTEGER |             |

### `user_points_rules`

| Column      | Type    | Constraints |
| ----------- | ------- | ----------- |
| strategy    | TEXT    |             |
| description | TEXT    |             |
| multiplier  | REAL    |             |
| chain       | TEXT    |             |
| status      | BOOLEAN |             |
| link        | TEXT    |             |
| link_text   | TEXT    |             |
| type        | TEXT    |             |
| featured    | BOOLEAN |             |
| visible     | BOOLEAN |             |

### `schedule`

| Column      | Type    | Constraints               |
| ----------- | ------- | ------------------------- |
| schedule_id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| protocol_id | INTEGER |                           |
| asset_id    | TEXT    |                           |
| multiplier  | REAL    |                           |
| start       | INTEGER |                           |
| end         | INTEGER |                           |
| enabled     | BOOLEAN |                           |

## ✅ You're Ready

With this README, you now understand the architecture, configuration, and deployment of `points-crawler`. If you're onboarding new sources, debugging production, or simply tuning the Ingot Program, this document should serve as your primary guide.

For issues outside the scope of this repo—such as SubQuery setup or frontend integration—refer to the [`subquery-indexer`](https://github.com/Amulet-Dev/subquery-indexer) or [`ingots.amulet.finance`](https://github.com/Amulet-Dev/ingots.amulet.finance) repositories.
