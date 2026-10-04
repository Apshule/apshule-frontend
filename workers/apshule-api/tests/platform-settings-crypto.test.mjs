import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptPlatformSetting,
  encryptPlatformSetting,
} from "../src/platform-settings-crypto.ts";

const encryptionKey = "0123456789abcdef".repeat(4);

test("platform settings use randomized AES-GCM ciphertext and round-trip", async () => {
  const first = await encryptPlatformSetting(
    "private-api-password",
    encryptionKey,
    "yo_api_password",
  );
  const second = await encryptPlatformSetting(
    "private-api-password",
    encryptionKey,
    "yo_api_password",
  );

  assert.match(first, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.notEqual(first, second);
  assert.equal(first.includes("private-api-password"), false);
  assert.equal(
    await decryptPlatformSetting(first, encryptionKey, "yo_api_password"),
    "private-api-password",
  );
});

test("platform settings reject invalid keys, tampering, and key swapping", async () => {
  await assert.rejects(
    encryptPlatformSetting("value", "not-a-32-byte-hex-key", "yo_api_password"),
    /32-byte hexadecimal/u,
  );

  const encrypted = await encryptPlatformSetting(
    "private-api-password",
    encryptionKey,
    "yo_api_password",
  );
  await assert.rejects(
    decryptPlatformSetting(encrypted, "fedcba9876543210".repeat(4), "yo_api_password"),
    /could not be decrypted/u,
  );
  await assert.rejects(
    decryptPlatformSetting(encrypted, encryptionKey, "yo_api_username"),
    /could not be decrypted/u,
  );
});