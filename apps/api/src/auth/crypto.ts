import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const opaqueToken = () => randomBytes(32).toString('base64url');
export const equalHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const deriveReplacement = (token: string, secret: string) =>
  createHmac('sha256', secret).update(`refresh-replacement-v1:${token}`).digest('base64url');

const key = (secret: string) => new TextEncoder().encode(secret);
export async function signAccess(userId: string, sessionId: string, secret: string) {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(userId)
    .setIssuer('fit-tempo-api').setAudience('fit-tempo-web')
    .setJti(opaqueToken()).setIssuedAt().setExpirationTime('10m').sign(key(secret));
}
export async function verifyAccess(token: string, secret: string) {
  const { payload } = await jwtVerify(token, key(secret), {
    algorithms: ['HS256'], issuer: 'fit-tempo-api', audience: 'fit-tempo-web',
  });
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new Error('Invalid access claims');
  return { userId: payload.sub, sessionId: payload.sid };
}
