import fs from 'node:fs';
import path from 'node:path';

export interface MediaObject {
  data: Uint8Array;
  contentType?: string;
}

export interface MediaStorage {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<MediaObject | null>;
  delete(key: string): Promise<void>;
}

export function createLocalMediaStorage(getUploadDir?: () => string): MediaStorage {
  const resolveDir = () =>
    getUploadDir ? getUploadDir() : path.resolve(process.cwd(), process.env.LOOMA_STORAGE_DIR || 'data/uploads');

  return {
    async put(key: string, data: Uint8Array): Promise<void> {
      const uploadDir = resolveDir();
      fs.mkdirSync(uploadDir, { recursive: true });
      const targetPath = path.resolve(uploadDir, key);
      if (!targetPath.startsWith(uploadDir + path.sep)) {
        throw new Error('Invalid upload destination path');
      }
      fs.writeFileSync(targetPath, data);
    },

    async get(key: string): Promise<MediaObject | null> {
      const uploadDir = resolveDir();
      const targetPath = path.resolve(uploadDir, key);
      if (!targetPath.startsWith(uploadDir + path.sep) || !fs.existsSync(targetPath)) {
        return null;
      }
      const data = fs.readFileSync(targetPath);
      return { data: new Uint8Array(data) };
    },

    async delete(key: string): Promise<void> {
      const uploadDir = resolveDir();
      const targetPath = path.resolve(uploadDir, key);
      if (targetPath.startsWith(uploadDir + path.sep) && fs.existsSync(targetPath)) {
        try {
          fs.unlinkSync(targetPath);
        } catch {
          // Ignore filesystem unlink errors after DB deletion
        }
      }
    },
  };
}
