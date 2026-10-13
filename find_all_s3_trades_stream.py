import subprocess, os, json, tarfile, io

# Jalankan aws s3 cp langsung pipe ke tarfile
cmd = ["aws", "--profile", "do-tor1", "s3", "ls", "s3://missi/crypto/profit4-chunks/", "--recursive"]
res = subprocess.run(cmd, capture_output=True, text=True)

# Ambil chunks dari run 2026-10-12T10-21-27-312Z dan 2026-10-12T17-09-10-368Z
target_runs = [
    "2026-10-12T10-21-27-312Z",
    "2026-10-12T17-09-10-368Z"
]

archives = []
for line in res.stdout.strip().split("\n"):
    parts = line.split()
    if len(parts) >= 4:
        key = parts[3]
        for tr in target_runs:
            if tr in key and key.endswith(".tar.gz"):
                archives.append((tr, key))

print(f"Targeting {len(archives)} archives from 12-13 Oktober...")

all_sells = []
all_buys = []

for idx, (trun, key) in enumerate(archives):
    fname = os.path.basename(key)
    # Stream tar.gz via curl / aws s3 cp -
    p = subprocess.Popen(["aws", "--profile", "do-tor1", "s3", "cp", f"s3://missi/{key}", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        with tarfile.open(fileobj=p.stdout, mode="r|gz") as tar:
            for entry in tar:
                if entry.name.endswith("profit4-events.jsonl"):
                    f = tar.extractfile(entry)
                    if f:
                        for line in f.read().decode("utf-8", errors="ignore").split("\n"):
                            if not line.strip(): continue
                            try:
                                ev = json.loads(line)
                                if ev.get("type") == "PAPER_SELL":
                                    ev["_chunk"] = fname
                                    all_sells.append(ev)
                                elif ev.get("type") == "PAPER_BUY":
                                    ev["_chunk"] = fname
                                    all_buys.append(ev)
                            except: pass
    except Exception as e:
        pass
    finally:
        p.terminate()

    print(f"[{idx+1}/{len(archives)}] {fname}: total buys={len(all_buys)}, total sells={len(all_sells)}")

with open("/home/bbliong/project/crypto-bot/all_s3_extracted_trades_12_13.json", "w") as out:
    json.dump({"sells": all_sells, "buys": all_buys}, out)

print("\nDone extracting!")
