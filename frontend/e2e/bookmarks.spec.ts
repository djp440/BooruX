import { test, expect } from "@playwright/test";

test("bookmarks: optimistic update, rollback, persistence, detail, and route", async ({ page }) => {
  let failNext = false;
  await page.route("**/api/posts/*/bookmark?**", async (route) => {
    const request = route.request();
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Simulated bookmark failure" }) });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  const timelineCard = page.locator(".post-card").first();
  await expect(timelineCard).toBeVisible();
  const id = await timelineCard.getAttribute("data-post-id");
  if (!id) throw new Error("timeline card has no post id");
  const timelineButton = timelineCard.locator(".bookmark-button");
  if (await timelineButton.getAttribute("aria-pressed") === "true") {
    await timelineButton.click();
    await expect(timelineButton).toHaveAttribute("aria-pressed", "false");
  }
  await timelineButton.click();
  await expect(timelineButton).toHaveAttribute("aria-pressed", "true");

  await page.goto("/bookmarks");
  const card = page.locator(`.post-card[data-post-id="${id}"]`);
  await expect(card).toBeVisible();
  await card.locator(".bookmark-button").click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`.post-card[data-post-id="${id}"]`)).toHaveCount(0);

  await page.goto(`/post/${id}`);
  await expect(page.locator(".detail-card .bookmark-button")).toHaveAttribute("aria-pressed", "false");
  await page.locator(".detail-card .bookmark-button").click();
  await expect(page.locator(".detail-card .bookmark-button")).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.locator(".detail-card .bookmark-button")).toHaveAttribute("aria-pressed", "true");

  failNext = true;
  await page.locator(".detail-card .bookmark-button").click();
  await expect(page.locator(".detail-card .bookmark-error")).toContainText("Simulated bookmark failure");
  await expect(page.locator(".detail-card .bookmark-button")).toHaveAttribute("aria-pressed", "true");

  await page.goto("/bookmarks");
  await expect(page.locator(`.post-card[data-post-id="${id}"]`)).toBeVisible();
  await page.locator(`.post-card[data-post-id="${id}"] .bookmark-button`).click();
  await expect(page.locator(`.post-card[data-post-id="${id}"]`)).toHaveCount(0);
});


