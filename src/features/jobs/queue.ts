import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../../config/env";

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const creditDeductionQueue = new Queue("credit-deduction", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

export const sessionWatchdogQueue = new Queue("session-watchdog", {
  connection: redisConnection,
});

export const holdExpiryQueue = new Queue("hold-expiry", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
});
