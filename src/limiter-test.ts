import assert from "node:assert/strict";
import { AttemptLimiter } from "./limiter.js";

let now = 1_000_000;
const limiter = new AttemptLimiter(() => now, 3, 60_000);

// 前 3 次失败不限速
for (let i = 0; i < 3; i += 1) {
  assert.equal(limiter.wait(), 0);
  limiter.fail();
}
assert.equal(limiter.wait(), 0);

// 之后每失败一次,冷却时间翻倍
limiter.fail();
assert.equal(limiter.wait(), 1000);
now += 1000;
assert.equal(limiter.wait(), 0);
limiter.fail();
assert.equal(limiter.wait(), 2000);
now += 2000;
limiter.fail();
assert.equal(limiter.wait(), 4000);

// 上限一分钟
for (let i = 0; i < 20; i += 1) limiter.fail();
assert.equal(limiter.wait(), 60_000);

// 成功一次清零
limiter.success();
assert.equal(limiter.wait(), 0);
limiter.fail();
assert.equal(limiter.wait(), 0);

console.log("limiter-test OK");
