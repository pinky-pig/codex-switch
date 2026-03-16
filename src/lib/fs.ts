import fs from "node:fs/promises";
import path from "node:path";

import { FILE_MODE_OWNER_ONLY } from "./constants.js";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content) as T;
}

export async function writeJsonSecure(filePath: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeTextAtomic(filePath, content);
}

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const parentDir = path.dirname(filePath);
  const tempPath = path.join(
    parentDir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  await ensureDir(parentDir);
  await fs.writeFile(tempPath, content, { mode: FILE_MODE_OWNER_ONLY });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, FILE_MODE_OWNER_ONLY);
}

export async function copyFileSecure(sourcePath: string, targetPath: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
  await fs.chmod(targetPath, FILE_MODE_OWNER_ONLY);
}

export async function safeReadText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export async function removeDir(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
}
