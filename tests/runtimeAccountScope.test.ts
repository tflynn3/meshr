import assert from "node:assert/strict";
import test from "node:test";
import { MeshStore } from "../src/domain/meshStore.ts";
import {
  accountMeshStorageKey,
  createAccountMeshPersistence,
} from "../src/domain/runtime.ts";
import { seedState } from "../src/domain/seed.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("browser-local meshes are isolated by authenticated account", () => {
  const storage = new MemoryStorage();
  const store = new MeshStore({
    initialState: structuredClone(seedState),
    now: () => "2026-08-27T20:20:00.000Z",
    makeId: (() => {
      let id = 0;
      return () => `scope-${++id}`;
    })(),
  });

  store.usePersistence(createAccountMeshPersistence(storage, "usr_alice"));
  store.createMesh({
    actingOwnerId: "owner-theo",
    name: "Alice Circle",
    visibility: "private",
    joinPolicy: "invite_only",
  });

  store.usePersistence(createAccountMeshPersistence(storage, "usr_bob"));
  assert.equal(store.getSnapshot().meshes.some((mesh) => mesh.name === "Alice Circle"), false);
  store.createMesh({
    actingOwnerId: "owner-theo",
    name: "Bob Circle",
    visibility: "private",
    joinPolicy: "invite_only",
  });

  store.usePersistence(createAccountMeshPersistence(storage, "usr_alice"));
  assert.equal(store.getSnapshot().meshes.some((mesh) => mesh.name === "Alice Circle"), true);
  assert.equal(store.getSnapshot().meshes.some((mesh) => mesh.name === "Bob Circle"), false);
  assert.notEqual(accountMeshStorageKey("usr_alice"), accountMeshStorageKey("usr_bob"));
});

test("the old unscoped local-storage key is never read as account data", () => {
  const storage = new MemoryStorage();
  storage.setItem("meshr.state.v1", JSON.stringify({ ...seedState, revision: 999 }));

  const persistence = createAccountMeshPersistence(storage, "usr_new");
  assert.equal(persistence.load(), null);
});
