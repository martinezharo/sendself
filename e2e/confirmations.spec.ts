import { createSpace, expect, test } from "./device";

test("links a peer, confirms message deletion, and manages the peer's access", async ({
  device,
  browser,
  baseURL,
}) => {
  const owner = await device.launch();
  const spaceId = await createSpace(owner, "Home", "Laptop");
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  try {
    const peer = await context.newPage();
    await peer.routeWebSocket(/\/api\/realtime/, (ws) => ws.close());
    await peer.goto(`${baseURL}/app`);
    await peer.getByText("Link to an existing space").click();
    await peer.getByPlaceholder("e.g. My phone").fill("Phone");
    await peer.getByRole("button", { name: "Generate linking code" }).click();
    await peer.getByRole("button", { name: "Can't scan? Copy code" }).click();
    await expect(peer.getByRole("button", { name: "Code copied" })).toBeVisible();
    const code = await peer.evaluate(() => navigator.clipboard.readText());

    await owner.getByRole("link", { name: "Devices", exact: true }).click();
    await owner.getByRole("button", { name: "Add device", exact: true }).click();
    await owner.getByRole("button", { name: "Paste code", exact: true }).click();
    await owner.getByPlaceholder("Paste the linking code from the new device").fill(code);
    await owner.getByRole("button", { name: "Authorize device" }).click();
    await expect(peer.getByPlaceholder("Write a message")).toBeVisible();
    await expect(owner.getByRole("button", { name: "Actions for Phone" })).toBeVisible();

    // Delivery and global deletion exercise the separated message and pairing actions together.
    await owner.getByRole("link", { name: "Messages", exact: true }).click();
    await owner.getByPlaceholder("Write a message").fill("Keep until confirmed");
    await owner.getByRole("button", { name: "Send message" }).click();
    await expect(peer.getByText("Keep until confirmed", { exact: true })).toBeVisible({
      timeout: 75_000,
    });
    await owner.getByText("Keep until confirmed", { exact: true }).click({ button: "right" });
    await owner.getByRole("menuitem", { name: "Delete on all devices" }).click();
    const confirmation = owner.getByRole("dialog", { name: "Delete on all devices?" });
    if (process.env.SHOTS_DIR) {
      await confirmation.waitFor();
      await owner.screenshot({
        path: `${process.env.SHOTS_DIR}/confirmation-desktop.webp`,
        animations: "disabled",
      });
      await owner.setViewportSize({ width: 390, height: 844 });
      await owner.screenshot({
        path: `${process.env.SHOTS_DIR}/confirmation-mobile.webp`,
        animations: "disabled",
      });
      await owner.setViewportSize({ width: 1280, height: 720 });
    }
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(owner.getByText("Keep until confirmed", { exact: true })).toBeVisible();
    await owner.getByText("Keep until confirmed", { exact: true }).click({ button: "right" });
    await owner.getByRole("menuitem", { name: "Delete on all devices" }).click();
    await confirmation.getByRole("button", { name: "Delete everywhere" }).click();
    await expect(owner.getByText("Keep until confirmed", { exact: true })).toBeHidden();

    await owner.goto(`/app/${spaceId}/devices`);
    await owner.getByRole("button", { name: "Actions for Phone" }).click();
    await owner.getByRole("menuitem", { name: "Make admin" }).click();
    await owner
      .getByRole("dialog", { name: "Make administrator?" })
      .getByRole("button", { name: "Make admin" })
      .click();
    await expect(owner.getByText("Phone is now an administrator", { exact: true })).toBeVisible();
    await owner.getByRole("button", { name: "Actions for Phone" }).click();
    await owner.getByRole("menuitem", { name: "Revoke" }).click();
    await owner
      .getByRole("dialog", { name: "Revoke this device?" })
      .getByRole("button", { name: "Revoke device" })
      .click();
    await expect(owner.getByRole("button", { name: "Actions for Phone" })).toBeHidden();
  } finally {
    for (const page of context.pages()) await page.goto("about:blank").catch(() => {});
    await context.close();
  }
});

test("confirms vault deletion, history retention, lock removal and leaving a space", async ({
  device,
}) => {
  const page = await device.launch();
  await createSpace(page, "Home", "Laptop");
  await page.getByRole("link", { name: "Vault", exact: true }).click();
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("Temporary");
  await page.getByRole("button", { name: "Create folder" }).click();
  await page.getByRole("button", { name: "Options for Temporary" }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await page.getByRole("link", { name: /Trash/ }).click();
  await page.getByRole("button", { name: "Options for Temporary" }).click();
  await page.getByRole("menuitem", { name: "Delete for good" }).click();
  const deletion = page.getByRole("dialog", { name: "Delete for good?" });
  await deletion.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Options for Temporary" })).toBeVisible();
  await page.getByRole("button", { name: "Options for Temporary" }).click();
  await page.getByRole("menuitem", { name: "Delete for good" }).click();
  await deletion.getByRole("button", { name: "Delete for good", exact: true }).click();
  await expect(page.getByText("The trash is empty")).toBeVisible();

  await page.getByRole("link", { name: "Devices", exact: true }).click();
  const retention = page.getByLabel("Keep history on this device for");
  await retention.selectOption("30");
  const history = page.getByRole("dialog", { name: "Delete older history?" });
  await history.getByRole("button", { name: "Cancel" }).click();
  await expect(retention).toHaveValue("");
  await retention.selectOption("30");
  await history.getByRole("button", { name: "Delete older history", exact: true }).click();
  await expect(retention).toHaveValue("30");

  await page.getByRole("button", { name: "Set a lock" }).click();
  await page.getByLabel("Passphrase or PIN").fill("test-passphrase");
  await page.getByLabel("Repeat it").fill("test-passphrase");
  await page.getByRole("button", { name: "Lock this device", exact: true }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Remove the lock?" })
    .getByRole("button", { name: "Remove it" })
    .click();
  await expect(page.getByRole("button", { name: "Set a lock" })).toBeVisible();

  await page.getByRole("button", { name: "Space options" }).first().click();
  await page.getByRole("menuitem", { name: "Leave space" }).click();
  await page
    .getByRole("dialog", { name: "Leave this space?" })
    .getByRole("button", { name: "Stay" })
    .click();
  await expect(page.getByRole("heading", { name: "Linked devices" })).toBeVisible();
  await page.getByRole("button", { name: "Space options" }).first().click();
  await page.getByRole("menuitem", { name: "Leave space" }).click();
  await page
    .getByRole("dialog", { name: "Leave this space?" })
    .getByRole("button", { name: "Leave space" })
    .click();
  await expect(page.getByText("Create a new space")).toBeVisible();
});
