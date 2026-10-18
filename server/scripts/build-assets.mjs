// 把仓库根目录的静态游戏文件拷贝到 server/public/，供 Worker 静态资源托管。
// 保持根目录文件不动，这样旧的 GitHub Pages 站点在迁移完成前仍可用。
import { mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const outDir = resolve(here, '..', 'public');

const FILES = ['index.html', 'three.min.js'];

mkdirSync(outDir, { recursive: true });
for (const name of FILES) {
  const src = join(repoRoot, name);
  try {
    statSync(src);
  } catch {
    console.warn(`[build-assets] 跳过缺失文件: ${name}`);
    continue;
  }
  copyFileSync(src, join(outDir, name));
  console.log(`[build-assets] ${name} -> public/${name}`);
}
console.log(`[build-assets] 完成，输出目录: ${outDir}`);
