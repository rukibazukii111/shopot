"""Render the repository's waveform mark without external assets.

A near-black rounded tile with a hairline border and four white bars, matching the in-app brand mark.
Every pixel is supersampled 4x4 so edges stay smooth down to 16 px.
"""
from pathlib import Path
import math
import struct
import zlib

SAMPLES = 4
TOP, BOTTOM = (0x2a, 0x2c, 0x2f), (0x12, 0x13, 0x14)
BARS = [(9.25, 7), (13.75, 18), (18.25, 12), (22.75, 6)]  # centre x and height on a 32-unit grid, centred at y = 16


def rounded_box(px, py, cx, cy, half_w, half_h, radius):
    qx, qy = abs(px - cx) - (half_w - radius), abs(py - cy) - (half_h - radius)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - radius


def sample(x, y):
    """Colour and alpha of one point on the 32-unit grid."""
    tile = rounded_box(x, y, 16, 16, 15, 15, 7)
    if tile > 0:
        return (0, 0, 0), 0.0
    if any(rounded_box(x, y, cx, 16, 1.3, height / 2, 1.3) <= 0 for cx, height in BARS):
        return (0xf4, 0xf4, 0xf6), 1.0
    t = (y - 1) / 30
    colour = tuple(a + (b - a) * t for a, b in zip(TOP, BOTTOM))
    if tile > -0.55:  # hairline border: white at 16% over the tile
        colour = tuple(c + (255 - c) * 0.16 for c in colour)
    return colour, 1.0


def png(size):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    rows = []
    step = 32 / size
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            red = green = blue = alpha = 0.0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    colour, a = sample((px + (sx + .5) / SAMPLES) * step, (py + (sy + .5) / SAMPLES) * step)
                    red, green, blue, alpha = red + colour[0] * a, green + colour[1] * a, blue + colour[2] * a, alpha + a
            if alpha:
                row.extend((round(red / alpha), round(green / alpha), round(blue / alpha), round(alpha / SAMPLES ** 2 * 255)))
            else:
                row.extend((0, 0, 0, 0))
        rows.append(row)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')


def ico(sizes):
    images = [png(size) for size in sizes]
    offset = 6 + 16 * len(images)
    header, body = struct.pack('<HHH', 0, 1, len(images)), b''
    for size, image in zip(sizes, images):
        header += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(image), offset + len(body))
        body += image
    return header + body


folder = Path(__file__).resolve().parents[1] / 'renderer'
(folder / 'tray.png').write_bytes(png(32))
(folder / 'app-icon.png').write_bytes(png(512))
(folder / 'app-icon.ico').write_bytes(ico([16, 24, 32, 48, 64, 128, 256]))
