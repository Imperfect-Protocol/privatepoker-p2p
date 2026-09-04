export class Duration {
  constructor(milliseconds) {
    this.milliseconds = Math.max(0, Number(milliseconds ?? 0));
  }

  static fromMilliseconds(milliseconds) {
    return new Duration(milliseconds);
  }

  toMilliseconds() {
    return this.milliseconds;
  }
}
