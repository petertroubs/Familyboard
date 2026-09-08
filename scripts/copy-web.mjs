// Copie les fichiers statiques de l'interface dans dist/ après compilation.
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'web');
const target = path.join(root, 'dist', 'web');

await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
console.info(`Interface copiée dans ${path.relative(root, target)}`);
