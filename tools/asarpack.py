"""Pack a directory into an Electron asar (with per-file SHA256 integrity like @electron/asar)."""
import sys, os, json, struct, hashlib
BLOCK = 4 * 1024 * 1024
def integrity(data):
    blocks = [hashlib.sha256(data[i:i+BLOCK]).hexdigest() for i in range(0, max(len(data),1), BLOCK)] if data else [hashlib.sha256(b'').hexdigest()]
    return {"algorithm": "SHA256", "hash": hashlib.sha256(data).hexdigest(), "blockSize": BLOCK, "blocks": blocks}
def build(src, out):
    chunks = []; offset = 0
    def walk(d):
        nonlocal offset
        node = {"files": {}}
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name)
            if os.path.isdir(p): node["files"][name] = walk(p)
            else:
                data = open(p, 'rb').read()
                node["files"][name] = {"size": len(data), "offset": str(offset), "integrity": integrity(data)}
                chunks.append(data); offset += len(data)
        return node
    header = json.dumps(walk(src), separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    pad = (4 - len(header) % 4) % 4
    payload = struct.pack('<I', len(header)) + header + b'\0' * pad
    header_pickle = struct.pack('<I', len(payload)) + payload
    with open(out, 'wb') as f:
        f.write(struct.pack('<II', 4, len(header_pickle)))
        f.write(header_pickle)
        for c in chunks: f.write(c)
if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
