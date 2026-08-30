// TODO: this doesn't compile yet — `count` and `setCount` aren't defined.
//
// Finish the Counter component below:
// - Use React's useState hook to hold a number, starting at 0.
// - Keep the <p> showing the number, and the Increment/Decrement buttons
//   below exactly as they are — they already do the right thing once
//   `count` and `setCount` exist.

export default function App() {
  return (
    <div>
      <p>{count}</p>
      <button onClick={() => { setCount(count + 1); }}>Increment</button>
      <button onClick={() => { setCount(count - 1); }}>Decrement</button>
    </div>
  );
}
