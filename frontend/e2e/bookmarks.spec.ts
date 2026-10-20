import { test, expect } from "@playwright/test";

let profileId: string;

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/profiles", { data: { name: "Bookmark E2E" } });
  const body = await response.json();
  profileId = body.profile.id;
  await request.put(`/api/profiles/${profileId}/settings`, {
    data: { dataSource: "sqlite", rating: "general", language: "en" },
  });
});

test("bookmarks: optimistic update, rollback, persistence, detail, and route", async ({ page }) => {
  await page.addInitScript((id) => localStorage.setItem("boorux.profile", id), profileId);
  let failNext = false;
  let releaseFailure: (() => void) | undefined;
  let holdFailure = false;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  await page.route("**/api/posts/*/bookmark?**", async (route) => {
    if (failNext) {
      failNext = false;
      if (holdFailure) await failureGate;
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

  failNext = true;
  holdFailure = true;
  await timelineButton.click();
  await expect(timelineButton).toHaveAttribute("aria-pressed", "true");
  holdFailure = false;
  releaseFailure?.();
  await expect(timelineCard.locator(".bookmark-error")).toContainText("Simulated bookmark failure");
  await expect(timelineButton).toHaveAttribute("aria-pressed", "false");

  await timelineButton.click();
  await expect(timelineButton).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.locator(`.post-card[data-post-id="${id}"] .bookmark-button`)).toHaveAttribute("aria-pressed", "true");

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

  await page.goto("/bookmarks");
  await expect(page.locator(`.post-card[data-post-id="${id}"]`)).toBeVisible();
  await page.locator(`.post-card[data-post-id="${id}"] .bookmark-button`).click();
  await expect(page.locator(`.post-card[data-post-id="${id}"]`)).toHaveCount(0);
});
