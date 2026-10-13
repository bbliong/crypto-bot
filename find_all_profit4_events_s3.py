import subprocess, os, json, tarfile, tempfile

# Kumpulkan semua tar.gz key dari bucket
cmd = ["aws", "--profile", "do-tor1", "s3", "ls", "s3://missi/crypto/profit4-chunks/", "--recursive"]
res = subprocess.run(cmd, capture_output=True, text=True)

archives = []
for line in res.stdout.strip().split("\n"):
    parts = line.split()
    if len(parts) >= 4 and parts[3].endswith(".tar.gz"):
        archives.append(parts[3])

print(f"Total archives in S3: {len(archives)}")

all_trades = []
# Ekstrak paralel atau satu per satu menggunakan tarfile langsung membaca profit4-events.jsonl
# Kita gunakan tar -zxvf via stdout untuk kecepatan
for idx, key in enumerate(archives):
    # Jalankan aws s3 cp s3://missi/key - | tar -ztf -
    # Ekstrak hanya profit4-events.jsonl
    p_dl = subprocess.Popen(["aws", "--profile", "do-tor1", "s3", "cp", f"s3://missi/{key}", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    p_tar = subprocess.Popen(["tar", "-zx", "--wildcards", "*profit4-events.jsonl", "-O"], stdin=p_dl.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    out, _ = p_tar.communicate()
    p_dl.wait()
    
    if out:
        lines = out.decode("utf-8", errors="ignore").strip().split("\n")
        for l in lines:
            if not l.strip(): continue
            try:
                ev = json.loads(l)
                if ev.get("type") == "PAPER_SELL":
                    ev["_s3_key"] = key
                    all_trades.append(ev)
            except: pass

    if (idx + 1) % 20 == 0 or idx == len(archives) - 1:
        print(f"[{idx+1}/{len(archives)}] Processed... Total PAPER_SELL found: {len(all_trades)}")

with open("/home/bbliong/project/crypto-bot/all_lifetime_paper_sells.json", "w") as f:
    json.dump(all_trades, f)

print(f"\nCompleted! Found {len(all_trades)} total PAPER_SELL events across entire history.")
