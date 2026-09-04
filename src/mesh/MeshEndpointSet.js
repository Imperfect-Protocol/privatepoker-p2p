export class MeshEndpointSet {
  constructor(urls = []) {
    this.urls = urls.map((url) => String(url ?? '').trim().replace(/\/+$/, '')).filter(Boolean);
    this.index = 0;
  }

  isEmpty() {
    return this.urls.length === 0;
  }

  current() {
    return this.urls[this.index] ?? '';
  }

  rotate() {
    if (this.urls.length < 2) return false;
    this.index = (this.index + 1) % this.urls.length;
    return true;
  }
}
