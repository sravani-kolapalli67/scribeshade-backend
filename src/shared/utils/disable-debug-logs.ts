// Disable noisy debug logs globally across backend runtime.
// Keeps warn/error intact for operational visibility.
const noop = () => {};

// console.log = noop;
console.debug = noop;
console.info = noop;

