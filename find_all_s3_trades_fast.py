import subprocess, os, json, tarfile, tempfile, shutil

cmd = ["aws", "--profile", "do-tor1", "s3", "ls", "s3://missi/crypto/profit4-chunks/", "--recursive"]
res = subprocess.run(cmd, capture_output=True, text=True)

target_runs = [
    "2026-10-11T00-55-41-396Z",
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

print(f"Total target archives: {len(archives)}")

all_sells = []
all_buys = []
all_transfers = []

tmp_dir = tempfile.mkdtemp(prefix="s3_inspect_")

try:
    for idx, (trun, key) in enumerate(archives):
        filename = os.path.basename(key)
        # Ekstrak hanya file profit4-events.jsonl dan transfers.jsonl tanpa download seluruh tar jika mungkin,
        # atau download tar ke tmp lalu baca file kecilnya
        local_tar = os.path.join(tmp_dir, filename)
        dl = subprocess.run(["aws", "--profile", "do-tor1", "s3", "cp", f"s3://missi/{key}", local_tar], capture_output=True)
        if dl.returncode != 0:
            continue
        
        try:
            with tarfile.open(local_tar, "r:gz") as tar:
                for member in tar.getmembers():
                    if member.name.endswith("profit4-events.jsonl"):
                        f = tar.extractfile(member)
                        if f:
                            for line in f.read().decode("utf-8", errors="ignore").split("\n"):
                                if not line.strip(): continue
                                try:
                                    ev = json.loads(line)
                                    if ev.get("type") == "PAPER_SELL":
                                        ev["_run"] = trun
                                        ev["_chunk"] = filename
                                        all_sells.append(ev)
                                    elif ev.get("type") == "PAPER_BUY":
                                        ev["_run"] = trun
                                        ev["_chunk"] = filename
                                        all_buys.append(ev)
                                except: pass
                    elif member.name.endswith("transfers.jsonl"):
                        f = tar.extractfile(member)
                        if f:
                            for line in f.read().decode("utf-8", errors="ignore").split("\n"):
                                if not line.strip(): continue
                                try:
                                    ev = json.loads(line)
                                    if ev.get("mint"):
                                        all_transfers.append(ev)
                                except: pass
        except Exception as e:
            pass
        finally:
            if os.path.exists(local_tar):
                os.remove(local_tar)
        
        if (idx + 1) % 10 == 0 or idx == len(archives) - 1:
            print(f"Processed {idx+1}/{len(archives)} archives... Found {len(all_buys)} buys, {len(all_sells)} sells, {len(all_transfers)} transfers")

finally:
    shutil.rmtree(tmp_dir)

print("\n" + "="*50)
print(f"TOTAL DATA ACROSS ALL RUNS (11-13 OKTOBER 2026):")
print(f"Transfers: {len(all_transfers)}")
print(f"Buys: {len(all_buys)}")
print(f"Sells: {len(all_sells)}")

# Group sells by mint & lane
mints_traded = {}
for s in all_sells:
    m = s.get("mint")
    if m not in mints_traded: mints_traded[m] = []
    mints_traded[m].append(s)

print(f"\nUnique Tokens Traded: {len(mints_traded)}")
for m, slist in mints_traded.items():
    sym = slist[0].get("transfer", {}).get("symbol") or slist[0].get("symbol") or "N/A"
    print(f"\nToken: {sym} ({m[:6]}...) - {len(slist)} exits recorded:")
    for s in slist:
        lane = s.get("laneLabel") or s.get("paperLane")
        net = s.get("netReturnPercent", 0)
        pnl = s.get("pnlUsd", 0)
        reason = s.get("reason")
        print(f"  [{lane}] net={net:+.1f}% pnl=${pnl:+.2f} via {reason} in {s.get('_chunk')}")

# Save results for simulation analysis
with open("/home/bbliong/project/crypto-bot/all_s3_extracted_trades.json", "w") as f:
    json.dump({"sells": all_sells, "buys": all_buys, "transfers": all_transfers}, f)

print("\nSaved all extracted data to /home/bbliong/project/crypto-bot/all_s3_extracted_trades.json")
