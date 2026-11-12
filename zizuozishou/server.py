#!/usr/bin/env python3
"""《自作自受》本地服务：托管静态页面，并把 /api/chat 转发给 OpenAI 兼容接口（默认阿里云百炼 qwen3-4b）。

API Key 只在服务端读取（环境变量或同目录 .env），不会下发到浏览器。

  python3 server.py            # 默认 http://127.0.0.1:8770
  python3 server.py --port 9000
"""
import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))


def load_env():
    path = os.path.join(ROOT, '.env')
    if not os.path.exists(path):
        return
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
API_KEY = os.environ.get('DASHSCOPE_API_KEY') or os.environ.get('LLM_API_KEY', '')
BASE_URL = os.environ.get('LLM_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').rstrip('/')
MODEL = os.environ.get('LLM_MODEL', 'qwen3-4b')
TIMEOUT = float(os.environ.get('LLM_TIMEOUT', '45'))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if self.path.startswith('/api/'):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/status':
            return self.send_json(200, {'online': bool(API_KEY), 'model': MODEL})
        if '.env' in urllib.parse.unquote(self.path):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        if self.path != '/api/chat':
            return self.send_error(404)
        if not API_KEY:
            return self.send_json(503, {'error': '服务端未配置 API Key'})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        except ValueError:
            return self.send_json(400, {'error': '请求体不是 JSON'})

        payload = {
            'model': MODEL,
            'messages': req.get('messages', []),
            'temperature': float(req.get('temperature', 0)),
            'max_tokens': min(int(req.get('max_tokens', 150)), 800),
            'stream': False,
            'enable_thinking': False,
        }
        upstream = urllib.request.Request(
            BASE_URL + '/chat/completions',
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY},
            method='POST',
        )
        t0 = time.time()
        try:
            with urllib.request.urlopen(upstream, timeout=TIMEOUT) as resp:
                data = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            return self.send_json(502, {'error': 'HTTP %d: %s' % (e.code, e.read().decode('utf-8', 'replace')[:300])})
        except Exception as e:  # noqa: BLE001
            return self.send_json(502, {'error': str(e)})

        content = ((data.get('choices') or [{}])[0].get('message') or {}).get('content', '')
        self.send_json(200, {
            'content': content,
            'usage': data.get('usage'),
            'latency_ms': int((time.time() - t0) * 1000),
        })


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8770)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    mode = '在线（%s）' % MODEL if API_KEY else '离线规则模式（未找到 DASHSCOPE_API_KEY）'
    print('《自作自受》 http://%s:%d  ·  %s' % (args.host, args.port, mode))
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
