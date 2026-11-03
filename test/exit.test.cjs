const test = require("node:test"); const assert = require("node:assert");
const { decideExit } = require("../src/lib/trader.cjs");
const s = (price) => ({ price, resolved: false, expired: false, secondsLeft: 3600 });
test("sells YES when AMM bid beats model", () => { const d = decideExit({ s: s(0.7), pModel: 0.5, side: "yes", tokens: 10e6 }); assert.equal(d.action, "sell"); assert.equal(d.dir, "yesToUsdc"); assert.equal(d.amount, 5e6); });
test("holds when model still favours inventory", () => assert.equal(decideExit({ s: s(0.5), pModel: 0.6, side: "yes", tokens: 10e6 }).action, "hold"));
test("NO side mirrors", () => assert.equal(decideExit({ s: s(0.2), pModel: 0.5, side: "no", tokens: 10e6 }).dir, "noToUsdc"));
test("closed / empty / tiny hold", () => { assert.equal(decideExit({ s: { ...s(0.9), resolved: true }, pModel: 0.1, side: "yes", tokens: 1e7 }).reason, "closed"); assert.equal(decideExit({ s: s(0.9), pModel: 0.1, side: "yes", tokens: 0 }).reason, "no-inventory"); assert.equal(decideExit({ s: s(0.9), pModel: 0.1, side: "yes", tokens: 1e6 }).reason, "too-small"); });
