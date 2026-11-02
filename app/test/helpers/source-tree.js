import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function readSourceTree(rootUrl, extension = ".js") {
  const root = fileURLToPath(rootUrl);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(target);
    }
  };
  visit(root);
  files.sort();
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}
