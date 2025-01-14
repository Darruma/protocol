// this should only run as a single instance, will continue updating the active request as needed.
// this is a single poller for requests on all chains
import { Update } from "../update";
import Store from "../../store";
import { RequestState } from "../../types/state";
import { Handlers as GenericHandlers } from "../../types/statemachine";
import { ContextClient } from "./utils";
import { ignoreError } from "../../utils";

// required exports for state machine
export type Params = undefined;
export type Memory = { error?: Error; iterations: number };
export function initMemory(): Memory {
  return { iterations: 0 };
}
export function Handlers(store: Store): GenericHandlers<Params, Memory> {
  const update = new Update(store);
  return {
    async start(params: Params, memory: Memory, ctx: ContextClient): Promise<void | undefined> {
      memory.error = undefined;
      try {
        const request = store.read().request();
        // requests can change externally if not already in one of these states
        const shouldUpdate = request.state !== RequestState.Invalid && request.state !== RequestState.Settled;

        shouldUpdate && (await update.request());

        // might as well update block time on an interval
        await update.currentTime();
      } catch (err) {
        // store for debugging
        memory.error = (err as unknown) as Error;
      }

      memory.iterations++;
      const { checkTxIntervalSec = 30 } = ignoreError(store.read().chainConfig) || {};
      return ctx.sleep(checkTxIntervalSec * 1000);
    },
  };
}
