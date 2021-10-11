import assert from "assert";
import { ethers } from "ethers";
import moment from "moment";
import Events from "events";
import { tables, Coingecko, utils, Multicall2 } from "@uma/sdk";
import { Datastore } from "@google-cloud/datastore";

import * as Services from "../../services";
import Express from "../../services/express-channels";
import * as Actions from "../../services/actions";
import { appStats, empStats, empStatsHistory, lsps, StoresFactory } from "../../tables";
import Zrx from "../../libs/zrx";
import { Profile, parseEnvArray, getWeb3, BlockInterval, expirePromise } from "../../libs/utils";

import type { ProcessEnv, Channels, DatastoreAppState } from "../../types";

export default async (env: ProcessEnv) => {
  assert(env.CUSTOM_NODE_URL, "requires CUSTOM_NODE_URL");
  assert(env.EXPRESS_PORT, "requires EXPRESS_PORT");
  assert(env.zrxBaseUrl, "requires zrxBaseUrl");
  assert(env.MULTI_CALL_2_ADDRESS, "requires MULTI_CALL_2_ADDRESS");
  assert(env.GOOGLE_APPLICATION_CREDENTIALS, "requires GOOGLE_APPLICATION_CREDENTIALS");
  const lspCreatorAddresses = parseEnvArray(env.lspCreatorAddresses || "");

  // debug flag for more verbose logs
  const debug = Boolean(env.debug);
  const profile = Profile(debug);

  const provider = new ethers.providers.WebSocketProvider(env.CUSTOM_NODE_URL);

  // we need web3 for syth price feeds
  const web3 = getWeb3(env.CUSTOM_NODE_URL);

  // how often to run expensive state updates, defaults to 10 minutes
  const updateRateS = Number(env.UPDATE_RATE_S || 10 * 60);
  // Defaults to 60 seconds, since this is i think a pretty cheap call, and we want to see new contracts quickly
  const detectContractsUpdateRateS = Number(env.DETECT_CONTRACTS_UPDATE_RATE_S || 60);
  // Defaults to 15 minutes, prices dont update in coingecko or other calls very fast
  const priceUpdateRateS = Number(env.PRICE_UPDATE_RATE_S || 15 * 60);

  assert(updateRateS >= 1, "UPDATE_RATE_S must be 1 or higher");
  assert(detectContractsUpdateRateS >= 1, "DETECT_CONTRACTS_UPDATE_RATE_S must be 1 or higher");
  assert(priceUpdateRateS >= 1, "PRICE_UPDATE_RATE_S must be 1 or higher");

  // services can emit events when necessary, though for now any services that depend on events must be in same process
  const serviceEvents = new Events();

  const datastoreClient = new Datastore();
  const datastores = StoresFactory(datastoreClient);
  // state shared between services
  const appState: DatastoreAppState = {
    provider,
    web3,
    coingecko: new Coingecko(),
    zrx: new Zrx(env.zrxBaseUrl),
    emps: {
      active: tables.emps.Table("Active Emp", datastores.empsActive),
      expired: tables.emps.Table("Expired Emp", datastores.empsExpired),
    },
    prices: {
      usd: {
        latest: {},
        history: {},
      },
    },
    synthPrices: {
      latest: {},
      history: {},
    },
    marketPrices: {
      usdc: {
        latest: {},
        history: empStatsHistory.Table("Market Price", datastores.empStatsHistory),
      },
    },
    erc20s: tables.erc20s.Table("Erc20", datastores.erc20),
    stats: {
      emp: {
        usd: {
          latest: {
            tvm: empStats.Table("Latest Tvm", datastores.empStatsTvm),
            tvl: empStats.Table("Latest Tvl", datastores.empStatsTvl),
          },
          history: {
            tvm: empStatsHistory.Table("Tvm History", datastores.empStatsTvlHistory),
            tvl: empStatsHistory.Table("Tvl History", datastores.empStatsTvmHistory),
          },
        },
      },
      lsp: {
        usd: {
          latest: {
            tvl: empStats.Table("Latest Tvl", datastores.lspStatsTvl),
            tvm: empStats.Table("Latest Tvm", datastores.lspStatsTvm),
          },
          history: {
            tvl: empStatsHistory.Table("Tvl History", datastores.lspStatsTvlHistory),
          },
        },
      },
      global: {
        usd: {
          latest: {
            tvl: [0, "0"],
          },
          history: {
            tvl: empStatsHistory.Table("Tvl Global History"),
          },
        },
      },
    },
    lastBlockUpdate: 0,
    registeredEmps: new Set<string>(),
    registeredEmpsMetadata: new Map(),
    registeredLsps: new Set<string>(),
    registeredLspsMetadata: new Map(),
    collateralAddresses: new Set<string>(),
    syntheticAddresses: new Set<string>(),
    // lsp related props. could be its own state object
    longAddresses: new Set<string>(),
    shortAddresses: new Set<string>(),
    multicall2: new Multicall2(env.MULTI_CALL_2_ADDRESS, provider),
    lsps: {
      active: lsps.Table("Active LSP", datastores.lspsActive),
      expired: lsps.Table("Expired LSP", datastores.lspsExpired),
    },
    appStats: appStats.Table("App Stats", datastores.appStats),
  };

  // services for ingesting data
  const services = {
    // these services can optionally be configured with a config object, but currently they are undefined or have defaults
    emps: Services.EmpState({ debug }, appState),
    registry: await Services.Registry({ debug }, appState, (event, data) =>
      serviceEvents.emit("empRegistry", event, data)
    ),
    collateralPrices: Services.CollateralPrices({ debug }, appState),
    syntheticPrices: Services.SyntheticPrices(
      {
        debug,
        cryptowatchApiKey: env.cryptowatchApiKey,
        tradermadeApiKey: env.tradermadeApiKey,
        quandlApiKey: env.quandlApiKey,
        defipulseApiKey: env.defipulseApiKey,
      },
      appState
    ),
    erc20s: Services.Erc20s({ debug }, appState),
    empStats: Services.stats.Emp({ debug }, appState),
    marketPrices: Services.MarketPrices({ debug }, appState),
    lspCreator: await Services.MultiLspCreator({ debug, addresses: lspCreatorAddresses }, appState, (event, data) =>
      serviceEvents.emit("multiLspCreator", event, data)
    ),
    lsps: Services.LspState({ debug }, appState),
    lspStats: Services.stats.Lsp({ debug }, appState),
    globalStats: Services.stats.Global({ debug }, appState),
  };

  // backfill price histories, disable if not specified in env
  if (env.backfillDays) {
    console.log(`Backfilling price history from ${env.backfillDays} days ago`);
    await services.collateralPrices.backfill(moment().subtract(env.backfillDays, "days").valueOf());
    console.log("Updated Collateral Prices Backfill");
    await services.empStats.backfill();
    console.log("Updated EMP Backfill");

    await services.lspStats.backfill();
    console.log("Updated LSP Backfill");
  }

  // services consuming data
  const channels: Channels = [
    // set this as default channel for backward compatibility. This is deprecated and will eventually be used for global style queries
    ["", Actions.Emp(undefined, appState)],
    // Should switch all clients to explicit channels
    ["emp", Actions.Emp(undefined, appState)],
    ["lsp", Actions.Lsp(undefined, appState)],
    // TODO: switch this to root path once frontend is ready to transition
    ["global", Actions.Global(undefined, appState)],
  ];

  await Express({ port: Number(env.EXPRESS_PORT), debug }, channels)();
  console.log("Started Express Server, API accessible");

  async function detectNewContracts(startBlock: number, endBlock: number) {
    // ignore case when startblock == endblock, this can happen when loop is run before a new block has changed
    if (startBlock === endBlock) return;
    assert(startBlock < endBlock, "Startblock must be lower than endBlock");
    await services.registry(startBlock, endBlock);
    await services.lspCreator.update(startBlock, endBlock);
  }

  // break all state updates by block events into a cleaner function
  async function updateContractState(startBlock: number, endBlock: number) {
    // ignore case when startblock == endblock, this can happen when loop is run before a new block has changed
    if (startBlock === endBlock) return;
    assert(startBlock < endBlock, "Startblock must be lower than endBlock");
    // update everyting
    await services.emps.update(startBlock, endBlock);
    await services.lsps.update(startBlock, endBlock);
    await services.erc20s.update();
    await appState.appStats.setLastBlockUpdate(endBlock);
  }

  // separate out price updates into a different loop to query every few minutes
  async function updatePrices() {
    await services.collateralPrices.update();
    await services.syntheticPrices.update();
    await services.marketPrices.update();
    await services.empStats.update();
    await services.lspStats.update();
    await services.globalStats.update();
  }

  console.log("Starting API update loops");

  // listen for new lsp contracts since after we have started api, and make sure they get state updated asap
  // These events should only be bound after startup, since initialization above takes care of updating all contracts on startup
  // Because there is now a event driven dependency, the lsp creator and lsp state updater must be in same process
  serviceEvents.on("multiLspCreator", (event, data) => {
    // handle created events
    if (event === "created") {
      console.log("LspCreator found a new contract", JSON.stringify(data));
      services.lsps.updateLsps([data.address], data.startBlock, data.endBlock).catch(console.error);
    }
  });

  // listen for new emp contracts since after we start api, make sure they get state updates asap
  serviceEvents.on("empRegistry", (event, data) => {
    // handle created events
    if (event === "created") {
      console.log("EmpRegistry found a new contract", JSON.stringify(data));
      services.emps.updateAll([data.address], data.startBlock, data.endBlock).catch(console.error);
    }
  });

  async function getLatestBlockNumber() {
    const block = await provider.getBlock("latest");
    return block.number;
  }

  const lastBlockUpdate = await appState.appStats?.getLastBlockUpdate();
  const newContractBlockTick = BlockInterval(detectNewContracts, lastBlockUpdate);
  const updateContractStateTick = BlockInterval(updateContractState, lastBlockUpdate);

  // detect contract loop
  utils.loop(async () => {
    const end = profile("Detecting New Contracts");
    // adding in a timeout rejection if the update takes too long
    await expirePromise(
      async () => {
        const { startBlock, endBlock } = await newContractBlockTick(await getLatestBlockNumber());
        console.log("Checked for new contracts between blocks", startBlock, endBlock);
        // error out if this fails to complete in 5 minutes
      },
      5 * 60 * 1000,
      "Detecting new contracts timed out"
    )
      .catch(console.error)
      .finally(end);
  }, detectContractsUpdateRateS * 1000);

  // main update loop for all state, executes immediately and waits for updateRateS
  utils.loop(async () => {
    const end = profile("Running contract state updates");
    // adding in a timeout rejection if the update takes too long
    await expirePromise(
      async () => {
        const { startBlock, endBlock } = await updateContractStateTick(await getLatestBlockNumber());
        console.log("Updated Contract state between blocks", startBlock, endBlock);
        // throw an error if this fails to process in 15 minutes
      },
      15 * 60 * 1000,
      "Contract state updates timed out"
    )
      .catch(console.error)
      .finally(end);
  }, updateRateS * 1000);

  // coingeckos prices don't update very fast, so set it on an interval every few minutes
  utils.loop(async () => {
    const end = profile("Update all prices");
    await updatePrices().catch(console.error).finally(end);
  }, priceUpdateRateS * 1000);
};
