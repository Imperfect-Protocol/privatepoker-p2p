export class Address {
  constructor(value) {
    this.value = String(value ?? '').toLowerCase();
  }

  static from(value) {
    return new Address(value);
  }

  equals(other) {
    return this.value === Address.from(other).value;
  }

  toString() {
    return this.value;
  }
}
