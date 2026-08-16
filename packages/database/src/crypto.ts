import crypto from 'crypto';
import { config } from '@revynta/config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard IV length

/**
 * Encrypts a string using AES-256-GCM
 */
export function encryptPII(text: string): string {
  const masterKey = config.security.piiEncryptionKey || 'default_revynta_pii_encryption_key_32bytes';
  const keyBuffer = crypto.createHash('sha256').update(masterKey).digest();

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag().toString('hex');
  
  // Format: iv:tag:ciphertext
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string
 */
export function decryptPII(encryptedValue: string): string {
  const masterKey = config.security.piiEncryptionKey || 'default_revynta_pii_encryption_key_32bytes';
  const keyBuffer = crypto.createHash('sha256').update(masterKey).digest();

  const parts = encryptedValue.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload: Expected iv:tag:ciphertext');
  }

  const [ivHex, tagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Hashes an identifier (email/phone) deterministically using SHA-256 for index lookups.
 * Always lowercases input to ensure match consistency.
 */
export function hashIdentifier(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}
