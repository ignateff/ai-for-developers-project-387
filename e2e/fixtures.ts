import { test as base } from "@playwright/test";
import { FIXED_NOW } from "./fixed-now";

export { expect, type APIRequestContext, type Page } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    // Freeze Date without stopping timers used by transitions and retries.
    await page.clock.setFixedTime(FIXED_NOW);
    await use(page);
  },
});
