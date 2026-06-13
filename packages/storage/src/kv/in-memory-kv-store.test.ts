import { InMemoryKvStore } from "./in-memory-kv-store.js";
import { describeKvStoreContract } from "./kv-store.conformance.js";

describeKvStoreContract("InMemoryKvStore", () => {
  let clock = 0;
  const store = new InMemoryKvStore({ now: () => clock });
  return {
    store,
    advance: (ms: number) => {
      clock += ms;
    },
  };
});
