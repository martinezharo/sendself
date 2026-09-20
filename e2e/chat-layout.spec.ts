import { createSpace, expect, settle, test } from "./device";

async function assertChatOwnsScroll(page: Parameters<typeof createSpace>[0]): Promise<void> {
  const metrics = await page.evaluate(() => {
    const app = document.querySelector("#app");
    const chat = document.querySelector("textarea[placeholder='Write a message']")?.closest("main");
    const scroller = chat?.querySelector(".overflow-y-auto");
    const composer = document.querySelector("textarea[placeholder='Write a message']")
      ?.parentElement?.parentElement?.parentElement;

    return {
      documentHeight: document.documentElement.scrollHeight,
      documentViewport: document.documentElement.clientHeight,
      bodyHeight: document.body.scrollHeight,
      scrollerHeight: scroller?.getBoundingClientRect().height ?? 0,
      scrollerScrollHeight: scroller?.scrollHeight ?? 0,
      scrollerBottom: scroller?.getBoundingClientRect().bottom ?? 0,
      composerTop: composer?.getBoundingClientRect().top ?? 0,
      appBottom: app?.getBoundingClientRect().bottom ?? 0,
    };
  });

  expect(metrics.documentHeight).toBeLessThanOrEqual(metrics.documentViewport);
  expect(metrics.bodyHeight).toBeLessThanOrEqual(metrics.documentViewport);
  expect(metrics.scrollerHeight).toBeGreaterThan(0);
  expect(metrics.scrollerScrollHeight).toBeGreaterThanOrEqual(metrics.scrollerHeight);
  expect(metrics.scrollerBottom).toBeLessThanOrEqual(metrics.composerTop);
  expect(metrics.appBottom).toBeLessThanOrEqual(metrics.documentViewport);
}

test("keeps chat scrolling inside the app shell on desktop", async ({ device }) => {
  const page = await device.launch();
  await createSpace(page, "Casa", "Portátil");
  await assertChatOwnsScroll(page);
});

test("keeps chat scrolling inside the app shell on mobile", async ({ device }) => {
  const page = await device.launch();
  await page.setViewportSize({ width: 390, height: 844 });
  await createSpace(page, "Casa", "Teléfono");
  await settle(page);
  await assertChatOwnsScroll(page);
});
