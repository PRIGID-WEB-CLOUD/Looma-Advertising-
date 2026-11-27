import type { MediaObject, MediaStorage } from '../server/storage/mediaStorage';

export function createR2MediaStorage(bucket: R2Bucket): MediaStorage {
  return {
    async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
      if (!key || key.includes('..') || key.includes('/') || key.includes('\\')) {
        throw new Error('Invalid upload destination path');
      }
      await bucket.put(key, data, {
        httpMetadata: {
          contentType,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
    },

    async get(key: string): Promise<MediaObject | null> {
      if (!key || !/^[a-zA-Z0-9._-]+$/.test(key)) {
        return null;
      }
      const object = await bucket.get(key);
      if (!object) return null;
      const buf = await object.arrayBuffer();
      return {
        data: new Uint8Array(buf),
        contentType: object.httpMetadata?.contentType,
      };
    },

    async delete(key: string): Promise<void> {
      if (!key || !/^[a-zA-Z0-9._-]+$/.test(key)) return;
      await bucket.delete(key);
    },
  };
}
