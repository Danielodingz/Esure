#!/usr/bin/env node
/**
 * Offline Markdown link and anchor validator.
 * Validates relative paths and GitHub-style heading anchors in Markdown files.
 * Reports the source file and broken target with a nonzero exit on failure.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const docsDir = resolve(repoRoot, "..", "esure-docs");

// Track all Markdown files and their headings
const headingsByFile = new Map();
let errorCount = 0;

function normalizeHeading(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractHeadings(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const headings = new Set();
    const headingRegex = /^#+\s+(.+)$/gm;
    let match;
    while ((match = headingRegex.exec(content)) !== null) {
      const normalized = normalizeHeading(match[1]);
      headings.add(normalized);
    }
    return headings;
  } catch {
    return new Set();
  }
}

function resolveMarkdownPath(link, fromFile) {
  const fromDir = dirname(fromFile);
  const [pathPart, anchor] = link.split("#");

  let targetPath = pathPart ? resolve(fromDir, pathPart) : fromFile;

  if (!pathPart || pathPart.endsWith("/")) {
    targetPath = resolve(targetPath, "README.md");
  } else if (!targetPath.endsWith(".md")) {
    targetPath += ".md";
  }

  return [targetPath, anchor || null];
}

function validateLink(link, sourceFile, sourceLine) {
  // Skip external URLs
  if (link.startsWith("http://") || link.startsWith("https://") || link.startsWith("mailto:")) {
    return true;
  }

  // Skip relative references that go outside docs
  if (link.startsWith("..")) {
    return true;
  }

  const [targetPath, anchor] = resolveMarkdownPath(link, sourceFile);

  // Check if target file exists
  if (!existsSync(targetPath)) {
    console.error(
      `✗ Broken link in ${sourceFile}:${sourceLine}\n  Link: ${link}\n  Target not found: ${targetPath}`
    );
    errorCount++;
    return false;
  }

  // Check if anchor exists in target file
  if (anchor) {
    const headings = headingsByFile.get(targetPath) || new Set();
    if (!headings.has(anchor)) {
      console.error(
        `✗ Broken anchor in ${sourceFile}:${sourceLine}\n  Link: ${link}\n  Anchor not found in ${basename(targetPath)}: #${anchor}`
      );
      errorCount++;
      return false;
    }
  }

  return true;
}

function validateFile(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    // Find Markdown links: [text](url) or [text][ref]
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    let lineNum = 0;
    let lineBuffer = "";

    for (const line of lines) {
      lineNum++;
      lineBuffer += line + "\n";

      while ((match = linkRegex.exec(line)) !== null) {
        const link = match[2];
        validateLink(link, filePath, lineNum);
      }
    }
  } catch (e) {
    console.error(`Error reading ${filePath}: ${e.message}`);
    errorCount++;
  }
}

function walkDir(dir) {
  const files = readdirSync(dir);
  for (const file of files) {
    const fullPath = resolve(dir, file);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (!file.startsWith(".")) {
        walkDir(fullPath);
      }
    } else if (file.endsWith(".md")) {
      headingsByFile.set(fullPath, extractHeadings(fullPath));
    }
  }
}

// Validate all Markdown files
console.log(`Checking links in ${docsDir}...`);
walkDir(docsDir);

// Now validate each file
const files = [];
function collectFiles(dir) {
  const items = readdirSync(dir);
  for (const item of items) {
    const fullPath = resolve(dir, item);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (!item.startsWith(".")) {
        collectFiles(fullPath);
      }
    } else if (item.endsWith(".md")) {
      files.push(fullPath);
    }
  }
}

collectFiles(docsDir);
files.forEach(validateFile);

// Also check README.md at root
const readmePath = resolve(repoRoot, "..", "README.md");
if (existsSync(readmePath)) {
  headingsByFile.set(readmePath, extractHeadings(readmePath));
  validateFile(readmePath);
}

if (errorCount === 0) {
  console.log("✓ All links and anchors are valid.");
  process.exit(0);
} else {
  console.error(`\n✗ Found ${errorCount} link validation error(s).`);
  process.exit(1);
}
