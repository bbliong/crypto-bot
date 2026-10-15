import urllib.request
import json
import time

mints = [
    ('ASr6b7avDCN5eftxCm5qfcPxwhmbyag5jTsLfgdwZ5qe', 'POKEMON (from trades table 1)'),
    ('3Pa8CQVAoXvqLXvy6u82Cm8qSEdR7nESLfj3fUsMYgws', 'POKEMON (from trades table 2)'),
    ('CCh1F9nN3EC2iPdSqSpKkDTw6sSsoPdFKP8f7x3zpump', 'POKEMON (from research simulation)'),
    ('HSWu2oXd4rrFKaeA2NBkF92dGZ3Vs29v48Fke7U8Wyci', 'POKEMON (from entry gate)'),
    ('Byvrj68QWsKXaSmtuNXS1knG7TZkJBZ337PHjMYSG7M3', 'POKEMON (from paper sim)'),
    ('84MadwCmN4eGKhwyeFtHUVyMRJpC16H8fNi7XBpspump', 'PIKACAT (Pikachu Cat)'),
    ('3rP3HD1Z8eqNcVSXKkeQTbaMUq2M4e1ftM8HNXGzuSxm', 'POKEMON (from audit dashboard)'),
    ('9bLKqAAS9TPTefqLcM4n6gWSuhuaKsJZkbszRJKmpump', 'POKENALD'),
    ('4tA9WCPMdD7eNZCUSCTdUYqoockxhkfEejPRdsnapump', 'Happy Pikachu')
]

for mint, label in mints:
    url = f'https://api.dexscreener.com/latest/dex/tokens/{mint}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            pairs = data.get('pairs') or []
            if pairs:
                p = pairs[0]
                base = p.get('baseToken', {})
                print(f"[FOUND] {label} | Mint: {mint}")
                print(f"   Name: {base.get('name')} ({base.get('symbol')})")
                print(f"   Price: ${p.get('priceUsd')} | MC: ${p.get('marketCap') or p.get('fdv')} | Liq: ${p.get('liquidity', {}).get('usd')}")
                print(f"   URL: {p.get('url')}")
            else:
                print(f"[NO PAIR] {label} | Mint: {mint}")
    except Exception as e:
        print(f"[ERR] {label}: {e}")
    time.sleep(0.5)
