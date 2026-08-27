const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_RESULTS = 200;

function searchFile(filePath, regex, maxResults, results, root) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
    const line = lines[index];
    regex.lastIndex = 0;
    const matches = [...line.matchAll(regex)].map((match) => match[0]);
    if (matches.length) {
      results.push({
        file: path.relative(root, filePath),
        line: index + 1,
        text: line,
        matches,
      });
    }
  }
}

function searchFiles(filePaths, { pattern, glob, flags = '', maxResults = DEFAULT_MAX_RESULTS } = {}, root = process.cwd()) {
  if (typeof pattern !== 'string' || !pattern) throw new Error('pattern is required');
  if (typeof glob !== 'string' || !glob) throw new Error('glob is required');

  const normalizedFlags = flags.includes('g') ? flags : `${flags}g`;
  let regex;
  try {
    regex = new RegExp(pattern, normalizedFlags);
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error.message}`);
  }

  const limit = Math.max(1, Math.min(Number(maxResults) || DEFAULT_MAX_RESULTS, 1000));
  const results = [];

  for (const filePath of filePaths) {
    if (results.length >= limit) break;
    searchFile(filePath, regex, limit, results, root);
  }

  return {
    pattern,
    glob,
    flags: normalizedFlags.replace('g', ''),
    filesScanned: filePaths.length,
    resultCount: results.length,
    results,
  };
}

module.exports = { searchFiles, searchFile };