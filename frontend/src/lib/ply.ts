/**
 * Minimal PLY parser: extracts vertex positions (x, y, z) and optional
 * colours (red, green, blue / r, g, b / diffuse_*) from ASCII or binary PLY.
 * Used for the sparse point-cloud preview; not a general-purpose loader.
 */

export interface PointCloud {
  count: number;
  positions: Float32Array; // xyz interleaved
  colors: Float32Array | null; // rgb interleaved, 0..1
}

type PlyScalar = 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double' | 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

interface Property {
  name: string;
  type: PlyScalar;
  list?: { countType: PlyScalar; itemType: PlyScalar };
}

interface Element {
  name: string;
  count: number;
  properties: Property[];
}

interface Header {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  elements: Element[];
  headerLength: number;
}

const SIZES: Record<PlyScalar, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

function readScalar(view: DataView, offset: number, type: PlyScalar, little: boolean): number {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, little);
    case 'ushort': case 'uint16': return view.getUint16(offset, little);
    case 'int': case 'int32': return view.getInt32(offset, little);
    case 'uint': case 'uint32': return view.getUint32(offset, little);
    case 'float': case 'float32': return view.getFloat32(offset, little);
    case 'double': case 'float64': return view.getFloat64(offset, little);
  }
}

export function parsePlyHeader(buffer: ArrayBuffer): Header {
  const bytes = new Uint8Array(buffer);
  // Find "end_header" followed by newline.
  const marker = 'end_header';
  const limit = Math.min(bytes.length, 64 * 1024);
  const headText = new TextDecoder('ascii').decode(bytes.subarray(0, limit));
  const idx = headText.indexOf(marker);
  if (idx < 0) throw new Error('Not a PLY file (no end_header).');
  let headerEnd = idx + marker.length;
  // consume the newline (\n or \r\n)
  if (headText[headerEnd] === '\r') headerEnd += 1;
  if (headText[headerEnd] === '\n') headerEnd += 1;
  const lines = headText.slice(0, idx).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== 'ply') throw new Error('Not a PLY file (missing magic).');
  let format: Header['format'] | null = null;
  const elements: Element[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'format') {
      const f = parts[1];
      if (f === 'ascii' || f === 'binary_little_endian' || f === 'binary_big_endian') format = f;
      else throw new Error(`Unsupported PLY format: ${f}`);
    } else if (parts[0] === 'element') {
      elements.push({ name: parts[1], count: parseInt(parts[2], 10), properties: [] });
    } else if (parts[0] === 'property') {
      const el = elements[elements.length - 1];
      if (!el) continue;
      if (parts[1] === 'list') {
        el.properties.push({ name: parts[4], type: parts[3] as PlyScalar, list: { countType: parts[2] as PlyScalar, itemType: parts[3] as PlyScalar } });
      } else {
        el.properties.push({ name: parts[2], type: parts[1] as PlyScalar });
      }
    }
  }
  if (!format) throw new Error('PLY header has no format line.');
  return { format, elements, headerLength: headerEnd };
}

const COLOR_NAMES: [string, string, string][] = [
  ['red', 'green', 'blue'],
  ['r', 'g', 'b'],
  ['diffuse_red', 'diffuse_green', 'diffuse_blue'],
  ['f_dc_0', 'f_dc_1', 'f_dc_2'],
];

function colorNormaliser(type: PlyScalar, isSh: boolean): (v: number) => number {
  if (isSh) {
    // 3DGS spherical harmonics DC term -> rgb
    const SH_C0 = 0.28209479177387814;
    return (v) => Math.min(1, Math.max(0, 0.5 + SH_C0 * v));
  }
  if (type === 'uchar' || type === 'uint8') return (v) => v / 255;
  if (type === 'ushort' || type === 'uint16') return (v) => v / 65535;
  return (v) => Math.min(1, Math.max(0, v));
}

export function parsePly(buffer: ArrayBuffer, maxPoints = 2_000_000): PointCloud {
  const header = parsePlyHeader(buffer);
  const vertex = header.elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new Error('PLY has no vertex element.');
  const names = vertex.properties.map((p) => p.name);
  const ix = names.indexOf('x');
  const iy = names.indexOf('y');
  const iz = names.indexOf('z');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PLY vertices have no x/y/z.');
  let colorIdx: [number, number, number] | null = null;
  let isSh = false;
  for (const [r, g, b] of COLOR_NAMES) {
    const a = names.indexOf(r), bb = names.indexOf(g), c = names.indexOf(b);
    if (a >= 0 && bb >= 0 && c >= 0) {
      colorIdx = [a, bb, c];
      isSh = r === 'f_dc_0';
      break;
    }
  }
  const total = vertex.count;
  const stride = total > maxPoints ? Math.ceil(total / maxPoints) : 1;
  const kept = Math.ceil(total / stride);
  const positions = new Float32Array(kept * 3);
  const colors = colorIdx ? new Float32Array(kept * 3) : null;
  const norm = colorIdx ? colorNormaliser(vertex.properties[colorIdx[0]].type, isSh) : null;

  if (header.format === 'ascii') {
    const text = new TextDecoder('ascii').decode(new Uint8Array(buffer, header.headerLength));
    const lines = text.split(/\r?\n/);
    // Skip elements before vertex (rare) — assume vertex is first as in every producer we care about.
    let elementOffset = 0;
    for (const el of header.elements) {
      if (el.name === 'vertex') break;
      elementOffset += el.count;
    }
    let k = 0;
    let lineNo = 0;
    for (let i = elementOffset; i < elementOffset + total && lineNo < lines.length; i += 1) {
      // find next non-empty line
      let line = lines[lineNo++];
      while (line !== undefined && line.trim() === '' && lineNo < lines.length) line = lines[lineNo++];
      if (line === undefined) break;
      if ((i - elementOffset) % stride !== 0) continue;
      const parts = line.trim().split(/\s+/);
      positions[k * 3] = parseFloat(parts[ix]);
      positions[k * 3 + 1] = parseFloat(parts[iy]);
      positions[k * 3 + 2] = parseFloat(parts[iz]);
      if (colors && colorIdx && norm) {
        colors[k * 3] = norm(parseFloat(parts[colorIdx[0]]));
        colors[k * 3 + 1] = norm(parseFloat(parts[colorIdx[1]]));
        colors[k * 3 + 2] = norm(parseFloat(parts[colorIdx[2]]));
      }
      k += 1;
    }
    return { count: k, positions: positions.subarray(0, k * 3), colors: colors ? colors.subarray(0, k * 3) : null };
  }

  const little = header.format === 'binary_little_endian';
  const view = new DataView(buffer);
  let offset = header.headerLength;
  // Skip preceding elements (they must have no list properties for a fixed skip; handle lists too).
  for (const el of header.elements) {
    if (el.name === 'vertex') break;
    for (let i = 0; i < el.count; i += 1) {
      for (const p of el.properties) {
        if (p.list) {
          const n = readScalar(view, offset, p.list.countType, little);
          offset += SIZES[p.list.countType] + n * SIZES[p.list.itemType];
        } else offset += SIZES[p.type];
      }
    }
  }
  const hasList = vertex.properties.some((p) => p.list);
  const offsets: number[] = [];
  let rowSize = 0;
  for (const p of vertex.properties) {
    offsets.push(rowSize);
    rowSize += p.list ? 0 : SIZES[p.type];
  }
  let k = 0;
  for (let i = 0; i < total; i += 1) {
    if (hasList) {
      // generic slow path
      const vals: number[] = [];
      for (const p of vertex.properties) {
        if (p.list) {
          const n = readScalar(view, offset, p.list.countType, little);
          offset += SIZES[p.list.countType] + n * SIZES[p.list.itemType];
          vals.push(NaN);
        } else {
          vals.push(readScalar(view, offset, p.type, little));
          offset += SIZES[p.type];
        }
      }
      if (i % stride === 0) {
        positions[k * 3] = vals[ix];
        positions[k * 3 + 1] = vals[iy];
        positions[k * 3 + 2] = vals[iz];
        if (colors && colorIdx && norm) {
          colors[k * 3] = norm(vals[colorIdx[0]]);
          colors[k * 3 + 1] = norm(vals[colorIdx[1]]);
          colors[k * 3 + 2] = norm(vals[colorIdx[2]]);
        }
        k += 1;
      }
      continue;
    }
    if (offset + rowSize > buffer.byteLength) break;
    if (i % stride === 0) {
      positions[k * 3] = readScalar(view, offset + offsets[ix], vertex.properties[ix].type, little);
      positions[k * 3 + 1] = readScalar(view, offset + offsets[iy], vertex.properties[iy].type, little);
      positions[k * 3 + 2] = readScalar(view, offset + offsets[iz], vertex.properties[iz].type, little);
      if (colors && colorIdx && norm) {
        colors[k * 3] = norm(readScalar(view, offset + offsets[colorIdx[0]], vertex.properties[colorIdx[0]].type, little));
        colors[k * 3 + 1] = norm(readScalar(view, offset + offsets[colorIdx[1]], vertex.properties[colorIdx[1]].type, little));
        colors[k * 3 + 2] = norm(readScalar(view, offset + offsets[colorIdx[2]], vertex.properties[colorIdx[2]].type, little));
      }
      k += 1;
    }
    offset += rowSize;
  }
  return { count: k, positions: positions.subarray(0, k * 3), colors: colors ? colors.subarray(0, k * 3) : null };
}
