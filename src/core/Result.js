export class Result {
  constructor(ok, value = null, error = null) {
    this.ok = ok;
    this.value = value;
    this.error = error;
  }

  static ok(value = null) {
    return new Result(true, value, null);
  }

  static err(error) {
    return new Result(false, null, error);
  }
}
