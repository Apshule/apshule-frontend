import { ApiError, requireEnv } from "./db.js";

const encoder = new TextEncoder();
const ENCRYPTION_VERSION = "v1";

function encryptionKeyBytes(secret: string | undefined): Uint8Array {
  const value = requireEnv(secret, "SETTINGS_ENCRYPTION_KEY");
  if (!/^[0-9a-f]{64}$/iu.test(value)) {
    throw new ApiError(
      503,
      "INVALID_SETTINGS_ENCRYPTION_KEY",
      "SETTINGS_ENCRYPTION_KEY must be a 32-byte hexadecimal value.",
    );
  }

  return Uint8Array.from(
    value.match(/.{2}/gu) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Invalid encrypted setting.");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function importEncryptionKey(secret: string | undefined): Promise<CryptoKey> {
  const bytes = encryptionKeyBytes(secret);
  return crypto.subtle.importKey(
    "raw",
    bytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function settingAdditionalData(settingKey: string): Uint8Array {
  return encoder.encode(`APSHULE:platform_settings:${settingKey}`);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export async function encryptPlatformSetting(
  value: string,
  secret: string | undefined,
  settingKey: string,
): Promise<string> {
  const key = await importEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(iv),
      additionalData: asArrayBuffer(settingAdditionalData(settingKey)),
    },
    key,
    encoder.encode(value),
  );
  return `${ENCRYPTION_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptPlatformSetting(
  encryptedValue: string,
  secret: string | undefined,
  settingKey: string,
): Promise<string> {
  try {
    const [version, encodedIv, encodedCiphertext, extra] = encryptedValue.split(".");
    if (version !== ENCRYPTION_VERSION || !encodedIv || !encodedCiphertext || extra) {
      throw new Error("Invalid encrypted setting.");
    }

    const key = await importEncryptionKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(fromBase64Url(encodedIv)),
        additionalData: asArrayBuffer(settingAdditionalData(settingKey)),
      },
      key,
      asArrayBuffer(fromBase64Url(encodedCiphertext)),
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      503,
      "PLATFORM_SETTINGS_UNREADABLE",
      "Stored platform settings could not be decrypted.",
    );
  }
}