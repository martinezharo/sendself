/**
 * base64url (RFC 4648 §5, unpadded): how every key, IV and ciphertext travels
 * on the wire. Shared so the Worker and the clients cannot encode differently.
 */

// Every runtime that loads this (browsers, workers, Node, workerd) has these;
// declared here because this package compiles against the bare ES lib.
declare function atob(data: string): string;
declare function btoa(data: string): string;

export function bufToBase64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBuf(value: string): ArrayBuffer {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
