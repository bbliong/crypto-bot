import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import readline from "readline";

const TARGET_FILE = "data/profit4-watch/historical_target_trades.json";
const CACHE_DIR = "data/profit4-watch/cached-mints";
const PROCESSED_FILE = path.join(CACHE_DIR, "processed_archives.txt");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const targets = JSON.parse(fs.readFileSync(TARGET_FILE, "utf-8"));
const targetMints = new Set(targets.map(t => t.mint));

const processedArchives = new Set(
  fs.existsSync(PROCESSED_FILE)
    ? fs.readFileSync(PROCESSED_FILE, "utf-8").split("\n").filter(Boolean)
    : []
);

async function getS3Archives() {
  return new Promise((resolve, reject) => {
    const p = spawn("aws", ["--profile", "do-tor1", "s3", "ls", "s3://missi/crypto/profit4-chunks/", "--recursive"]);
    let out = "";
    p.stdout.on("data", d => out += d.toString());
    p.on("close", code => {
      if (code !== 0) return reject(new Error("AWS error"));
      const lines = out.trim().split("\n");
      const list = [];
      const relevantRuns = ["2026-10-11T00-55-41-396Z", "2026-10-12T10-21-27-312Z", "2026-10-12T17-09-10-368Z"];
      for (const l of lines) {
        const parts = l.trim().split(/\s+/);
        if (parts.length >= 4 && parts[3].endsWith(".tar.gz")) {
          const key = parts[3];
          if (relevantRuns.some(r => key.includes(r))) {
            if (!processedArchives.has(key)) list.push(key);
          }
        }
      }
      resolve(list);
    });
  });
}

function streamChunk(key) {
  return new Promise(res => {
    const aws = spawn("aws", ["--profile", "do-tor1", "s3", "cp", `s3://missi/${key}`, "-"]);
    const tar = spawn("tar", ["-zx", "--wildcards", "*token-trades.jsonl", "-O"]);
    aws.stdout.on("error", () => {});
    tar.stdin.on("error", () => {});
    tar.stdout.on("error", () => {});
    aws.stdout.pipe(tar.stdin);
    const rl = readline.createInterface({ input: tar.stdout });
    const collected = [];
    rl.on("line", line => {
      if (!line) return;
      try {
        const r = JSON.parse(line);
        if (r.mint && targetMints.has(r.mint)) collected.push(r);
      } catch (e) {}
    });
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { aws.kill(); } catch (e) {}
        try { tar.kill(); } catch (e) {}
        res(collected);
      }
    }, 15000);
    tar.on("close", () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        try { aws.kill(); } catch (e) {}
        res(collected);
      }
    });
    aws.on("error", () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        res([]);
      }
    });
    tar.on("error", () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        res([]);
      }
    });
  });
}

async function main() {
  const archives = await getS3Archives();
  console.log(`Archives remaining to extract: ${archives.length} (Already processed: ${processedArchives.size})`);

  if (archives.length === 0) {
    console.log("All archives already extracted to local cache!");
    return;
  }

  const CONCURRENCY = 10;
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (cursor < archives.length) {
      const idx = cursor++;
      const arc = archives[idx];
      const rows = await streamChunk(arc);
      
      // Append rows to per-mint files immediately
      const byMint = new Map();
      for (const r of rows) {
        if (!byMint.has(r.mint)) byMint.set(r.mint, []);
        byMint.get(r.mint).push(JSON.stringify(r));
      }
      for (const [mint, lines] of byMint.entries()) {
        fs.appendFileSync(path.join(CACHE_DIR, `${mint}.jsonl`), lines.join("\n") + "\n");
      }

      fs.appendFileSync(PROCESSED_FILE, arc + "\n");
      completed++;
      if (completed % 10 === 0 || completed === archives.length) {
        console.log(`[${completed}/${archives.length}] archives cached locally...`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log("Caching complete! All trades are stored on local disk.");
}

main().catch(console.error);
