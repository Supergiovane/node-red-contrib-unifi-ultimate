"use strict";

// Syntax-checks every runtime JavaScript file so new files are covered
// without being listed by hand in package.json.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIRECTORIES = ["nodes", "resources", "scripts"];

function collectJavaScriptFiles(directory) {
    if (!fs.existsSync(directory)) {
        return [];
    }
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return collectJavaScriptFiles(entryPath);
        }
        return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
    });
}

const files = DIRECTORIES.flatMap((directory) => collectJavaScriptFiles(path.join(ROOT, directory))).sort();
let failed = 0;

files.forEach((file) => {
    try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (error) {
        failed += 1;
        process.stderr.write(`${path.relative(ROOT, file)}\n${error.stderr ? error.stderr.toString() : error.message}\n`);
    }
});

if (failed > 0) {
    process.stderr.write(`Syntax check failed for ${failed} of ${files.length} files.\n`);
    process.exit(1);
}
process.stdout.write(`Syntax check passed for ${files.length} files.\n`);
