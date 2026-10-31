/**
 * 主密码输错限速:前几次免费,之后每失败一次,冷却时间翻倍(最多一分钟)。
 * 解锁、导出、修改主密码共用同一个计数,成功一次即清零。
 */
export class AttemptLimiter {
  private failures = 0;
  private blockedUntil = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly freeAttempts = 3,
    private readonly maxDelayMs = 60_000,
  ) {}

  /** 还需要等待的毫秒数;0 表示可以尝试。 */
  wait(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  fail(): void {
    this.failures += 1;
    const extra = this.failures - this.freeAttempts;
    if (extra > 0) this.blockedUntil = this.now() + Math.min(1000 * 2 ** (extra - 1), this.maxDelayMs);
  }

  success(): void {
    this.failures = 0;
    this.blockedUntil = 0;
  }
}
