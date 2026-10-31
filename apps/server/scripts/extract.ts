import fs from "node:fs";
import path from "node:path";
import { ACCEPTED_FILE_TYPES } from "@studdy/shared";
import { extractText } from "../src/extraction/index.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run extract -- <file.pdf|.html|.md>");
  process.exit(2);
}

// npm runs workspace scripts from apps/server; resolve the argument against where it was typed.
const filePath = path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
const type = ACCEPTED_FILE_TYPES[path.extname(file).toLowerCase()];
if (!type) {
  console.error(`Unsupported file type: ${file}`);
  process.exit(2);
}

const { text, pageCount } = await extractText(type.kind, type.mime, fs.readFileSync(filePath));
process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
console.error(`[${text.length} characters${pageCount === null ? "" : `, ${pageCount} pages`}]`);
