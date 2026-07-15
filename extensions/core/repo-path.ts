import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type SafeRepoFile = {
  absolutePath: string;
  size: number;
  mtimeMs: number;
};

export function pathIsInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function safeRepoFile(root: string, repoPath: string): SafeRepoFile | undefined {
  if (!repoPath || isAbsolute(repoPath)) return undefined;
  const absolutePath = resolve(root, repoPath);
  if (!pathIsInside(root, absolutePath)) return undefined;
  try {
    const lexical = lstatSync(absolutePath);
    if (lexical.isSymbolicLink() || !lexical.isFile()) return undefined;
    const realRoot = realpathSync(root);
    const realFile = realpathSync(absolutePath);
    if (!pathIsInside(realRoot, realFile)) return undefined;
    const stat = lstatSync(realFile);
    return { absolutePath: realFile, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}
