# Analisa Lengkap GMGN Filter Query Map (pi-modal)

File ini merangkum *reverse-engineering* terhadap `filter_query_map` milik GMGN.ai yang digunakan pada localStorage. Parameter ini sangat penting jika Anda ingin melakukan injeksi filter cepat untuk trading (terutama menggunakan *pi-modal* atau script sniper).

## 1. Sistem Prefix (Tab Waktu / Timeframe)
Di halaman **Trenches**, GMGN membagi filter berdasarkan tab waktu rilis koin. Prefix angka di depan variabel menunjukkan tab mana filter tersebut diterapkan:
- **Prefix `2`** = Tab **1m** (Koin baru rilis 1 menit terakhir).
- **Prefix `3`** = Tab **5m** (Koin baru rilis 5 menit).
- **Prefix `4`** = Tab **1h** (atau 15m/timeframe yang lebih panjang).
- **Prefix `0`** = Tab **Trending** (bukan Trenches).

*(Contoh: `4pf` berarti filter platform Pump.fun yang diterapkan pada tab Trenches 1h).*

---

## 2. Parameter Platform / DEX (Toggles)
Value dari parameter ini adalah `"1"` (Aktif) atau `"0"` / tidak ada (Nonaktif).

| Parameter | Platform / DEX | Rekomendasi (Trading Cepat) |
| :--- | :--- | :--- |
| `pf`, `pm` | **Pump.fun** | ✅ **Centang** (Wajib, likuiditas tertinggi saat ini) |
| `ry` | **Raydium** | ✅ **Centang** |
| `msa` | **Moonshot** (DexScreener) | ✅ **Centang** (Banyak koin degen baru) |
| `mvc` | **Meteora** | ❌ Bebas (Sering digunakan koin serius, lambat untuk scalp) |
| `stonkfun` | **Stonk.fun** | ❌ Abaikan (Kurang populer, rentan rug) |
| `bags`, `bags_v2`| **Bags App** | ❌ Abaikan |
| `ory` | **Orca** | ❌ Bebas |
| `js` | **Jupiter** | ❌ Bebas |
| `tren_ch` | **Trenches Murni** | ✅ **Centang** (Jika ingin melihat pair kosongan) |
| `heaven`, `sugar`| Launchpad Niche (Heaven, Sugar) | ❌ Abaikan |

---

## 3. Parameter Kuantitatif & Keamanan (Wajib!)
Value dari parameter ini adalah angka (misal `"10"`, `"1000"`) atau boolean `"0"`/`"1"`.
Ini adalah filter yang **paling berguna untuk pi-modal trading** guna mencegah *rugpull*.

### A. Filter Keamanan (Security)
| Parameter | Arti Filter di UI | Kegunaan |
| :--- | :--- | :--- |
| `nwt` | **No Warning Tokens / Wash Trading** | Menghilangkan koin yang di-flag "Warning" oleh sistem GMGN. |
| `nsi` | **No Social Info** | *Toggle* untuk menghilangkan koin tanpa sosial media. |
| `hs` | **Has Socials** | Memaksa hanya menampilkan koin dengan link Twitter/Web. |
| `cc` | **Contract Checked / Mint Disabled** | Koin yang dev-nya tidak bisa *mint* / mencetak token baru. |
| `ch` | **Top 10 Holders < 30%** | Mencegah dev atau sniper memegang porsi terlalu besar (Anti-dump). |

### B. Filter Metrik Finansial
*Singkatan Metrik: `mi` (Min) dan `ma` (Max).*

| Parameter | Arti Filter di UI | Format Value |
| :--- | :--- | :--- |
| `mic` / `mac` | **Min / Max Market Cap** | Angka absolut (Mcap). |
| `mil` / `mal` | **Min / Max Liquidity** | Angka absolut (USD). |
| `mihc` / `mahc` | **Min / Max Holder Count** | Jumlah *wallet* pemegang koin. |
| `miv24h` / `mav24h`| **Min / Max Volume 24h** | Volume transaksi dalam 24 jam. |
| `min24h` / `mxnb24h`| **Min / Max Tx (Transactions)** | Jumlah total transaksi jual-beli. |
| `mib24h` / `mab24h`| **Min / Max Buys (24h)** | Jumlah tekanan beli. |
| `mis24h` / `mas24h`| **Min / Max Sells (24h)** | Jumlah tekanan jual. |

---

## 💡 Rekomendasi Setup Injeksi Payload untuk Pi-Modal
Jika Anda ingin langsung meng-injeksi filter aman ke localStorage agar tidak perlu menyentuh UI sama sekali, gunakan format berikut (Asumsi untuk tab **1m** / Trenches Cepat):

```json
{
  "2pf": "1",          // Pump.fun On
  "2ry": "1",          // Raydium On
  "2msa": "1",         // Moonshot On
  "2hs": "1",          // Wajib Punya Socials
  "2nwt": "1",         // Hindari Token Warning/Scam
  "2ch": "1",          // Top 10 Holders < 30%
  "2cc": "1",          // Mint/Freeze Disabled (Aman)
  "2mihc": "10",       // Minimal 10 Holders (Ada interaksi nyata)
  "2mil": "5000"       // Minimal Likuiditas $5000 (Mencegah slip page tinggi)
}
```
Anda tinggal me-*replace* atau melakukan `Object.assign` ke key `"trenches2_sol"` di dalam `filter_query_map`.
