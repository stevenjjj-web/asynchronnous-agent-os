import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

function assertWithin(root, target) {
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('Path escapes the authorized root');
  }
}

function assertPlainName(name) {
  if (!name || name === '.' || name === '..' || name.includes('\0') || name.includes(sep)) {
    throw new Error('Invalid path component');
  }
}

export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Secure directory is invalid: ${path}`);
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
  return realpathSync(path);
}

export function assertSecureRegularFile(path, { allowMissing = false, requirePrivate = true } = {}) {
  if (!existsSync(path)) {
    if (allowMissing) return null;
    throw new Error(`Required file does not exist: ${path}`);
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Secure file must be a regular file: ${path}`);
  if (requirePrivate && process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(`Secure file permissions are too broad: ${path} (expected mode 0600)`);
  }
  return stats;
}

export function resolveWithinRoot(rootPath, requested = '.', { createParents = false } = {}) {
  if (typeof requested !== 'string' || requested.length > 4_096 || requested.includes('\0') || isAbsolute(requested)) {
    throw new Error('Workspace path must be a relative path');
  }
  const root = realpathSync(resolve(rootPath));
  const lexical = resolve(root, requested);
  assertWithin(root, lexical);
  const relativePath = relative(root, lexical);
  const parts = relativePath ? relativePath.split(sep) : [];
  let current = root;
  const parentParts = parts.slice(0, -1);
  for (const part of parentParts) {
    assertPlainName(part);
    const candidate = resolve(current, part);
    if (!existsSync(candidate)) {
      if (!createParents) throw new Error(`Path does not exist: ${requested}`);
      mkdirSync(candidate, { mode: 0o700 });
    }
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) throw new Error('Symbolic links are not allowed in workspace paths');
    if (!stats.isDirectory()) throw new Error(`Path component is not a directory: ${part}`);
    current = realpathSync(candidate);
    assertWithin(root, current);
  }
  if (!parts.length) return root;
  const finalName = parts.at(-1);
  assertPlainName(finalName);
  const target = resolve(current, finalName);
  assertWithin(root, target);
  if (existsSync(target)) {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) throw new Error('Symbolic links are not allowed in workspace paths');
    assertWithin(root, realpathSync(target));
  } else if (!createParents) {
    throw new Error(`Path does not exist: ${requested}`);
  }
  return target;
}

export function readPrivateTextFile(path, { maxBytes = 1_000_000 } = {}) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Refusing to read a non-regular file: ${path}`);
  if (stats.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte read limit`);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`Refusing to read a non-regular file: ${path}`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function atomicWritePrivateFile(path, content, { mode = 0o600, privateDirectory = true } = {}) {
  const parentPath = dirname(path);
  const parent = privateDirectory ? ensurePrivateDirectory(parentPath) : realpathSync(parentPath);
  if (!privateDirectory && parent !== resolve(parentPath)) throw new Error(`Symbolic links are not allowed in secure parent paths: ${parentPath}`);
  const parentStats = lstatSync(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) throw new Error(`Secure parent directory is invalid: ${parentPath}`);
  const target = resolve(parent, basename(path));
  const temporary = resolve(parent, `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    chmodSync(target, mode);
    const directoryFd = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return target;
}

export function atomicWriteWithinRoot(root, requested, content, options = {}) {
  const target = resolveWithinRoot(root, requested, { createParents: true });
  return atomicWritePrivateFile(target, content, options);
}

export function appendPrivateFile(path, content, { mode = 0o600 } = {}) {
  ensurePrivateDirectory(dirname(path));
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, mode);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`Refusing to append to a non-regular file: ${path}`);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    chmodSync(path, mode);
  } finally {
    closeSync(fd);
  }
  return path;
}

export function ensureDirectoryWithinRoot(rootPath, requested = '.') {
  if (typeof requested !== 'string' || requested.length > 4_096 || requested.includes('\0') || isAbsolute(requested)) {
    throw new Error('Workspace path must be a relative path');
  }
  const root = realpathSync(resolve(rootPath));
  const lexical = resolve(root, requested);
  assertWithin(root, lexical);
  const parts = relative(root, lexical).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    assertPlainName(part);
    const candidate = resolve(current, part);
    if (!existsSync(candidate)) mkdirSync(candidate, { mode: 0o700 });
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('Workspace directory path contains an unsafe component');
    }
    if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700) chmodSync(candidate, 0o700);
    current = realpathSync(candidate);
    assertWithin(root, current);
  }
  return current;
}
