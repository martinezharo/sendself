import { describe, expect, it } from "vitest";
import {
  InviteMismatchError,
  createInvite,
  createJoiningDevice,
  deviceFingerprint,
  formatInviteCode,
  openInvite,
  parseInviteCode,
} from "./pairing";

describe("invitations", () => {
  it("round-trip through the code a person pastes", () => {
    const invite = createInvite();
    expect(parseInviteCode(` ${formatInviteCode(invite)}\n`)).toEqual(invite);
    expect(parseInviteCode("not-a-code")).toBeNull();
    expect(parseInviteCode(`${invite.pairingId}.short`)).toBeNull();
  });

  it("let the inviting device read the name of whoever answered with the code", async () => {
    const invite = createInvite();
    const joining = await createJoiningDevice("VPS", { sendOnly: true, invite });
    const { device, invite: sealed } = joining.request;

    expect(joining.payload.pairingId).toBe(invite.pairingId);
    expect(sealed).toBeDefined();
    const name = await openInvite(invite, sealed!, {
      pairingId: invite.pairingId,
      deviceId: device.id,
      publicKey: device.publicKey,
      signingPublicKey: device.signingPublicKey!,
      sendOnly: true,
    });
    expect(name).toBe("VPS");
  });

  it("refuse keys swapped in after the device sealed its answer", async () => {
    const invite = createInvite();
    const honest = await createJoiningDevice("VPS", { sendOnly: true, invite });
    const swapped = await createJoiningDevice("VPS", { sendOnly: true });
    const fields = {
      pairingId: invite.pairingId,
      deviceId: honest.request.device.id,
      publicKey: swapped.request.device.publicKey,
      signingPublicKey: honest.request.device.signingPublicKey!,
      sendOnly: true,
    };

    await expect(openInvite(invite, honest.request.invite!, fields)).rejects.toBeInstanceOf(
      InviteMismatchError,
    );
  });

  it("refuse an answer sealed without the secret", async () => {
    const invite = createInvite();
    const forger = await createJoiningDevice("VPS", {
      sendOnly: true,
      invite: { ...invite, secret: createInvite().secret },
    });
    const { device } = forger.request;

    await expect(
      openInvite(invite, forger.request.invite!, {
        pairingId: invite.pairingId,
        deviceId: device.id,
        publicKey: device.publicKey,
        signingPublicKey: device.signingPublicKey!,
        sendOnly: true,
      }),
    ).rejects.toBeInstanceOf(InviteMismatchError);
  });

  it("refuse an answer that changed whether the device is send-only", async () => {
    const invite = createInvite();
    const joining = await createJoiningDevice("VPS", { sendOnly: true, invite });
    const { device } = joining.request;

    await expect(
      openInvite(invite, joining.request.invite!, {
        pairingId: invite.pairingId,
        deviceId: device.id,
        publicKey: device.publicKey,
        signingPublicKey: device.signingPublicKey!,
        sendOnly: false,
      }),
    ).rejects.toBeInstanceOf(InviteMismatchError);
  });
});

describe("deviceFingerprint", () => {
  it("is short, stable and different for different keys", async () => {
    const a = await deviceFingerprint("pk-a", "spk-a");
    expect(a).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(await deviceFingerprint("pk-a", "spk-a")).toBe(a);
    expect(await deviceFingerprint("pk-b", "spk-a")).not.toBe(a);
  });
});
