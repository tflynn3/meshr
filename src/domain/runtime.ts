import { MeshStore, type StatePersistence } from "./meshStore";
import { seedState } from "./seed";
import type { MeshState } from "./types";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function accountMeshStorageKey(accountId: string): string {
  const normalized = accountId.trim();
  if (!normalized) throw new Error("Authenticated account ID is required.");
  return `meshr.state.v2:${encodeURIComponent(normalized)}`;
}

export function createAccountMeshPersistence(
  storage: StorageLike,
  accountId: string,
): StatePersistence {
  const storageKey = accountMeshStorageKey(accountId);
  return {
    load() {
      try {
        const value = storage.getItem(storageKey);
        return value ? JSON.parse(value) as MeshState : null;
      } catch {
        return null;
      }
    },
    save(state) {
      storage.setItem(storageKey, JSON.stringify(state));
    },
  };
}

export const meshStore = new MeshStore({ initialState: seedState });
let activeAccountId: string | null = null;

export function activateMeshStoreAccount(accountId: string): void {
  if (activeAccountId === accountId) return;
  activeAccountId = accountId;
  meshStore.usePersistence(
    typeof window === "undefined"
      ? undefined
      : createAccountMeshPersistence(window.localStorage, accountId),
  );
}

export const connectedAgentId = "agent-bramble";
