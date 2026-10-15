import math, struct, os
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'audio.wav')
sr = 44100
dur = 8.0
n = int(sr * dur)
frames = bytearray()
for i in range(n):
    t = i / sr
    v = 0.0
    # beeps at 1.0/1.5/2.0/3.0/4.0/6.0/7.0 s
    for b in (1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 7.0):
        if b <= t < b + 0.35:
            v += 0.35 * math.sin(2 * math.pi * 880 * (t - b))
    if 4.0 <= t < 5.0:
        v += 0.2 * math.sin(2 * math.pi * 440 * (t - 4.0))
    v = max(-0.9, min(0.9, v))
    frames += struct.pack('<h', int(v * 32767))
with open(out, 'wb') as f:
    f.write(b'RIFF')
    f.write(struct.pack('<I', 36 + len(frames)))
    f.write(b'WAVEfmt ')
    f.write(struct.pack('<IHHIIHH', 16, 1, 1, sr, sr * 2, 2, 16))
    f.write(b'data')
    f.write(struct.pack('<I', len(frames)))
    f.write(frames)
print('sample wav', out, os.path.getsize(out))
