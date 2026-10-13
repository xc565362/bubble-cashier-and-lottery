import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const publicRoot=path.join(root,'public'),dist=path.join(root,'dist');
await fs.mkdir(dist,{recursive:true});
const manifest=[];
async function copyDir(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const source=path.join(dir,entry.name),relative=path.relative(publicRoot,source);if(entry.isDirectory()){await copyDir(source);continue;}if(relative==='preview.mjs')continue;const target=path.join(dist,relative);await fs.mkdir(path.dirname(target),{recursive:true});const bytes=await fs.readFile(source);await fs.writeFile(target,bytes);manifest.push({path:relative.replaceAll('\\','/'),sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}}
await copyDir(publicRoot);
// A previous local build must never leave an interactive demo in the upload directory.
await fs.rm(path.join(dist,'preview.mjs'),{force:true});
await fs.writeFile(path.join(dist,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(`Built ${manifest.length} files. Production API remains disabled until runtime-config.js is configured. No cloud deployment was performed.`);
