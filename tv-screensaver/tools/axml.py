#!/usr/bin/env python3
"""Encode a plain-text AndroidManifest.xml into Android's binary XML (AXML).

Used instead of aapt2 so the APK can be built with only a JDK. Handles what a
resource-less manifest needs: string, integer, boolean and @android:
reference attribute values. Usage: axml.py <in.xml> <out.bin>
"""
import struct
import sys
import xml.etree.ElementTree as ET

ANDROID_NS = 'http://schemas.android.com/apk/res/android'

# android.R.attr IDs (stable public framework values).
ATTR_IDS = {
    'label': 0x01010001, 'icon': 0x01010002, 'name': 0x01010003, 'permission': 0x01010006,
    'exported': 0x01010010, 'minSdkVersion': 0x0101020c, 'versionCode': 0x0101021b,
    'versionName': 0x0101021c, 'targetSdkVersion': 0x01010270, 'allowBackup': 0x01010280,
    'hardwareAccelerated': 0x010102d3, 'required': 0x0101028e,
}
# @android: references used by the manifest.
REFS = {'@android:drawable/sym_def_app_icon': 0x01080093}

TYPE_REFERENCE, TYPE_STRING, TYPE_INT_DEC, TYPE_INT_BOOLEAN = 0x01, 0x03, 0x10, 0x12
NO_INDEX = 0xFFFFFFFF


def chunk(ctype, header, body):
    return struct.pack('<HHI', ctype, 8 + len(header), 8 + len(header) + len(body)) + header + body


def main(src, dst):
    root = ET.parse(src).getroot()

    # Attribute names with resource IDs must come first in the pool, in the
    # same order as the resource map.
    android_names = []
    for el in root.iter():
        for k in el.attrib:
            if k.startswith('{%s}' % ANDROID_NS):
                n = k.split('}')[1]
                if n not in ATTR_IDS:
                    sys.exit('unknown android attribute: ' + n)
                if n not in android_names:
                    android_names.append(n)
    strings = list(android_names)

    def idx(s):
        if s not in strings:
            strings.append(s)
        return strings.index(s)

    idx('android'); idx(ANDROID_NS)
    nodes = []  # flattened (event, payload)

    def walk(el):
        attrs = []
        for k, v in el.attrib.items():
            if k.startswith('{'):
                ns, n = k[1:].split('}')
                rid = ATTR_IDS[n]
            else:
                ns, n, rid = None, k, 0
            if v in ('true', 'false'):
                raw, typ, data = NO_INDEX, TYPE_INT_BOOLEAN, 0xFFFFFFFF if v == 'true' else 0
            elif v.lstrip('-').isdigit():
                raw, typ, data = NO_INDEX, TYPE_INT_DEC, int(v) & 0xFFFFFFFF
            elif v.startswith('@android:'):
                raw, typ, data = NO_INDEX, TYPE_REFERENCE, REFS[v]
            else:
                raw = idx(v)
                typ, data = TYPE_STRING, raw
            attrs.append((rid, idx(ns) if ns else NO_INDEX, idx(n), raw, typ, data))
        attrs.sort(key=lambda a: (a[0] == 0, a[0]))
        nodes.append(('start', idx(el.tag), attrs))
        for child in el:
            walk(child)
        nodes.append(('end', idx(el.tag), None))

    walk(root)

    # String pool (UTF-16).
    offsets, data = b'', b''
    for s in strings:
        u = s.encode('utf-16-le')
        offsets += struct.pack('<I', len(data))
        data += struct.pack('<H', len(u) // 2) + u + b'\0\0'
    while len(data) % 4:
        data += b'\0'
    header = struct.pack('<IIIII', len(strings), 0, 0, 28 + len(offsets), 0)
    pool = chunk(0x0001, header, offsets + data)

    resmap = chunk(0x0180, b'', b''.join(struct.pack('<I', ATTR_IDS[n]) for n in android_names))

    line = struct.pack('<II', 1, NO_INDEX)
    body = chunk(0x0100, line, struct.pack('<II', idx('android'), idx(ANDROID_NS)))
    for ev, name, attrs in nodes:
        if ev == 'start':
            ext = struct.pack('<IIHHHHHH', NO_INDEX, name, 0x14, 0x14, len(attrs), 0, 0, 0)
            for rid, ns, n, raw, typ, d in attrs:
                ext += struct.pack('<IIIHBBI', ns, n, raw, 8, 0, typ, d)
            body += chunk(0x0102, line, ext)
        else:
            body += chunk(0x0103, line, struct.pack('<II', NO_INDEX, name))
    body += chunk(0x0101, line, struct.pack('<II', idx('android'), idx(ANDROID_NS)))

    with open(dst, 'wb') as f:
        f.write(chunk(0x0003, b'', pool + resmap + body))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
