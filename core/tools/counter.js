export function createCounter(start = 0) {
  let count = start;
  const init = start;

  return {
    increment() { return ++count; },
    decrement() { return --count; },
    getCount()  { return count; },
    reset()     { count = init; return count; },
  };
}
