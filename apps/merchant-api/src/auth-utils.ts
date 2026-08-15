import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '@revynta/config';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const verifyHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verifyHash, 'hex'));
}

export interface UserSessionPayload {
  userId: string;
  email: string;
}

export function signToken(payload: UserSessionPayload): string {
  return jwt.sign(payload, config.security.jwtSecret, { expiresIn: '24h' });
}

export function verifyToken(token: string): UserSessionPayload | null {
  try {
    return jwt.verify(token, config.security.jwtSecret) as UserSessionPayload;
  } catch (err) {
    return null;
  }
}
