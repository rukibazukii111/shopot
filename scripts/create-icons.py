"""Render the repository's simple waveform mark without external assets."""
from pathlib import Path
import struct
import zlib


def png(size):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            nx, ny = (x + .5) * 32 / size, (y + .5) * 32 / size
            dx, dy = max(0, abs(nx - 16) - 7), max(0, abs(ny - 16) - 7)
            inside = dx * dx + dy * dy <= 81
            white = any(abs(nx - cx) <= 1.3 and abs(ny - 16) <= height / 2 for cx, height in [(8, 7), (13, 18), (18, 12), (23, 6)])
            row.extend((255, 255, 255, 255) if white else (116, 101, 216, 255 if inside else 0))
        rows.append(row)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')


folder = Path(__file__).resolve().parents[1] / 'renderer'
(folder / 'tray.png').write_bytes(png(32))
(folder / 'app-icon.png').write_bytes(png(512))
image = png(256)
(folder / 'app-icon.ico').write_bytes(struct.pack('<HHH', 0, 1, 1) + struct.pack('<BBBBHHII', 0, 0, 0, 0, 1, 32, len(image), 22) + image)
