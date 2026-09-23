import { MAX_FILE_SIZE, MESSAGE_TTL_MS, PAIRING_TTL_MS } from "@sendself/shared";
import { PBKDF2_ITERATIONS } from "../crypto/vault";

/**
 * The numbers the public site quotes, read from the code that enforces them.
 *
 * Every page of the site states limits and lifetimes, and each one used to be
 * typed out by hand in whichever page mentioned it — so a change to the real
 * limit left the site promising the old one. Deriving the copy from the
 * constants makes the site wrong only if the code is.
 */

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const SITE_ORIGIN = "https://sendself.4oli.com";
/** Who runs the service, and so answers for the data it processes. */
export const OPERATOR = "Oliver Martínez Haro";
export const REPO_URL = "https://github.com/martinezharo/sendself";
/** The technical write-up the security page summarises. */
export const SECURITY_DOC_URL = `${REPO_URL}/blob/main/docs/security.md`;
/** Where vulnerabilities are reported privately, rather than in a public issue. */
export const SECURITY_REPORT_URL = `${REPO_URL}/security`;
export const ISSUES_URL = `${REPO_URL}/issues`;

/** "50 MiB" */
export const MAX_FILE_LABEL = `${MAX_FILE_SIZE / 1024 / 1024} MiB`;
/** "24 hours" */
export const SERVER_RETENTION_LABEL = `${MESSAGE_TTL_MS / HOUR_MS} hours`;
/** "10 minutes" */
export const PAIRING_TTL_LABEL = `${PAIRING_TTL_MS / MINUTE_MS} minutes`;
/** "600,000" */
export const PBKDF2_ITERATIONS_LABEL = PBKDF2_ITERATIONS.toLocaleString("en-US");
