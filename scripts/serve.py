#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JLPT 練習 — 開發用靜態伺服器

比 `python -m http.server` 更適合本專案：
  - 多執行緒，避免瀏覽器並發請求時在 Windows 出現 ERR_NO_BUFFER_SPACE
  - 正確的 MIME 類型（.js / .json / .webmanifest）
  - 關閉快取，方便開發時即時看到修改

用法：
    python scripts/serve.py            # http://localhost:5173
    python scripts/serve.py 8000       # 指定埠號
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".css": "text/css",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只顯示錯誤，保持輸出乾淨
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)


def main():
    handler = partial(Handler, directory=str(ROOT))
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    print(f"JLPT 練習 開發伺服器： http://localhost:{PORT}/")
    print(f"根目錄： {ROOT}")
    print("按 Ctrl+C 結束。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        httpd.server_close()


if __name__ == "__main__":
    main()
