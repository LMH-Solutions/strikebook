import { describe, it, expect, vi } from "vitest";
import { detectInjected, injectedWallet } from "./wallet.js";

describe("M3 step 3: injected wallets (Phantom / Backpack)", () => {
  const sign = () => ({ signTransaction: vi.fn(async (t) => ({ ...t, signed: true })) });
  it("detects Phantom and Backpack, de-duplicates window.solana, ignores non-signers", () => {
    const phantom = { isPhantom: true, ...sign() };
    const backpack = { isBackpack: true, ...sign() };
    const found = detectInjected({ phantom: { solana: phantom }, backpack, solana: phantom });
    expect(found.map((w) => [w.id, w.name])).toEqual([["phantom", "Phantom"], ["backpack", "Backpack"]]);
    expect(detectInjected({ solana: { isPhantom: true, ...sign() } }).map((w) => w.name)).toEqual(["Phantom"]);
    expect(detectInjected({ solana: { connect() {} } })).toEqual([]);
    expect(detectInjected(undefined)).toEqual([]);
  });
  it("injectedWallet delegates signing and falls back when signAllTransactions is missing", async () => {
    const p = sign();
    const w = injectedWallet(p, "PK");
    expect(w.publicKey).toBe("PK");
    expect(await w.signTransaction({ a: 1 })).toEqual({ a: 1, signed: true });
    expect(await w.signAllTransactions([{ a: 1 }, { a: 2 }])).toHaveLength(2);
    expect(p.signTransaction).toHaveBeenCalledTimes(3);
  });
});
