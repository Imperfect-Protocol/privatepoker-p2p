export class MeshSignalCodec {
  encode(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let hex = '0x';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return hex;
  }

  decode(value) {
    const hex = String(value ?? '').replace(/^0x/i, '');
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
}
