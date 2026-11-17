import type { Config } from "../config.js";
import { FirestoreStore } from "./firestore.js";
import { InMemoryStore } from "./memory.js";
import type { Store } from "./types.js";

export function createStore(config: Config): Store {
  return config.storeBackend === "memory"
    ? new InMemoryStore()
    : new FirestoreStore(config.firestoreDatabaseId);
}

export type { Store } from "./types.js";
export { InMemoryStore } from "./memory.js";
