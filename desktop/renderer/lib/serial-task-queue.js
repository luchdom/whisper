export class SerialTaskQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  enqueue(task) {
    if (typeof task !== "function") throw new TypeError("A queued task must be a function.");
    const result = this.tail.then(() => task());
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async whenIdle() {
    await this.tail;
  }
}
