import { randomBytes } from 'node:crypto';

/**
 * A random password nobody knows, for accounts created without one: the member sets their own
 * from the welcome email's link (or "forgot password") before they can sign in.
 */
export const unusablePassword = () => randomBytes(32).toString('base64url');
