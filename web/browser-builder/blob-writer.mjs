// A writeStream-shaped object that Kiln can write into. Accumulates
// string chunks into an array; on finish() builds a single Blob.
// The Blob constructor handles the underlying bytes natively — no
// intermediate string concat, so this scales to GB-sized cabinets
// without OOMing.
export class BlobWriter {
  constructor() {
    this.chunks = [];
    this.bytesWritten = 0;
  }

  write(str) {
    this.chunks.push(str);
    this.bytesWritten += str.length;
    return true;
  }

  finish({ type = 'text/css' } = {}) {
    const blob = new Blob(this.chunks, { type });
    this.chunks = null; // release for GC
    return blob;
  }
}
